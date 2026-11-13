/**
 * Layout detection.
 *
 * Two shapes are supported, and they differ in where the numbers live:
 *
 *  1. "end" — the damage/heal payload is the last thing on the line (classic-era and retail
 *     format-22 logs). A mid-line stat block, if present, pushes it but does not change its
 *     length, so counting from the end is stable. `wowlog.py` got this wrong by mixing an
 *     end-anchored payload with a start-anchored header.
 *
 *  2. "afterBlock" — the line carries a 19-field unit block (owner, health, power, position,
 *     level) and the payload follows it, with a run of `nil` padding at the end. Counting from
 *     the end lands on the padding, so the payload is located from the end of the block:
 *
 *       header(8) + spell(3) + block(19) + [amount, total, overkill, school, resisted,
 *       blocked, absorbed, nil, nil, nil, ("ST")]
 *
 *     This is what `_forever_` logs do, verified against 64 MB of real logs (Nov 2026). The
 *     amount is at +0 and the school at +3, confirmed by correlating consecutive hits on one
 *     victim with its HP delta: 48-61% exact matches at that offset, ~0% at every other.
 *
 * Nothing is assumed: `calibrate` scores every candidate against sampled damage events and
 * returns null when none fits, reporting the first mismatch for each.
 */
import { at, flags, isGuid, isHexFlags, isZeroGuid, num } from './fields';

export type SuffixMode = 'end' | 'afterBlock';

/** Events carrying the three-field spell prefix (id, name, school) before the payload. */
export const SPELL_PREFIXED = new Set([
  'SPELL_DAMAGE',
  'SPELL_PERIODIC_DAMAGE',
  'SPELL_HEAL',
  'SPELL_PERIODIC_HEAL',
  'SPELL_MISSED',
  'SPELL_CAST_SUCCESS',
  'SPELL_CAST_FAILED',
  'SPELL_INTERRUPT',
  'SPELL_AURA_APPLIED',
  'SPELL_ABSORBED',
  'DAMAGE_SHIELD',
  'RANGE_DAMAGE',
]);

export const DAMAGE_EVENTS = new Set([
  'SPELL_DAMAGE',
  'SPELL_PERIODIC_DAMAGE',
  'SWING_DAMAGE',
  'SWING_DAMAGE_LANDED',
  'RANGE_DAMAGE',
  'DAMAGE_SHIELD',
  'DAMAGE_SPLIT',
  'SPELL_BUILDING_DAMAGE',
  'ENVIRONMENTAL_DAMAGE',
]);

export const HEAL_EVENTS = new Set(['SPELL_HEAL', 'SPELL_PERIODIC_HEAL']);

/** Payload offsets per anchor mode. `len` is only used when anchoring from the end. */
export const TAIL = {
  end: {
    damage: { len: 10, amount: 0, overkill: 1, school: 2, absorbed: 5, critical: 6 },
    heal: { len: 4, amount: 0, overheal: 1 },
  },
  afterBlock: {
    damage: { len: 7, amount: 0, overkill: 2, school: 3, absorbed: 6, critical: 7 },
    heal: { len: 5, amount: 0, overheal: 2 },
  },
} as const;

export interface HeaderIndex {
  srcGuid: number;
  srcName: number;
  srcFlags: number;
  srcRaidFlags: number;
  dstGuid: number;
  dstName: number;
  dstFlags: number;
  dstRaidFlags: number;
  /** first field after the eight unit fields (spell prefix starts here) */
  payload: number;
}

export function headerIndex(infoGuid: boolean): HeaderIndex {
  const o = infoGuid ? 1 : 0;
  return {
    srcGuid: o,
    srcName: o + 1,
    srcFlags: o + 2,
    srcRaidFlags: o + 3,
    dstGuid: o + 4,
    dstName: o + 5,
    dstFlags: o + 6,
    dstRaidFlags: o + 7,
    payload: o + 8,
  };
}

export interface Layout {
  infoGuid: boolean;
  mode: SuffixMode;
  /** afterBlock: fields between the spell prefix and the payload */
  midBlock: number;
  /** end: unexpected fields appended after the known payload */
  trailingExtra: number;
  score: number;
  samples: number;
}

export interface CandidateScore extends Layout {
  reason?: string;
}

/** ENVIRONMENTAL_DAMAGE puts the environmental type before its payload. */
export function payloadShift(event: string): number {
  return event === 'ENVIRONMENTAL_DAMAGE' ? 1 : 0;
}

/** Index of the first payload field for this event under this layout. */
export function payloadStart(event: string, params: string[], layout: Layout): number {
  if (layout.mode === 'afterBlock') {
    const h = headerIndex(layout.infoGuid);
    const spell = SPELL_PREFIXED.has(event) ? 3 : 0;
    return h.payload + spell + layout.midBlock + payloadShift(event);
  }
  return params.length - layout.trailingExtra - TAIL.end.damage.len;
}

export function damageValue(
  event: string,
  params: string[],
  name: 'amount' | 'overkill' | 'school' | 'absorbed' | 'critical',
  layout: Layout,
): string {
  const spec = TAIL[layout.mode].damage;
  const base =
    layout.mode === 'afterBlock'
      ? payloadStart(event, params, layout)
      : params.length - layout.trailingExtra - TAIL.end.damage.len;
  return at(params, base + spec[name]);
}

export function healValue(
  event: string,
  params: string[],
  name: 'amount' | 'overheal',
  layout: Layout,
): string {
  const spec = TAIL[layout.mode].heal;
  const base =
    layout.mode === 'afterBlock'
      ? payloadStart(event, params, layout)
      : params.length - layout.trailingExtra - TAIL.end.heal.len;
  return at(params, base + spec[name]);
}

/**
 * Count the `nil` padding at the end of a payload. The block-anchored shape always ends in a run
 * of them, which is what stops an end-anchored candidate from accidentally scoring on it.
 */
function trailingNilCount(params: string[], max = 4): number {
  let n = 0;
  for (let i = params.length - 1; i >= 0 && n < max; i--) {
    const v = at(params, i);
    if (v === 'nil') {
      n++;
      continue;
    }
    if (n === 0 && i === params.length - 1 && v.length > 0 && v.length <= 4 && num(v) === null) {
      continue; // short trailing tag such as "ST"
    }
    break;
  }
  return n;
}

/** Does this damage event fit the given candidate layout? Returns null when it fits. */
export function damageFits(event: string, params: string[], cand: Layout): string | null {
  const h = headerIndex(cand.infoGuid);
  const srcGuid = at(params, h.srcGuid);
  const srcName = at(params, h.srcName);
  if (!(isGuid(srcGuid) || isZeroGuid(srcGuid))) return 'srcGuid is not a guid';
  if (isGuid(srcName)) return 'srcName is a guid (header shifted by one)';
  if (!isHexFlags(at(params, h.srcFlags))) return 'srcFlags is not a flag set';
  if (!isHexFlags(at(params, h.srcRaidFlags))) return 'srcRaidFlags is not a flag set';
  if (!isHexFlags(at(params, h.dstFlags))) return 'dstFlags is not a flag set';
  if (!isHexFlags(at(params, h.dstRaidFlags))) return 'dstRaidFlags is not a flag set';

  if (cand.mode === 'afterBlock' && trailingNilCount(params) < 2) {
    return 'no nil padding at the end (not a block-anchored payload)';
  }

  const amount = num(damageValue(event, params, 'amount', cand));
  if (amount === null || amount < 0) return 'amount is not a non-negative integer';
  const overkill = num(damageValue(event, params, 'overkill', cand));
  if (overkill === null || overkill < -1) return 'overkill is neither -1 nor a count';
  const school = num(damageValue(event, params, 'school', cand));
  if (school === null || school <= 0 || school > 127) return 'school is not a school bitmask';
  if (cand.mode === 'end' && num(damageValue(event, params, 'absorbed', cand)) === null) {
    return 'absorbed is not a number';
  }
  return null;
}

export const MIN_CALIBRATION_SAMPLES = 5;
export const CONFIDENT_SAMPLES = 20;
export const MIN_CALIBRATION_SCORE = 0.9;
export const MIN_LOW_CONFIDENCE_SCORE = 0.95;

function* candidateLayouts(): Generator<Layout> {
  for (const infoGuid of [true, false]) {
    for (const trailingExtra of [0, 1, 2]) {
      yield { infoGuid, mode: 'end', midBlock: 0, trailingExtra, score: 0, samples: 0 };
    }
    for (const midBlock of [19, 10, 0]) {
      yield { infoGuid, mode: 'afterBlock', midBlock, trailingExtra: 0, score: 0, samples: 0 };
    }
  }
}

export interface CalibrationSample {
  event: string;
  params: string[];
}

export interface Calibration {
  layout: Layout | null;
  candidates: CandidateScore[];
  /** why the best candidate fell short, when layout is null */
  reason?: string;
}

export function calibrate(samples: CalibrationSample[]): Calibration {
  const candidates: CandidateScore[] = [];
  for (const cand of candidateLayouts()) {
    let hits = 0;
    const reasons = new Map<string, number>();
    for (const s of samples) {
      const r = damageFits(s.event, s.params, cand);
      if (r === null) hits++;
      else reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    candidates.push({
      ...cand,
      score: samples.length === 0 ? 0 : hits / samples.length,
      samples: samples.length,
      ...(top ? { reason: top[0] } : {}),
    });
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.midBlock - b.midBlock || a.trailingExtra - b.trailingExtra,
  );
  const best = candidates[0]!;
  // A short log may calibrate on fewer samples, but only on a near-perfect score: five matching
  // events with no outliers is evidence; five with a near-miss is not.
  const threshold = best.samples >= CONFIDENT_SAMPLES ? MIN_CALIBRATION_SCORE : MIN_LOW_CONFIDENCE_SCORE;
  const plausible = best.samples >= MIN_CALIBRATION_SAMPLES && best.score >= threshold;
  if (!plausible) {
    return {
      layout: null,
      candidates,
      reason:
        best.samples < MIN_CALIBRATION_SAMPLES
          ? `only ${best.samples} damage event(s) to calibrate on (need ${MIN_CALIBRATION_SAMPLES})`
          : `best candidate matched ${(best.score * 100).toFixed(0)}% of ${best.samples} damage events (need ${(threshold * 100).toFixed(0)}%); first mismatch: ${best.reason ?? 'unknown'}`,
    };
  }
  return {
    layout: {
      infoGuid: best.infoGuid,
      mode: best.mode,
      midBlock: best.midBlock,
      trailingExtra: best.trailingExtra,
      score: best.score,
      samples: best.samples,
    },
    candidates,
  };
}

/** Re-exported for the decoder's unit-header reads. */
export function unitFlags(params: string[], h: HeaderIndex, side: 'src' | 'dst'): number {
  return flags(at(params, side === 'src' ? h.srcFlags : h.dstFlags));
}

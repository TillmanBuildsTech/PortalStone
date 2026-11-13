/**
 * Layout detection.
 *
 * Why this file exists: the prototype hard-coded param indices, and it got them wrong in a way
 * that produced zero damage instead of an error (header read as if there were no infoGUID, damage
 * suffix read as if there were). Field positions shift between log versions, with and without
 * the infoGUID, and with/without the mid-line stat block. So we do not assume — we calibrate
 * against the first few hundred damage events and refuse to produce numbers when no candidate
 * fits.
 *
 * Two structural facts make this cheap and version-robust:
 *   1. The unit header is anchored at the START. The only variable is whether params[0] is the
 *      infoGUID, which shifts everything by exactly one field.
 *   2. The damage/heal suffix is anchored at the END, and its length is fixed per event type.
 *      A mid-line stat block (10 or 19 fields, depending on build) does not move a suffix that
 *      is counted from the end. This is precisely why the prototype's `spec - 1 - 19` arithmetic
 *      broke and why anchored counts do not.
 */
import { at, flags, isGuid, isHexFlags, isZeroGuid, num } from './fields';

export const DAMAGE_SUFFIX = [
  'amount',
  'overkill',
  'school',
  'resisted',
  'blocked',
  'absorbed',
  'critical',
  'glancing',
  'crushing',
  'isOffHand',
] as const;

export const HEAL_SUFFIX = ['amount', 'overhealing', 'absorbed', 'critical'] as const;

export type DamageSuffixName = (typeof DAMAGE_SUFFIX)[number];
export type HealSuffixName = (typeof HEAL_SUFFIX)[number];

export const DAMAGE_EVENTS = new Set([
  'SPELL_DAMAGE',
  'SPELL_PERIODIC_DAMAGE',
  'SWING_DAMAGE',
  'RANGE_DAMAGE',
  'DAMAGE_SHIELD',
  'DAMAGE_SPLIT',
  'SPELL_BUILDING_DAMAGE',
]);

export const HEAL_EVENTS = new Set(['SPELL_HEAL', 'SPELL_PERIODIC_HEAL']);

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
  /** unexpected fields appended after the known suffix (0 for every format seen so far) */
  trailingExtra: number;
  score: number;
  samples: number;
}

export interface CandidateScore extends Layout {
  reason?: string;
}

function suffixValue(
  params: string[],
  suffixLength: number,
  indexInSuffix: number,
  trailingExtra: number,
): string {
  const end = params.length - 1 - trailingExtra;
  return at(params, end - (suffixLength - 1 - indexInSuffix));
}

export function damageField(
  params: string[],
  name: DamageSuffixName,
  layout: Layout,
): string {
  return suffixValue(params, DAMAGE_SUFFIX.length, DAMAGE_SUFFIX.indexOf(name), layout.trailingExtra);
}

export function healField(params: string[], name: HealSuffixName, layout: Layout): string {
  return suffixValue(params, HEAL_SUFFIX.length, HEAL_SUFFIX.indexOf(name), layout.trailingExtra);
}

const CRIT_VALUES = new Set(['', 'nil', '0', '1', 'true', 'false']);

/** Does this damage event fit the given candidate layout? Returns null when it fits. */
export function damageFits(params: string[], cand: Layout): string | null {
  const h = headerIndex(cand.infoGuid);
  const srcGuid = at(params, h.srcGuid);
  const srcName = at(params, h.srcName);
  if (!(isGuid(srcGuid) || isZeroGuid(srcGuid))) return 'srcGuid is not a guid';
  if (isGuid(srcName)) return 'srcName is a guid (header shifted by one)';
  if (!isHexFlags(at(params, h.srcFlags))) return 'srcFlags is not a flag set';
  if (!isHexFlags(at(params, h.srcRaidFlags))) return 'srcRaidFlags is not a flag set';
  if (!isHexFlags(at(params, h.dstFlags))) return 'dstFlags is not a flag set';
  if (!isHexFlags(at(params, h.dstRaidFlags))) return 'dstRaidFlags is not a flag set';

  const amount = num(damageField(params, 'amount', cand));
  if (amount === null || amount < 0) return 'amount is not a non-negative integer';
  const overkill = num(damageField(params, 'overkill', cand));
  if (overkill === null || overkill < 0) return 'overkill is not a non-negative integer';
  const school = num(damageField(params, 'school', cand));
  if (school === null || school < 0 || school > 127) return 'school is not a school bitmask';
  const crit = damageField(params, 'critical', cand);
  if (!CRIT_VALUES.has(crit)) return 'critical is not a flag';
  return null;
}

export interface CalibrationInput {
  /** already-split param arrays for candidate lines (params exclude the event name) */
  samples: string[][];
}

export interface Calibration {
  layout: Layout | null;
  candidates: CandidateScore[];
  /** why the best candidate fell short, when layout is null */
  reason?: string;
}

export const MIN_CALIBRATION_SAMPLES = 5;
export const CONFIDENT_SAMPLES = 20;
export const MIN_CALIBRATION_SCORE = 0.9;
export const MIN_LOW_CONFIDENCE_SCORE = 0.95;

export function calibrate(samples: string[][]): Calibration {
  const candidates: CandidateScore[] = [];
  for (const infoGuid of [true, false]) {
    for (const trailingExtra of [0, 1, 2]) {
      let hits = 0;
      let reasons = new Map<string, number>();
      for (const p of samples) {
        const r = damageFits(p, { infoGuid, trailingExtra, score: 0, samples: 0 });
        if (r === null) hits++;
        else reasons.set(r, (reasons.get(r) ?? 0) + 1);
      }
      const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      candidates.push({
        infoGuid,
        trailingExtra,
        score: samples.length === 0 ? 0 : hits / samples.length,
        samples: samples.length,
        ...(topReason ? { reason: topReason[0] } : {}),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.trailingExtra - b.trailingExtra);
  const best = candidates[0]!;
  // A short log is allowed to calibrate on fewer samples, but only on a perfect score: five
  // matching events with no outliers is evidence; five with a near-miss is not.
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

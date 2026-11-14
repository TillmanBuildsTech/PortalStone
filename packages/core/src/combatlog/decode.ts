/**
 * Event decoding: one combat-log param array in, one typed event out.
 *
 * Header-shaped events (everything with a source/dest unit block) are read through the
 * calibrated header index. Suffix-shaped numbers are read from the END of the field list so a
 * mid-line stat block cannot shift them. Prefix-shaped payload fields (miss type, cast failure
 * reason) are read from just after the unit header, where they have always lived.
 */
import { at, flags, isGuid, isZeroGuid, num, unquote } from './fields';
import {
  DAMAGE_EVENTS,
  HEAL_EVENTS,
  blockStart,
  damageValue,
  healValue,
  headerIndex,
  payloadStart,
  type Layout,
} from './layout';
import type { Pos } from '../camps';

/** "Unroll Bag": the only event that names a sleeping bag, who dropped it and where. */
export const BAG_SPELL = 429961;
/** Buffs a bag hands out to everyone in range. Always applied source == destination. */
export const CAMP_SPELLS = new Set([429959, 1229741, 1229451]);

export type LogEvent =
  | { t: 'version'; advanced: boolean | null; build: string; projectId: number | null }
  | { t: 'zone'; ms: number; zoneId: number | null; zoneName: string }
  | {
      t: 'encounterStart';
      ms: number;
      bossId: number;
      bossName: string;
      difficulty: number;
      size: number;
    }
  | { t: 'encounterEnd'; ms: number; bossId: number; bossName: string; success: boolean }
  | {
      t: 'damage';
      ms: number;
      srcGuid: string;
      srcName: string;
      srcFlags: number;
      dstGuid: string;
      dstName: string;
      dstFlags: number;
      spellId: number;
      spellName: string;
      amount: number;
      absorbed: number;
      isCrit: boolean;
      /** Forever logs emit the same swing twice: a roll and a landed event. */
      swing?: 'roll' | 'landed';
      pos?: Pos;
    }
  | {
      t: 'heal';
      ms: number;
      srcGuid: string;
      srcFlags: number;
      dstGuid: string;
      dstFlags: number;
      spellName: string;
      /** effective healing as reported by the log */
      amount: number;
      overheal: number;
    }
  | {
      t: 'miss';
      ms: number;
      srcGuid: string;
      srcFlags: number;
      spellName: string;
      missType: string;
    }
  | {
      t: 'cast';
      ms: number;
      srcGuid: string;
      srcName: string;
      srcFlags: number;
      spellId: number;
      spellName: string;
      pos?: Pos;
    }
  | { t: 'castFailed'; ms: number; srcFlags: number; spellName: string; reason: string }
  | { t: 'interrupt'; ms: number; srcFlags: number; spellName: string; interrupted: string }
  | {
      /** a camp buff landing on a player: the only trace a sleeping bag leaves on someone */
      t: 'campBuff';
      ms: number;
      guid: string;
      name: string;
      spellId: number;
      spellName: string;
    }
  | { t: 'died'; ms: number; guid: string; name: string; flags: number }
  | {
      t: 'kill';
      ms: number;
      srcGuid: string;
      srcFlags: number;
      dstGuid: string;
      dstName: string;
    }
  | { t: 'unknown'; ms: number; event: string };

const MISS_EVENTS = new Set(['SPELL_MISSED', 'SWING_MISSED', 'RANGE_MISSED', 'SPELL_PERIODIC_MISSED']);

/**
 * Events we decode nothing from but must not report as unrecognised: auras, cast starts, map
 * changes and the like make up more than half the lines in a leveling log, and counting them as
 * "unknown" would hide a real format change in the noise.
 */
const IGNORED_EVENTS = new Set([
  'SPELL_AURA_APPLIED',
  'SPELL_AURA_APPLIED_DOSE',
  'SPELL_AURA_REMOVED',
  'SPELL_AURA_REMOVED_DOSE',
  'SPELL_AURA_REFRESH',
  'SPELL_AURA_BROKEN',
  'SPELL_CAST_START',
  'SPELL_CREATE',
  'SPELL_SUMMON',
  'SPELL_ENERGIZE',
  'SPELL_PERIODIC_ENERGIZE',
  'SPELL_DISPEL',
  'SPELL_DISPEL_FAILED',
  'SPELL_STOLEN',
  'DAMAGE_SHIELD_MISSED',
  'SPELL_ABSORBED',
  'SPELL_MISSED_DAMAGE',
  'SPELL_AURA_BROKEN_SPELL',
  'SPELL_EXTRA_ATTACKS',
  'SPELL_DRAIN',
  'SPELL_RESURRECT',
  'SPELL_INSTAKILL',
  'MAP_CHANGE',
  'ZONE_CHANGE_START',
  'ENCHANT_APPLIED',
  'ENCHANT_REMOVED',
  'PARTY_MEMBER_DIED',
]);

export interface DecodeResult {
  event: LogEvent | null;
  /** true when the event was recognised but deliberately skipped (support events, etc.) */
  skipped?: boolean;
}

/**
 * ENCOUNTER_* and ZONE_CHANGE do not use the unit header. Their first field is either the
 * encounter/zone id (plain) or an infoGUID that must be dropped. Detect by shape, not by build.
 */
function nonUnitOffset(params: string[]): number {
  const first = at(params, 0);
  if (num(first) !== null && !isZeroGuid(first)) return 0;
  if (isZeroGuid(first) || isGuid(first)) return 1;
  return 0;
}

/**
 * Where this unit stood, from the stat block that damage and cast events carry.
 *
 * Returns undefined rather than a guess when the layout has no locatable block: a wrong position
 * would silently produce a wrong "who shared the camp" distance.
 */
function positionOf(event: string, params: string[], layout: Layout): Pos | undefined {
  const start = blockStart(event, layout);
  if (start === null) return undefined;
  const x = num(at(params, start + 14));
  const y = num(at(params, start + 15));
  const map = at(params, start + 16);
  if (x === null || y === null || !map || !map.trim().length) return undefined;
  return { x, y, map };
}

export function decode(event: string, params: string[], ms: number, layout: Layout): DecodeResult {
  if (event === 'COMBAT_LOG_VERSION') {
    // The first field is the format version number, so key/value pairing starts after it and is
    // not reliably aligned: look the keys up instead of stepping two at a time.
    let advanced: boolean | null = null;
    let build = '';
    let projectId: number | null = null;
    const valueOf = (key: string): string | null => {
      const i = params.indexOf(key);
      return i >= 0 ? (params[i + 1] ?? null) : null;
    };
    const adv = valueOf('ADVANCED_LOG_ENABLED');
    if (adv !== null) advanced = adv === '1';
    build = valueOf('BUILD_VERSION') ?? '';
    const proj = valueOf('PROJECT_ID');
    projectId = proj === null ? null : num(proj);
    return { event: { t: 'version', advanced, build, projectId } };
  }

  if (event === 'ZONE_CHANGE') {
    const o = nonUnitOffset(params);
    const idRaw = at(params, o);
    const id = num(idRaw);
    const name = unquote(at(params, o + 1));
    return {
      event: { t: 'zone', ms, zoneId: id, zoneName: name || (id === null ? idRaw : '') },
    };
  }

  if (event === 'ENCOUNTER_START') {
    const o = nonUnitOffset(params);
    return {
      event: {
        t: 'encounterStart',
        ms,
        bossId: num(at(params, o)) ?? 0,
        bossName: unquote(at(params, o + 1)),
        difficulty: num(at(params, o + 2)) ?? 0,
        size: num(at(params, o + 3)) ?? 0,
      },
    };
  }

  if (event === 'ENCOUNTER_END') {
    const o = nonUnitOffset(params);
    return {
      event: {
        t: 'encounterEnd',
        ms,
        bossId: num(at(params, o)) ?? 0,
        bossName: unquote(at(params, o + 1)),
        success: (num(at(params, o + 4)) ?? 0) === 1,
      },
    };
  }

  if (event === 'UNIT_DIED' || event === 'UNIT_DESTROYED') {
    const h = headerIndex(layout.infoGuid);
    // The victim sits in the SOURCE unit block for these events; dest is empty.
    const srcGuid = at(params, h.srcGuid);
    const useSrc = !isZeroGuid(srcGuid);
    const guid = useSrc ? srcGuid : at(params, h.dstGuid);
    const name = unquote(useSrc ? at(params, h.srcName) : at(params, h.dstName));
    const f = flags(useSrc ? at(params, h.srcFlags) : at(params, h.dstFlags));
    return { event: { t: 'died', ms, guid, name, flags: f } };
  }

  if (event === 'PARTY_KILL') {
    const h = headerIndex(layout.infoGuid);
    return {
      event: {
        t: 'kill',
        ms,
        srcGuid: at(params, h.srcGuid),
        srcFlags: flags(at(params, h.srcFlags)),
        dstGuid: at(params, h.dstGuid),
        dstName: unquote(at(params, h.dstName)),
      },
    };
  }

  if (event.endsWith('_SUPPORT')) return { event: null, skipped: true };

  // Camp buffs are the only thing a sleeping bag leaves on a player, so they are decoded before
  // the generic aura bail-out.
  if (event === 'SPELL_AURA_APPLIED' || event === 'SPELL_AURA_APPLIED_DOSE') {
    const h = headerIndex(layout.infoGuid);
    const spellId = num(at(params, h.payload)) ?? 0;
    if (CAMP_SPELLS.has(spellId)) {
      return {
        event: {
          t: 'campBuff',
          ms,
          guid: at(params, h.dstGuid),
          name: unquote(at(params, h.dstName)),
          spellId,
          spellName: unquote(at(params, h.payload + 1)) || 'unknown',
        },
      };
    }
    return { event: null, skipped: true };
  }

  if (IGNORED_EVENTS.has(event)) return { event: null, skipped: true };

  if (DAMAGE_EVENTS.has(event)) {
    const h = headerIndex(layout.infoGuid);
    const amount = num(damageValue(event, params, 'amount', layout)) ?? 0;
    const absorbed = num(damageValue(event, params, 'absorbed', layout)) ?? 0;
    const isSwing = event.startsWith('SWING_');
    const isEnv = event === 'ENVIRONMENTAL_DAMAGE';
    const spellId = isSwing || isEnv ? 0 : (num(at(params, h.payload)) ?? 0);
    const spellName = isSwing
      ? 'Melee'
      : isEnv
        ? unquote(at(params, payloadStart(event, params, layout))) || 'Environment'
        : unquote(at(params, h.payload + 1)) || 'unknown';
    return {
      event: {
        t: 'damage',
        ms,
        srcGuid: at(params, h.srcGuid),
        srcName: unquote(at(params, h.srcName)),
        srcFlags: flags(at(params, h.srcFlags)),
        dstGuid: at(params, h.dstGuid),
        dstName: unquote(at(params, h.dstName)),
        dstFlags: flags(at(params, h.dstFlags)),
        spellId,
        spellName,
        amount,
        absorbed,
        isCrit: (() => {
          const c = damageValue(event, params, 'critical', layout);
          return c === '1' || c === 'true';
        })(),
        ...(event === 'SWING_DAMAGE' ? { swing: 'roll' as const } : {}),
        ...(event === 'SWING_DAMAGE_LANDED' ? { swing: 'landed' as const } : {}),
        pos: positionOf(event, params, layout),
      },
    };
  }

  if (HEAL_EVENTS.has(event)) {
    const h = headerIndex(layout.infoGuid);
    return {
      event: {
        t: 'heal',
        ms,
        srcGuid: at(params, h.srcGuid),
        srcFlags: flags(at(params, h.srcFlags)),
        dstGuid: at(params, h.dstGuid),
        dstFlags: flags(at(params, h.dstFlags)),
        spellName: unquote(at(params, h.payload + 1)) || 'unknown',
        amount: num(healValue(event, params, 'amount', layout)) ?? 0,
        overheal: num(healValue(event, params, 'overheal', layout)) ?? 0,
      },
    };
  }

  if (MISS_EVENTS.has(event)) {
    const h = headerIndex(layout.infoGuid);
    const isSwing = event === 'SWING_MISSED';
    return {
      event: {
        t: 'miss',
        ms,
        srcGuid: at(params, h.srcGuid),
        srcFlags: flags(at(params, h.srcFlags)),
        spellName: isSwing ? 'Melee' : unquote(at(params, h.payload + 1)) || 'unknown',
        missType: unquote(at(params, h.payload + (isSwing ? 0 : 3))) || 'unknown',
      },
    };
  }

  if (event === 'SPELL_CAST_SUCCESS') {
    const h = headerIndex(layout.infoGuid);
    return {
      event: {
        t: 'cast',
        ms,
        srcGuid: at(params, h.srcGuid),
        srcName: unquote(at(params, h.srcName)),
        srcFlags: flags(at(params, h.srcFlags)),
        spellId: num(at(params, h.payload)) ?? 0,
        spellName: unquote(at(params, h.payload + 1)) || 'unknown',
        pos: positionOf(event, params, layout),
      },
    };
  }

  if (event === 'SPELL_CAST_FAILED') {
    const h = headerIndex(layout.infoGuid);
    return {
      event: {
        t: 'castFailed',
        ms,
        srcFlags: flags(at(params, h.srcFlags)),
        spellName: unquote(at(params, h.payload + 1)) || 'unknown',
        reason: unquote(at(params, h.payload + 3)) || 'unknown',
      },
    };
  }

  if (event === 'SPELL_INTERRUPT') {
    const h = headerIndex(layout.infoGuid);
    return {
      event: {
        t: 'interrupt',
        ms,
        srcFlags: flags(at(params, h.srcFlags)),
        spellName: unquote(at(params, h.payload + 1)) || 'unknown',
        interrupted: unquote(at(params, h.payload + 4)) || 'unknown',
      },
    };
  }

  return { event: { t: 'unknown', ms, event } };
}

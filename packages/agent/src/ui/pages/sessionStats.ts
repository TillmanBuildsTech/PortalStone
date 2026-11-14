/**
 * One shape for "what was this thing about".
 *
 * A session row, a zone segment and an encounter all carry the same five numbers with different
 * column names and defaults; every page asks the same question of them, so they get one adapter and
 * the throughput rule (engage time first, active time next, wall clock last) is applied once.
 */
import { throughput, type Throughput } from '../../../../core/src/throughput';
import { num } from '../format';

export interface ThroughputSource {
  damage_done: number;
  healing_done: number;
  engaged_s: number;
  duration_s: number;
  /** sessions carry it; zone visits do not */
  active_s?: number;
}

/** Rate per hour of wall clock — the number a farmer means by "kills per hour". */
export function perHour(count: number, durationS: number): number {
  const hours = durationS / 3600;
  return hours > 0 ? Math.round(count / hours) : 0;
}

/**
 * A rate, or a dash when the basis is zero.
 *
 * Zero combat time with kills recorded means the kills were someone else's and you were not
 * fighting — printing "0 per hour" there would read as a measured rate rather than an absent one.
 */
export function perHourLabel(count: number, basisS: number): string {
  return basisS > 0 ? num(perHour(count, basisS)) : '—';
}

export function throughputFrom(row: ThroughputSource): Throughput {
  return throughput({
    damage: row.damage_done,
    healing: row.healing_done,
    engagedS: row.engaged_s,
    activeS: row.active_s ?? row.engaged_s,
    durationS: row.duration_s,
  });
}

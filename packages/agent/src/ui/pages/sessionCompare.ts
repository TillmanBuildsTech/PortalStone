/**
 * How a session stacked up against your own history.
 *
 * The run page already does this for one zone visit ("against your other runs here"); this is the
 * same idea one level up, for the whole session — the page you actually open after playing. The
 * comparison is the part only this app can offer, because it has every session you have ever logged.
 *
 * Two bases, because a session is not one kind of thing. A Scarlet Monastery night compares best
 * against your other Scarlet Monastery nights; but early on there are none, so it falls back to all
 * your sessions on this character and says which basis it used. The reader can switch with `?basis=`.
 *
 * Pure and testable: it takes session rows and returns numbers, no HTML. `renderSessionCompare`
 * (in session.ts) turns the result into the section.
 */
import type { SessionRow } from '../../store';
import { throughputFrom, perHour } from './sessionStats';

export type Basis = 'zone' | 'all';

/** Below this many comparable same-zone sessions, the zone basis is too thin to be the default. */
export const MIN_ZONE = 3;

export interface MetricCompare {
  key: string;
  label: string;
  /** this session's value */
  value: number;
  /** median of the other sessions in the basis */
  median: number;
  /** the other sessions' best (max when higher is better, min when lower is better) */
  best: number;
  /** fraction of the other sessions this one beats, or null when nothing to rank against */
  percentile: number | null;
  unit: string;
  higherIsBetter: boolean;
  /** one value per other session (plus this one appended last), for the dot plot */
  dots: { value: number; title?: string }[];
}

export interface SessionCompare {
  /** the basis actually used after fallback */
  basis: Basis;
  /** comparable sessions (excluding this one) available in each basis, for the toggle and disclosure */
  zoneCount: number;
  allCount: number;
  zoneName: string | null;
  characterName: string | null;
  /** the primary rate kind, so the caller labels dps vs hps correctly */
  kind: 'damage' | 'healing';
  rateUnit: 'dps' | 'hps';
  /** index of this session within a metric's `dots` array (always the last element) */
  currentIndex: number;
  metrics: MetricCompare[];
}

interface MetricDef {
  key: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  /** the session's value, or null when the metric does not apply (no basis for the rate) */
  of: (row: SessionRow, kind: 'damage' | 'healing') => number | null;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)]!;
}

const METRICS: MetricDef[] = [
  {
    key: 'rate',
    label: 'per second in combat',
    unit: '', // filled with dps/hps by the caller-facing label
    higherIsBetter: true,
    of: (row, kind) => {
      const t = throughputFrom(row);
      // Only comparable when it led with the same kind and actually fought: a healing night and a
      // damage night are not one measurement, and a zero-combat session has no rate to rank.
      if (t.kind !== kind || t.rate <= 0 || t.total <= 0) return null;
      return t.rate;
    },
  },
  {
    key: 'killsPerHour',
    label: 'field kills / hour',
    unit: '/hr',
    higherIsBetter: true,
    of: (row) => (row.duration_s > 0 ? perHour(row.field_kills, row.duration_s) : null),
  },
  {
    key: 'dtps',
    label: 'damage taken / second',
    unit: 'dtps',
    higherIsBetter: false, // taking less is doing better
    of: (row) => {
      const t = throughputFrom(row);
      return t.basisS > 0 ? Math.round(row.damage_taken / t.basisS) : null;
    },
  },
];

/**
 * Build the comparison for `current` against `history` (every session on this character, this one
 * included or not — it is excluded by id here). `want` is the basis the reader asked for, if any.
 */
export function sessionCompare(
  current: SessionRow,
  history: SessionRow[],
  want: Basis | null = null,
): SessionCompare | null {
  const t = throughputFrom(current);
  const kind = t.kind;

  const others = history.filter((r) => r.id !== current.id);
  const zonePool = current.zone_name ? others.filter((r) => r.zone_name === current.zone_name) : [];

  // How many of each pool can be ranked on the primary rate — that is what "enough history" means,
  // not the raw session count, because a pool of sessions with no comparable combat tells us nothing.
  const rate = METRICS[0]!;
  const zoneCount = zonePool.filter((r) => rate.of(r, kind) !== null).length;
  const allCount = others.filter((r) => rate.of(r, kind) !== null).length;

  // Nothing to compare against in either basis: the caller shows a short "first of its kind" note.
  if (allCount === 0) return null;

  // Default to the zone when it has enough history; honour an explicit, non-empty request.
  let basis: Basis = zoneCount >= MIN_ZONE ? 'zone' : 'all';
  if (want === 'zone' && zoneCount > 0) basis = 'zone';
  if (want === 'all') basis = 'all';

  const pool = basis === 'zone' ? zonePool : others;

  const metrics = METRICS.map<MetricCompare | null>((m) => {
    const value = m.of(current, kind);
    if (value === null) return null;
    const otherVals = pool
      .map((r) => m.of(r, kind))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (otherVals.length === 0) return null;

    const sorted = [...otherVals].sort((a, b) => a - b);
    const best = m.higherIsBetter ? sorted[sorted.length - 1]! : sorted[0]!;
    const beats = otherVals.filter((v) => (m.higherIsBetter ? value > v : value < v)).length;
    const percentile = otherVals.length ? beats / otherVals.length : null;

    return {
      key: m.key,
      label: m.label,
      value,
      median: median(sorted),
      best,
      percentile,
      unit: m.unit,
      higherIsBetter: m.higherIsBetter,
      dots: [...otherVals.map((v) => ({ value: v })), { value }],
    };
  }).filter((m): m is MetricCompare => m !== null);

  if (metrics.length === 0) return null;

  // The dot for this session is always appended last; every metric shares the index.
  const currentIndex = metrics[0]!.dots.length - 1;

  return {
    basis,
    zoneCount,
    allCount,
    zoneName: current.zone_name,
    characterName: current.character_name,
    kind,
    rateUnit: kind === 'healing' ? 'hps' : 'dps',
    currentIndex,
    metrics,
  };
}

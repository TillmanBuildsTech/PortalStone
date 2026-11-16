/**
 * The data side of dashboards: what a card can show, and the numbers behind it.
 *
 * A dashboard card is a (metric, view, range) triple. This module is the contract between them:
 * every metric declares its unit and its shape —
 *
 *   time   a series measured at a moment     (a session, a SavedVariables flush)
 *   split  a total broken into categories   (zones, bag droppers)
 *
 * Shape decides which views are honest. A line over categories would invent an ordering, so `line`
 * only applies to time metrics and `pie` only to splits. Everything else works for both.
 *
 * A card's range is a window in minutes, applied by the metric's reader. 0 means all time. The
 * window is relative to now, not to the newest point: "last 24 hours" that quietly shows last week
 * is worse than an honest empty state.
 *
 * No HTML lives here: pages render, this computes.
 */
import type { SessionRow, Store, TrackedMetricRow, ZoneAggregateRow } from '../store';
import { compact, dateLabel, num, quantity, quantityAxis, when } from './format';

export type MetricShape = 'time' | 'split';
export type CardView = 'stat' | 'bar' | 'pie' | 'line' | 'table';
export type CardSpan = 1 | 2;
export type Unit = 'damage' | 'healing' | 'count' | 'seconds' | 'copper' | 'plain';

export interface CardPoint {
  label: string;
  value: number;
  /** present only on time metrics: where the point sits on the clock */
  ts?: number;
  /** 'damage', 'healing' or a zone kind, which paints bars in the app's own colours */
  kind?: string;
  href?: string;
  title?: string;
}

export interface MetricDef {
  id: string;
  label: string;
  group: 'combat' | 'places' | 'bags' | 'tracked';
  shape: MetricShape;
  unit: Unit;
  /** what a stat card leads with: the last reading, or the sum of the categories */
  stat: 'total' | 'latest';
  description: string;
  /**
   * The points in the window. `character` scopes the metric to one character; a metric that adds
   * sessions up has to honour it or a card silently mixes an alt's numbers with a main's.
   */
  points(store: Store, sinceMs: number | null, character?: string | null): CardPoint[];
}

export const GROUPS: { id: MetricDef['group']; label: string }[] = [
  { id: 'combat', label: 'combat — per session over time' },
  { id: 'places', label: 'places — per zone' },
  { id: 'bags', label: 'bags — drop counts' },
  { id: 'tracked', label: 'tracked values — from addons' },
];

export const VIEWS: { id: CardView; label: string; hint: string }[] = [
  { id: 'stat', label: 'static value', hint: 'one number' },
  { id: 'bar', label: 'bar chart', hint: 'one column per point' },
  { id: 'pie', label: 'pie chart', hint: 'share of the whole' },
  { id: 'line', label: 'line chart', hint: 'over time' },
  { id: 'table', label: 'table', hint: 'the exact rows' },
];

/** The size a card starts at, in gridstack's 12-column grid. Resizing is a drag away. */
export const DEFAULT_SIZE: Record<CardView, { w: number; h: number }> = {
  stat: { w: 4, h: 2 },
  bar: { w: 6, h: 3 },
  pie: { w: 6, h: 3 },
  line: { w: 12, h: 3 },
  table: { w: 6, h: 4 },
};

export type CardTier = 'xs' | 'sm' | 'md' | 'lg';

/**
 * How much room a card has, in the four buckets the layout cares about. Width decides whether
 * labels and the legend fit beside a chart; height decides how many rows a table can show.
 */
export function cardTier(w: number, h: number): CardTier {
  if (w <= 3 || h <= 2) return 'xs';
  if (w <= 5) return 'sm';
  if (w <= 8 || h <= 3) return 'md';
  return 'lg';
}

export interface RangeOption {
  minutes: number;
  label: string;
  short: string;
}

/** Preset windows, in the units a player thinks in: minutes, hours, days. 0 is all time. */
export const RANGES: RangeOption[] = [
  { minutes: 0, label: 'all time', short: 'all time' },
  { minutes: 15, label: 'last 15 minutes', short: '15m' },
  { minutes: 60, label: 'last hour', short: '1h' },
  { minutes: 360, label: 'last 6 hours', short: '6h' },
  { minutes: 1440, label: 'last 24 hours', short: '24h' },
  { minutes: 10080, label: 'last 7 days', short: '7d' },
  { minutes: 43200, label: 'last 30 days', short: '30d' },
];

export function isRange(minutes: number): boolean {
  return RANGES.some((r) => r.minutes === minutes);
}

export function rangeLabel(minutes: number, short = false): string {
  const preset = RANGES.find((r) => r.minutes === minutes);
  if (preset) return short ? preset.short : preset.label;
  if (minutes <= 0) return 'all time';
  if (minutes % 1440 === 0) return `last ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `last ${minutes / 60} hours`;
  return `last ${minutes} minutes`;
}

/** The window start for a card, or null for all time. `now` is injectable for tests. */
export function rangeStart(minutes: number, now = Date.now()): number | null {
  return minutes > 0 ? now - minutes * 60_000 : null;
}

export function isCardView(s: string): s is CardView {
  return VIEWS.some((v) => v.id === s);
}

/** The views that mean something for a shape. `bar` and `table` mean something for both. */
export function viewsFor(shape: MetricShape): CardView[] {
  return shape === 'time' ? ['stat', 'line', 'bar', 'table'] : ['stat', 'bar', 'pie', 'table'];
}

export function viewFits(shape: MetricShape, view: CardView): boolean {
  return viewsFor(shape).includes(view);
}

export function defaultView(shape: MetricShape): CardView {
  return shape === 'time' ? 'line' : 'bar';
}

/** Readable unit formatting: copper is money, seconds are durations, everything else is a count. */
export function formatUnit(value: number, unit: Unit): string {
  if (unit === 'copper') return quantity(value, 'copper');
  if (unit === 'seconds') return quantity(value, 'seconds');
  return num(value);
}

export function formatUnitAxis(value: number, unit: Unit): string {
  if (unit === 'copper') return quantityAxis(value, 'copper');
  if (unit === 'seconds') return quantityAxis(value, 'seconds');
  return compact(value);
}

/** The colour a chart uses for a unit, matching the colours elsewhere in the app. */
export function colorForUnit(unit: Unit): string {
  if (unit === 'damage') return '#6ea8fe';
  if (unit === 'healing') return '#56d364';
  if (unit === 'copper') return '#ffd166';
  if (unit === 'seconds') return '#bc8cff';
  return '#6ea8fe';
}

/** A session label that still reads on a crowded axis; the full clock lives in the tooltip. */
function sessionPoints(
  store: Store,
  sinceMs: number | null,
  pick: (s: SessionRow) => number,
  character: string | null = null,
): CardPoint[] {
  const sessions = store
    .listSessions(2000, character)
    .filter((s) => sinceMs === null || s.start_ms >= sinceMs);
  // Oldest first: a trend reads left to right. A cap keeps an "all time" card from drawing
  // thousands of one-pixel bars.
  const capped = sessions.length > 300 ? sessions.slice(0, 300) : sessions;
  return capped
    .slice()
    .reverse()
    .map((s) => ({
      label: dateLabel(s.start_ms, s.offset_min),
      value: pick(s),
      ts: s.start_ms,
      href: `/session?id=${s.id}`,
      title: `${when(s.start_ms, s.offset_min)} · ${s.zone_name ?? 'unknown zone'}`,
    }));
}

function zonePoints(
  store: Store,
  sinceMs: number | null,
  pick: (z: ZoneAggregateRow) => number,
  character: string | null = null,
): CardPoint[] {
  return store.zoneAggregates(sinceMs, character).map((z) => ({
    label: z.zone_name,
    value: pick(z),
    kind: z.kind,
    title: `${z.zone_name} · ${z.runs} run${z.runs === 1 ? '' : 's'}`,
  }));
}

const COMBAT: MetricDef[] = [
  {
    id: 'session_damage',
    label: 'damage per session',
    group: 'combat',
    shape: 'time',
    unit: 'damage',
    stat: 'latest',
    description: 'Damage you dealt, totalled for each session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.damage_done, char),
  },
  {
    id: 'session_healing',
    label: 'healing per session',
    group: 'combat',
    shape: 'time',
    unit: 'healing',
    stat: 'latest',
    description: 'Healing you did, totalled for each session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.healing_done, char),
  },
  {
    id: 'session_damage_taken',
    label: 'damage taken per session',
    group: 'combat',
    shape: 'time',
    unit: 'damage',
    stat: 'latest',
    description: 'Damage you took, totalled for each session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.damage_taken, char),
  },
  {
    id: 'session_kills',
    label: 'kills per session',
    group: 'combat',
    shape: 'time',
    unit: 'count',
    stat: 'latest',
    description: 'Killing blows you landed, per session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.kills, char),
  },
  {
    id: 'session_deaths',
    label: 'your deaths per session',
    group: 'combat',
    shape: 'time',
    unit: 'count',
    stat: 'latest',
    description: 'Times you died, per session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.my_deaths, char),
  },
  {
    id: 'session_casts',
    label: 'casts per session',
    group: 'combat',
    shape: 'time',
    unit: 'count',
    stat: 'latest',
    description: 'Spells you cast, per session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.casts, char),
  },
  {
    id: 'session_time',
    label: 'time played per session',
    group: 'combat',
    shape: 'time',
    unit: 'seconds',
    stat: 'latest',
    description: 'Wall-clock length of each session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.duration_s, char),
  },
  {
    id: 'session_combat_time',
    label: 'time in combat per session',
    group: 'combat',
    shape: 'time',
    unit: 'seconds',
    stat: 'latest',
    description: 'Time actually spent engaged, per session in the window.',
    points: (store, since, char) => sessionPoints(store, since, (s) => s.engaged_s, char),
  },
];

const PLACES: MetricDef[] = [
  {
    id: 'zone_damage',
    label: 'damage by zone',
    group: 'places',
    shape: 'split',
    unit: 'damage',
    stat: 'total',
    description: 'Every zone you dealt damage in during the window, largest first.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.damage_done, char),
  },
  {
    id: 'zone_healing',
    label: 'healing by zone',
    group: 'places',
    shape: 'split',
    unit: 'healing',
    stat: 'total',
    description: 'Every zone you healed in during the window, largest first.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.healing_done, char),
  },
  {
    id: 'zone_time',
    label: 'time spent by zone',
    group: 'places',
    shape: 'split',
    unit: 'seconds',
    stat: 'total',
    description: 'Wall-clock time in each zone visit, added up over the window.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.duration_s, char),
  },
  {
    id: 'zone_kills',
    label: 'kills by zone',
    group: 'places',
    shape: 'split',
    unit: 'count',
    stat: 'total',
    description: 'Killing blows you landed, grouped by zone, over the window.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.kills, char),
  },
  {
    id: 'zone_deaths',
    label: 'your deaths by zone',
    group: 'places',
    shape: 'split',
    unit: 'count',
    stat: 'total',
    description: 'Where you died during the window, grouped by zone.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.my_deaths, char),
  },
  {
    id: 'zone_runs',
    label: 'visits by zone',
    group: 'places',
    shape: 'split',
    unit: 'count',
    stat: 'total',
    description: 'How many times you visited each zone in the window.',
    points: (store, since, char) => zonePoints(store, since, (z) => z.runs, char),
  },
];

const BAGS: MetricDef[] = [
  {
    id: 'bags_zone',
    label: 'bag drops by zone',
    group: 'bags',
    shape: 'split',
    unit: 'count',
    stat: 'total',
    description: 'Where sleeping bags were unrolled during the window.',
    points: (store, since) =>
      store.bagDropStats(since).zones.map((z) => ({
        label: z.zone_name,
        value: z.count,
        title: `${z.zone_name} · ${z.count} drop${z.count === 1 ? '' : 's'}`,
      })),
  },
  {
    id: 'bags_player',
    label: 'bag drops by player',
    group: 'bags',
    shape: 'split',
    unit: 'count',
    stat: 'total',
    description: 'Who unrolled bags during the window. The log names the caster, not who benefited.',
    points: (store, since) =>
      store.bagDropStats(since).droppers.map((p) => ({
        label: p.mine ? `${p.name} (you)` : p.name,
        value: p.count,
        title: `${p.name} · ${p.count} drop${p.count === 1 ? '' : 's'}`,
      })),
  },
];

/**
 * Tracked addon properties become metrics on the fly, because the user can add, rename and remove
 * them at any time. Only numeric series are chartable; sets (equipment, attunements) are members
 * diffed at each flush and belong on the tracked page.
 */
function trackedMetrics(store: Store): MetricDef[] {
  return store
    .trackedMetrics()
    .filter((m) => m.kind === 'number')
    .map((m: TrackedMetricRow): MetricDef => ({
      id: `tracked:${m.id}`,
      label: m.label,
      group: 'tracked',
      shape: 'time',
      unit: (m.unit === 'copper' || m.unit === 'seconds' ? m.unit : 'plain') as Unit,
      stat: 'latest',
      description: `Sampled from ${m.addon_file} at every SavedVariables flush.`,
      points: (s, since) => trackedPoints(s, m, since),
    }));
}

function trackedPoints(store: Store, metric: TrackedMetricRow, sinceMs: number | null): CardPoint[] {
  const unit: Unit = metric.unit === 'copper' || metric.unit === 'seconds' ? metric.unit : 'plain';
  return store
    .samples(metric.id, 2000)
    .filter((sample) => sinceMs === null || sample.ts_ms >= sinceMs)
    .map((sample) => ({
      label: dateLabel(sample.ts_ms),
      value: sample.value,
      ts: sample.ts_ms,
      title: `${when(sample.ts_ms)} · ${formatUnit(sample.value, unit)}`,
    }));
}

export function metricCatalog(store: Store): MetricDef[] {
  return [...COMBAT, ...PLACES, ...BAGS, ...trackedMetrics(store)];
}

export function findMetric(store: Store, id: string): MetricDef | undefined {
  return metricCatalog(store).find((m) => m.id === id);
}

export interface CardData {
  metric: MetricDef;
  /** the window the points were read with, in minutes (0 = all time) */
  rangeMinutes: number;
  /** chronological for time metrics, largest first for splits */
  points: CardPoint[];
  total: number;
  /** time metrics: the last reading, and the one before it */
  latest: number | null;
  previous: number | null;
}

export function cardData(
  store: Store,
  metric: MetricDef,
  rangeMinutes = 0,
  now = Date.now(),
  character: string | null = null,
): CardData {
  const since = rangeStart(rangeMinutes, now);
  const points = metric.points(store, since, character).filter((p) => Number.isFinite(p.value));
  const total = points.reduce((sum, p) => sum + p.value, 0);

  if (metric.shape === 'split') {
    return {
      metric,
      rangeMinutes,
      points: [...points].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
      total,
      latest: null,
      previous: null,
    };
  }

  const ordered = [...points].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return {
    metric,
    rangeMinutes,
    points: ordered,
    total,
    latest: ordered.length ? ordered[ordered.length - 1]!.value : null,
    previous: ordered.length > 1 ? ordered[ordered.length - 2]!.value : null,
  };
}

/**
 * The example dashboard, so an empty install has something to look at before it has opinions.
 * It only uses metrics every database has; tracked values are added when one exists.
 */
export function createExampleDashboard(store: Store): number {
  const id = store.createDashboard('Overview');
  store.addDashboardCard({
    dashboardId: id,
    metric: 'session_damage',
    view: 'line',
    title: 'damage per session',
    w: 12,
    h: 3,
  });
  store.addDashboardCard({ dashboardId: id, metric: 'zone_time', view: 'pie', title: 'where the time went', w: 6, h: 3 });
  store.addDashboardCard({ dashboardId: id, metric: 'session_kills', view: 'bar', title: 'kills per session', w: 6, h: 3 });
  const tracked = store.trackedMetrics().filter((m) => m.kind === 'number')[0];
  if (tracked) {
    store.addDashboardCard({
      dashboardId: id,
      metric: `tracked:${tracked.id}`,
      view: 'stat',
      title: tracked.label,
      w: 4,
      h: 2,
      rangeMinutes: 10080,
    });
  } else {
    store.addDashboardCard({ dashboardId: id, metric: 'zone_damage', view: 'bar', title: 'damage by zone', w: 6, h: 3 });
  }
  return id;
}

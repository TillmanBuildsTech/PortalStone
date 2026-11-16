/**
 * Sampling: turn a tracked property into a time series.
 *
 * SavedVariables only change when the game flushes them (logout, /reload, exit), and the file's
 * mtime *is* that moment. So a sample is keyed by the flush, not by the scan: rescanning every
 * minute while playing cannot invent data points, and the series stays one row per real change.
 *
 * Nothing here knows what gold is. It reads the property the user picked, sums every instance of
 * it (one per character, for `forever[*].money`), and stores the numbers.
 */
import { isTable } from '../../core/src/savedvars/lua';
import { collectEntries, collectValues, hasEntity, pinEntity } from '../../core/src/savedvars/shape';
import { listAddons, readAddon, type AddonFile } from './addons';
import type { InstallInfo } from './discover';
import type { Store, TrackedMetricRow, TrackedSampleRow } from './store';

export interface SampleResult {
  metric: TrackedMetricRow;
  /** how many instances the property had this flush (characters, rows) */
  instances: number;
  value: number | null;
  recorded: boolean;
  /** why nothing was recorded, when nothing was */
  reason?: string;
}

export function sampleTracked(store: Store, installs: InstallInfo[]): SampleResult[] {
  const metrics = store.trackedMetrics();
  if (metrics.length === 0) return [];
  const files = listAddons(installs);
  return metrics.map((metric) => sampleMetric(store, metric, files));
}

function sampleMetric(store: Store, metric: TrackedMetricRow, files: AddonFile[]): SampleResult {
  const segments = parsePath(metric.path);
  const candidates = files.filter((f) => f.file === metric.addon_file);
  if (candidates.length === 0) {
    return { metric, instances: 0, value: null, recorded: false, reason: `${metric.addon_file} is not installed any more` };
  }
  // Several accounts can each have the same addon file. Follow the one that flushed last rather
  // than averaging two characters' wallets into one meaningless number.
  const file = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const read = readAddon(file);
  if (read.state !== 'ok') {
    return { metric, instances: 0, value: null, recorded: false, reason: `${metric.addon_file} is ${read.state}` };
  }

  const global = read.globals.find((g) => g.name === metric.global_name);
  if (!global) {
    return { metric, instances: 0, value: null, recorded: false, reason: `global ${metric.global_name} is gone` };
  }

  // Stored paths include the global name; older ones may not.
  const stored = segments[0] === metric.global_name ? segments.slice(1) : segments;
  if (!isTable(global.value)) {
    return { metric, instances: 0, value: null, recorded: false, reason: `${metric.global_name} is not a table` };
  }
  // Pinned to one entity: read that one, not the sum of them all. The instance count becomes 1,
  // which is what lets a page say "this character's level" without hedging.
  if (metric.entity && !hasEntity(global.value, stored, metric.entity)) {
    return {
      metric,
      instances: 0,
      value: null,
      recorded: false,
      reason: `"${metric.entity}" is not in this flush (renamed, deleted, or another account)`,
    };
  }
  const rel = metric.entity ? pinEntity(stored, metric.entity) : stored;
  if (metric.kind === 'set') return sampleSet(store, metric, file, global.value, rel);

  const values = collectValues(global.value, rel)
    .map(toNumber)
    .filter((v): v is number => v !== null);
  if (values.length === 0) {
    return {
      metric,
      instances: 0,
      value: null,
      recorded: false,
      reason: 'the property is not in this flush (the addon has not written it yet)',
    };
  }

  const value = values.reduce((a, b) => a + b, 0);
  const recorded = store.recordSample({
    metricId: metric.id,
    // The flush time, not the scan time: the game decides when the data was observed.
    tsMs: file.mtimeMs,
    value,
    instances: values.length,
    minValue: Math.min(...values),
    maxValue: Math.max(...values),
    sourceFile: file.path,
    sourceMtimeMs: file.mtimeMs,
  });
  return { metric, instances: values.length, value, recorded, ...(recorded ? {} : { reason: 'already stored for this flush' }) };
}

/**
 * Addons are inconsistent: Attune writes `level = "31"` as a string, BagBrother writes it as a
 * number. A plain integer or decimal string is coerced, because the alternative is a property that
 * looks trackable on the browser and then silently never samples. Anything else stays non-numeric.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parsePath(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface Member {
  k: string;
  v: string;
}

/** Sets are stored as members with the key that produced them: an inventory slot, a toon name. */
function sampleSet(
  store: Store,
  metric: TrackedMetricRow,
  file: AddonFile,
  value: LuaTableLike,
  rel: string[],
): SampleResult {
  const members = collectEntries(value, rel)
    .map((e) => ({ k: e.key, v: scalarText(e.value) }))
    .filter((e): e is Member => e.v !== null)
    .sort((a, b) => a.k.localeCompare(b.k, 'en', { numeric: true }));
  if (members.length === 0) {
    return {
      metric,
      instances: 0,
      value: null,
      recorded: false,
      reason: 'the property is empty in this flush',
    };
  }
  const recorded = store.recordSample({
    metricId: metric.id,
    tsMs: file.mtimeMs,
    // For a set the number is its size: a flat line means nothing was added or removed.
    value: members.length,
    instances: members.length,
    minValue: null,
    maxValue: null,
    members,
    sourceFile: file.path,
    sourceMtimeMs: file.mtimeMs,
  });
  return {
    metric,
    instances: members.length,
    value: members.length,
    recorded,
    ...(recorded ? {} : { reason: 'already stored for this flush' }),
  };
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

export function parseMembers(json: string | null | undefined): Member[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is Member => !!m && typeof (m as Member).k === 'string' && typeof (m as Member).v === 'string')
      .map((m) => ({ k: m.k, v: m.v }));
  } catch {
    return [];
  }
}

export interface SetDiff {
  added: Member[];
  removed: Member[];
  changed: { k: string; from: string; to: string }[];
  unchanged: number;
}

/** What happened to a set between two flushes, per key. */
export function diffMembers(before: Member[], after: Member[]): SetDiff {
  const b = new Map(before.map((m) => [m.k, m.v]));
  const a = new Map(after.map((m) => [m.k, m.v]));
  const added: Member[] = [];
  const removed: Member[] = [];
  const changed: { k: string; from: string; to: string }[] = [];
  let unchanged = 0;
  for (const [k, v] of a) {
    if (!b.has(k)) added.push({ k, v });
    else if (b.get(k) === v) unchanged++;
    else changed.push({ k, from: b.get(k)!, to: v });
  }
  for (const [k, v] of b) if (!a.has(k)) removed.push({ k, v });
  return { added, removed, changed, unchanged };
}

/** Minimal structural type, so this module does not depend on the Lua parser's internals. */
type LuaTableLike = Parameters<typeof collectEntries>[0];

export interface SessionDetail {
  id: number;
  start_ms: number;
  end_ms: number | null;
}

export interface SessionChange {
  metric: TrackedMetricRow;
  /** last sample at or before the session began */
  before: TrackedSampleRow | null;
  /** first sample at or after the session ended */
  after: TrackedSampleRow | null;
  /** after - before, or null when the session is not bracketed by two flushes */
  change: number | null;
  /**
   * How many sessions fall between the two flushes used. More than one means the change belongs
   * to all of them, so it is shown but never presented as this session's alone.
   */
  shared: number;
  /** for set metrics (equipment): what was added, removed or swapped across the session */
  setChange?: SetDiff | null;
}

/**
 * What each tracked value did across a session.
 *
 * SavedVariables are balance snapshots, not transactions, so the only defensible attribution is a
 * bracket: the last flush before the session started and the first flush after it ended. When no
 * such pair exists — the session is still open, or the addon has not written since tracking began —
 * the answer is "unknown", never zero. When the pair spans more than one session, the delta is
 * reported with the count so the page can say it is shared.
 */
export function changesAcrossSessions(
  metrics: TrackedMetricRow[],
  samplesByMetric: Map<number, TrackedSampleRow[]>,
  sessions: SessionDetail[],
): Map<number, SessionChange[]> {
  const out = new Map<number, SessionChange[]>();
  for (const session of sessions) {
    const end = session.end_ms ?? Number.MAX_SAFE_INTEGER;
    const changes: SessionChange[] = [];
    for (const metric of metrics) {
      const samples = samplesByMetric.get(metric.id) ?? [];
      const before = [...samples].reverse().find((s) => s.ts_ms <= session.start_ms) ?? null;
      const after = samples.find((s) => s.ts_ms >= end) ?? null;
      let change: number | null = null;
      let shared = 0;
      if (before && after && metric.kind !== 'set') {
        change = after.value - before.value;
        shared = sessions.filter(
          (o) => o.start_ms < after.ts_ms && (o.end_ms ?? Number.MAX_SAFE_INTEGER) > before.ts_ms,
        ).length;
      }
      const setChange =
        metric.kind === 'set' && before && after
          ? diffMembers(parseMembers(before.members), parseMembers(after.members))
          : null;
      changes.push({ metric, before, after, change, shared, setChange });
    }
    out.set(session.id, changes);
  }
  return out;
}

/**
 * Flushes that happened after a session ended and before the next one began.
 *
 * The bracket above stops at the first flush after the session, which in the normal case is the
 * logout flush. But a player keeps playing after the last combat event — banking, spending gold,
 * turning in quests — and none of that writes to the combat log. No session is created for it, so
 * those later flushes belong to no session at all. They are still real observations, so the session
 * page shows them as "after this session", explicitly outside the bracket rather than folded into
 * it: the alternative would be silence, and the user would read the session's unchanged level as
 * wrong.
 *
 * `nextStartMs` bounds the search so a change made before the next session is not attributed to
 * this one after the next one has already begun.
 */
export function changesAfterSession(
  metrics: TrackedMetricRow[],
  samplesByMetric: Map<number, TrackedSampleRow[]>,
  session: SessionDetail,
  nextStartMs: number | null,
): SessionChange[] {
  if (session.end_ms === null) return [];
  const end = session.end_ms;
  const out: SessionChange[] = [];
  for (const metric of metrics) {
    const samples = samplesByMetric.get(metric.id) ?? [];
    // The bracket's "after" flush: the first observation once the session was over.
    const before = samples.find((s) => s.ts_ms >= end) ?? null;
    if (!before) continue;
    const later = samples.filter(
      (s) => s.ts_ms > before.ts_ms && (nextStartMs === null || s.ts_ms < nextStartMs),
    );
    const after = later[later.length - 1] ?? null;
    if (!after) continue;
    if (metric.kind === 'set') {
      out.push({
        metric,
        before,
        after,
        change: null,
        shared: 0,
        setChange: diffMembers(parseMembers(before.members), parseMembers(after.members)),
      });
    } else {
      out.push({ metric, before, after, change: after.value - before.value, shared: 0 });
    }
  }
  return out;
}

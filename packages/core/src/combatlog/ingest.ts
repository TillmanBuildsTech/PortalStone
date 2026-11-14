/**
 * Streaming ingest: read → calibrate → decode → aggregate, with a byte offset so a tailing
 * agent reads only what was appended since last time.
 *
 * The calibration window is the whole point: we buffer the first few thousand lines (about 1 MB),
 * prove a layout against the damage events in them, and only then commit to numbers. If nothing
 * fits, the ingest fails with a named reason and a diagnostic table — it does not return zeroes.
 */
import { createReadStream } from 'node:fs';
import { Aggregator, type BagSnapshot, type SessionResult } from './aggregate';
import { decode } from './decode';
import { splitFields } from './fields';
import {
  CONFIDENT_SAMPLES,
  DAMAGE_EVENTS,
  calibrate,
  type Calibration,
  type CalibrationSample,
  type Layout,
} from './layout';
import { parseTimestamp, splitTimestamp, yearFromFilename } from './timestamp';
import { zoneKind } from '../zones';
import type { BagDrop } from '../bags';

export interface IngestOptions {
  path: string;
  startOffset?: number;
  /**
   * A previously calibrated layout. The agent stores this per log file, so resuming a tail of
   * twenty new lines does not need to re-calibrate from a window it cannot fill.
   */
  layout?: Layout;
  /** guids belonging to the player, for logs whose affiliation flags lie */
  selfGuids?: string[];
  /**
   * Zone in effect at startOffset. Resuming mid-file skips the ZONE_CHANGE that set it, and a
   * session whose first segment has no zone is useless, so the caller supplies the last known one.
   */
  startZone?: { id: number | null; name: string };
  sessionGapMs?: number;
  encounterGapMs?: number;
  /** stop after this many bytes (0 = whole file) */
  maxBytes?: number;
  /** lines to scan while searching for a layout before giving up */
  maxCalibrationLines?: number;
  /** damage events needed before attempting calibration */
  calibrationSamples?: number;
  /** year to assume when the log carries none and the filename is non-standard */
  fallbackYear?: number;
  onProgress?: (p: { bytes: number; lines: number }) => void;
}

export interface SessionSnapshot {
  startMs: number;
  endMs: number;
  /** byte offset where this session began (the safe resume point for a growing log) */
  startByte: number;
  offsetMin: number;
  zoneId: number | null;
  zoneName: string;
  /**
   * Every zone entry in the session, with its own stats. These are the "runs": one row per
   * dungeon, raid, battleground or zone visit, so a five-hour evening is not one undifferentiated
   * blob.
   */
  zones: (BagSnapshot & {
    zoneId: number | null;
    name: string;
    kind: string;
    startMs: number;
    endMs: number;
  })[];
  open: BagSnapshot;
  encounters: (BagSnapshot & {
    bossId: number;
    bossName: string;
    difficulty: number;
    size: number;
    success: boolean | null;
    startMs: number;
    endMs: number;
  })[];
}

export interface IngestOk {
  ok: true;
  path: string;
  layout: Layout;
  infoGuid: boolean;
  trailingExtra: number;
  advanced: boolean | null;
  build: string;
  projectId: number | null;
  selfGuid: string | null;
  selfName: string | null;
  offsetMin: number | null;
  firstMs: number;
  lastMs: number;
  bytes: number;
  lines: number;
  unparsed: number;
  skipped: number;
  unrecognised: number;
  endOffset: number;
  partialTail: boolean;
  elapsedMs: number;
  sessions: SessionSnapshot[];
  /** sleeping bags: every "Unroll Bag" cast, newest last */
  bagDrops: BagDrop[];
  warnings: string[];
}

export interface IngestFail {
  ok: false;
  path: string;
  reason: string;
  detail: string;
  candidates: Calibration['candidates'];
  lines: number;
  unparsed: number;
  bytes: number;
  endOffset: number;
  elapsedMs: number;
  warnings: string[];
}

export type IngestResult = IngestOk | IngestFail;

interface RawLine {
  line: string;
  ms: number;
  offsetMin: number;
  event: string;
  params: string[];
  byteStart: number;
}

const DEFAULTS = {
  maxCalibrationLines: 5000,
  calibrationSamples: 200,
};

function stripCr(b: Buffer): Buffer {
  return b.length > 0 && b[b.length - 1] === 13 ? b.subarray(0, b.length - 1) : b;
}

export async function* readLogLines(
  path: string,
  startOffset: number,
  maxBytes: number,
  chunkSize = 8 << 20,
): AsyncGenerator<{ line: string; byteLength: number; complete: boolean }> {
  const opts: { start: number } & { end?: number } = { start: startOffset };
  if (maxBytes > 0) opts.end = startOffset + maxBytes - 1;
  const stream = createReadStream(path, { ...opts, highWaterMark: chunkSize });
  let carry: Buffer | null = null;
  for await (const chunk of stream) {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let from = 0;
    let idx = buf.indexOf(10, from);
    while (idx !== -1) {
      const raw = stripCr(buf.subarray(from, idx));
      yield { line: raw.toString('utf8'), byteLength: idx - from + 1, complete: true };
      from = idx + 1;
      idx = buf.indexOf(10, from);
    }
    carry = from < buf.length ? buf.subarray(from) : null;
  }
  if (carry && carry.length > 0) {
    yield { line: stripCr(carry).toString('utf8'), byteLength: carry.length, complete: false };
  }
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const path = opts.path;
  const startOffset = opts.startOffset ?? 0;
  const maxBytes = opts.maxBytes ?? 0;
  const maxCalibrationLines = opts.maxCalibrationLines ?? DEFAULTS.maxCalibrationLines;
  const calibrationSamples = opts.calibrationSamples ?? DEFAULTS.calibrationSamples;
  const fallbackYear = yearFromFilename(path) ?? opts.fallbackYear ?? new Date().getUTCFullYear();

  const warnings: string[] = [];
  const agg = new Aggregator({
    ...(opts.sessionGapMs !== undefined ? { sessionGapMs: opts.sessionGapMs } : {}),
    ...(opts.encounterGapMs !== undefined ? { encounterGapMs: opts.encounterGapMs } : {}),
    ...(opts.selfGuids !== undefined ? { selfGuids: opts.selfGuids } : {}),
    ...(opts.startZone !== undefined ? { startZone: opts.startZone } : {}),
  });

  let layout: Layout | null = opts.layout ?? null;
  let calibration: Calibration | null = null;
  let bytes = 0;
  let lines = 0;
  let unparsed = 0;
  let skipped = 0;
  let endOffset = startOffset;
  let partialTail = false;

  const buffered: RawLine[] = [];
  const samples: CalibrationSample[] = [];

  const tryCalibrate = (): Calibration => {
    const c = calibrate(samples);
    calibration = c;
    return c;
  };

  const flushBuffer = (): void => {
    if (!layout) return;
    for (const r of buffered) {
      const res = decode(r.event, r.params, r.ms, layout);
      if (!res.event) skipped++;
      else if (res.event.t === 'unknown') agg.unrecognised++;
      else agg.push(res.event, r.offsetMin, r.byteStart);
    }
    buffered.length = 0;
  };

  for await (const l of readLogLines(path, startOffset, maxBytes)) {
    if (!l.complete) {
      partialTail = true;
      break;
    }
    bytes += l.byteLength;
    lines++;
    const split = splitTimestamp(l.line);
    if (!split) {
      unparsed++;
      continue;
    }
    const stamp = parseTimestamp(split.ts, fallbackYear);
    if (!stamp) {
      unparsed++;
      continue;
    }
    const fields = splitFields(split.body);
    const event = fields[0] ?? '';
    if (!event || fields.length < 2) {
      unparsed++;
      continue;
    }
    const params = fields.slice(1);
    const byteStart = endOffset;
    const raw: RawLine = {
      line: l.line,
      ms: stamp.ms,
      offsetMin: stamp.offsetMin,
      event,
      params,
      byteStart,
    };
    endOffset += l.byteLength;

    if (!layout) {
      buffered.push(raw);
      if (DAMAGE_EVENTS.has(event)) samples.push({ event, params });
      const windowFull = buffered.length >= maxCalibrationLines;
      const enoughSamples = samples.length >= calibrationSamples;
      if (windowFull || enoughSamples) {
        const c = tryCalibrate();
        if (c.layout) {
          layout = c.layout;
          flushBuffer();
        } else if (windowFull) {
          return {
            ok: false,
            path,
            reason: 'layout_unknown',
            detail: c.reason ?? 'no candidate layout fitted the sampled damage events',
            candidates: c.candidates,
            lines,
            unparsed,
            bytes,
            endOffset,
            elapsedMs: Date.now() - t0,
            warnings,
          };
        }
      }
      continue;
    }

    const res = decode(event, params, stamp.ms, layout);
    if (!res.event) skipped++;
    else if (res.event.t === 'unknown') agg.unrecognised++;
    else agg.push(res.event, stamp.offsetMin, byteStart);
    if (opts.onProgress && lines % 200_000 === 0) opts.onProgress({ bytes, lines });
  }

  if (!layout) {
    if (samples.length === 0) {
      return {
        ok: false,
        path,
        reason: 'no_damage_events',
        detail:
          'no damage events found in the readable portion of this log, so the field layout cannot be verified',
        candidates: [],
        lines,
        unparsed,
        bytes,
        endOffset,
        elapsedMs: Date.now() - t0,
        warnings,
      };
    }
    const c = tryCalibrate();
    if (!c.layout) {
      return {
        ok: false,
        path,
        reason: 'layout_unknown',
        detail: c.reason ?? 'no candidate layout fitted the sampled damage events',
        candidates: c.candidates,
        lines,
        unparsed,
        bytes,
        endOffset,
        elapsedMs: Date.now() - t0,
        warnings,
      };
    }
    layout = c.layout;
    flushBuffer();
  }

  const finalLayout = layout;
  agg.finish();
  if (finalLayout.samples < CONFIDENT_SAMPLES) {
    warnings.push(
      `layout calibrated on only ${finalLayout.samples} damage events; treat these numbers as provisional`,
    );
  }

  if (agg.selfGuid === null) {
    warnings.push(
      'no player-affiliated unit found: this does not look like your own log, or the affiliation flags are missing',
    );
  }
  if (agg.advanced === false) {
    warnings.push('advanced logging is off in this log: no stat/position block, some metrics unavailable');
  }
  if (unparsed > 0 && unparsed / Math.max(lines, 1) > 0.01) {
    warnings.push(`${unparsed} of ${lines} lines did not parse (${((100 * unparsed) / lines).toFixed(1)}%)`);
  }

  return {
    ok: true,
    path,
    layout: finalLayout,
    infoGuid: finalLayout.infoGuid,
    trailingExtra: finalLayout.trailingExtra,
    advanced: agg.advanced,
    build: agg.build,
    projectId: agg.projectId,
    selfGuid: agg.selfGuid,
    selfName: agg.selfName,
    offsetMin: agg.offsetMin,
    firstMs: agg.firstMs,
    lastMs: agg.lastMs,
    bytes,
    lines,
    unparsed,
    skipped,
    unrecognised: agg.unrecognised,
    endOffset,
    partialTail,
    elapsedMs: Date.now() - t0,
    sessions: agg.sessions.map(snapshotSession),
    bagDrops: agg.bagDrops.finish(),
    warnings,
  };
}

function snapshotSession(s: SessionResult): SessionSnapshot {
  return {
    startMs: s.startMs,
    endMs: s.endMs,
    startByte: s.startByte,
    offsetMin: s.offsetMin,
    zoneId: s.zoneId,
    zoneName: s.zoneName,
    zones: s.zones.map((z) => ({
      zoneId: z.zoneId,
      name: z.name,
      kind: zoneKind(z.name),
      startMs: z.startMs,
      endMs: z.endMs,
      ...z.bag.snapshot(),
    })),
    open: s.open.snapshot(),
    encounters: s.encounters.map((e) => ({
      ...e.bag.snapshot(),
      bossId: e.bossId,
      bossName: e.bossName,
      difficulty: e.difficulty,
      size: e.size,
      success: e.success,
      startMs: e.bag.firstMs,
      endMs: e.bag.lastMs,
    })),
  };
}

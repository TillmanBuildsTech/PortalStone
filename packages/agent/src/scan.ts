/**
 * Incremental scan: read only what the log has appended since the last pass.
 *
 * The resume point is the byte offset where the *last* session began, not the end of the file.
 * A play session is still open while you are playing, so its rows have to be rewritten on every
 * pass; re-reading that one session costs a few hundred milliseconds and keeps the numbers exact
 * instead of leaving a half-session on screen.
 */
import { ingest } from '../../core/src/combatlog/ingest';
import type { Layout } from '../../core/src/combatlog/layout';
import type { InstallInfo } from './discover';
import type { Store } from './store';

export interface ScanEntry {
  path: string;
  flavor: string;
  action: 'skipped' | 'ingested' | 'error';
  sessions?: number;
  ms?: number;
  error?: string;
}

export async function scan(
  store: Store,
  installs: InstallInfo[],
  log: (msg: string) => void = () => {},
  opts: { force?: boolean } = {},
): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = [];
  for (const install of installs) {
    for (const flavor of install.flavors) {
      for (const file of flavor.logs) {
        // --rebuild ignores stored progress: re-derive everything from the raw logs, which is what
        // you want after a parser change that an unchanged file would otherwise never pick up.
        const state = opts.force ? undefined : store.logState(file.path);
        if (state && state.bytes === file.bytes && state.mtime_ms === file.mtimeMs) {
          entries.push({ path: file.path, flavor: flavor.name, action: 'skipped' });
          continue;
        }
        const rotated = !!state && state.offset > file.bytes;
        let offset = rotated ? 0 : (state?.offset ?? 0);
        let layout: Layout | undefined;
        if (state?.layout && !rotated) {
          try {
            layout = JSON.parse(state.layout) as Layout;
          } catch {
            layout = undefined;
          }
        }

        // A resumed read starts *after* the ZONE_CHANGE that set the zone, so the re-read session
        // would begin with no zone at all ("unknown"). Seed it from the session being re-read; if
        // that is unknown too, re-read the file from the top once and recover it properly.
        let startZone: { id: number | null; name: string } | undefined;
        if (offset > 0) {
          const zone = store.lastSessionZone(file.path);
          if (zone && zone.name && zone.name !== 'unknown') startZone = zone;
          else offset = 0;
        }

        const started = Date.now();
        const res = await ingest({
          path: file.path,
          startOffset: offset,
          ...(layout ? { layout } : {}),
          ...(startZone ? { startZone } : {}),
        });
        const elapsed = Date.now() - started;

        if (!res.ok) {
          // Keep whatever was stored before and retry only when the file changes.
          store.saveLogProgress({
            path: file.path,
            flavor: flavor.name,
            bytes: file.bytes,
            mtimeMs: file.mtimeMs,
            offset,
            layout: state?.layout ?? null,
            lines: 0,
            unparsed: 0,
            unknownLines: 0,
            build: null,
            advanced: null,
            characterGuid: null,
            characterName: null,
            lastError: `${res.reason}: ${res.detail}`,
            scannedMs: Date.now(),
          });
          log(`  ! ${file.path}: ${res.reason} (${res.detail})`);
          entries.push({ path: file.path, flavor: flavor.name, action: 'error', error: res.reason, ms: elapsed });
          continue;
        }

        const character = { guid: res.selfGuid, name: res.selfName };
        if (res.sessions.length > 0) {
          // Rewrite from the first session we just read; with offset 0 that is the whole file.
          const fromMs = offset === 0 ? 0 : res.sessions[0]!.startMs;
          store.replaceSessionsFrom(file.path, fromMs, res.sessions, character);
        } else if (offset === 0) {
          // a rotated file with no combat in it: drop anything stored for this path
          store.replaceSessionsFrom(file.path, 0, [], character);
        }
        // Bag drops are rebuilt per file: a drop only means anything next to the log it came from.
        store.replaceBagDrops(file.path, res.bagDrops);

        const last = res.sessions[res.sessions.length - 1];
        const nextOffset = last ? last.startByte : res.endOffset;
        store.saveLogProgress({
          path: file.path,
          flavor: flavor.name,
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
          offset: nextOffset,
          layout: JSON.stringify(res.layout),
          lines: res.lines,
          unparsed: res.unparsed,
          unknownLines: res.unrecognised,
          build: res.build || state?.build || null,
          advanced: res.advanced === null ? (state?.advanced ?? null) : res.advanced ? 1 : 0,
          characterGuid: res.selfGuid,
          characterName: res.selfName,
          lastError: null,
          scannedMs: Date.now(),
        });

        log(
          `  + ${file.path}: ${res.lines.toLocaleString()} lines in ${elapsed} ms, ` +
            `${res.sessions.length} session(s), offset -> ${nextOffset.toLocaleString()}`,
        );
        entries.push({
          path: file.path,
          flavor: flavor.name,
          action: 'ingested',
          sessions: res.sessions.length,
          ms: elapsed,
        });
      }
    }
  }
  return entries;
}

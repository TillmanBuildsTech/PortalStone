/**
 * SQLite store. Node 24 ships `node:sqlite`, so the agent has no native dependencies.
 *
 * The one rule that matters: sessions are replaced, never half-written. When a scan re-reads the
 * tail of a growing log, everything from the first re-read session onwards is deleted and
 * reinserted in a transaction, so a crash mid-scan leaves the previous state intact.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';
import type { BagDrop } from '../../core/src/bags';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS log_file (
  path TEXT PRIMARY KEY,
  flavor TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  layout TEXT,
  lines INTEGER NOT NULL DEFAULT 0,
  unparsed INTEGER NOT NULL DEFAULT 0,
  unknown_lines INTEGER NOT NULL DEFAULT 0,
  build TEXT,
  advanced INTEGER,
  character_guid TEXT,
  character_name TEXT,
  last_error TEXT,
  scanned_ms INTEGER
);

CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_path TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  offset_min INTEGER NOT NULL DEFAULT 0,
  zone_id INTEGER,
  zone_name TEXT,
  duration_s REAL NOT NULL DEFAULT 0,
  active_s REAL NOT NULL DEFAULT 0,
  engaged_s REAL NOT NULL DEFAULT 0,
  damage_done INTEGER NOT NULL DEFAULT 0,
  damage_taken INTEGER NOT NULL DEFAULT 0,
  healing_done INTEGER NOT NULL DEFAULT 0,
  overheal INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  my_deaths INTEGER NOT NULL DEFAULT 0,
  players_died INTEGER NOT NULL DEFAULT 0,
  casts INTEGER NOT NULL DEFAULT 0,
  interrupts INTEGER NOT NULL DEFAULT 0,
  zones TEXT,
  character_guid TEXT,
  character_name TEXT,
  ingested_ms INTEGER NOT NULL,
  UNIQUE (log_path, start_ms)
);

CREATE TABLE IF NOT EXISTS encounter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  boss_id INTEGER,
  boss_name TEXT,
  difficulty INTEGER,
  size INTEGER,
  success INTEGER,
  duration_s REAL NOT NULL DEFAULT 0,
  damage_done INTEGER NOT NULL DEFAULT 0,
  damage_taken INTEGER NOT NULL DEFAULT 0,
  healing_done INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  dps REAL NOT NULL DEFAULT 0,
  UNIQUE (session_id, start_ms)
);

CREATE TABLE IF NOT EXISTS zone_segment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  zone_id INTEGER,
  zone_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'zone',
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_s REAL NOT NULL DEFAULT 0,
  engaged_s REAL NOT NULL DEFAULT 0,
  damage_done INTEGER NOT NULL DEFAULT 0,
  damage_taken INTEGER NOT NULL DEFAULT 0,
  healing_done INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  my_deaths INTEGER NOT NULL DEFAULT 0,
  field_deaths INTEGER NOT NULL DEFAULT 0,
  players_died INTEGER NOT NULL DEFAULT 0,
  casts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bag_drop (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_path TEXT NOT NULL DEFAULT '',
  ts_ms INTEGER NOT NULL,
  guid TEXT,
  name TEXT,
  mine INTEGER NOT NULL DEFAULT 0,
  zone_name TEXT NOT NULL DEFAULT '',
  map_id TEXT NOT NULL DEFAULT '',
  x REAL,
  y REAL
);

CREATE INDEX IF NOT EXISTS idx_bag_drop_ts ON bag_drop (ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_bag_drop_log ON bag_drop (log_path, ts_ms);

CREATE TABLE IF NOT EXISTS session_ability (
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  spell_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_start ON session (start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_segment_session ON zone_segment (session_id);
CREATE INDEX IF NOT EXISTS idx_segment_start ON zone_segment (start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ability_session ON session_ability (session_id);
`;

export interface LogState {
  path: string;
  bytes: number;
  mtime_ms: number;
  offset: number;
  layout: string | null;
  build: string | null;
  advanced: number | null;
  last_error: string | null;
}

export interface BagDropRow {
  id: number;
  log_path: string;
  ts_ms: number;
  guid: string | null;
  name: string | null;
  mine: number;
  zone_name: string;
  map_id: string;
  x: number | null;
  y: number | null;
}

export interface BagDropStats {
  total: number;
  mine: number;
  droppers: { name: string; count: number; mine: number }[];
  zones: { zone_name: string; count: number }[];
}

export interface SegmentRow {
  id: number;
  session_id: number;
  zone_id: number | null;
  zone_name: string;
  kind: string;
  start_ms: number;
  end_ms: number;
  duration_s: number;
  engaged_s: number;
  damage_done: number;
  damage_taken: number;
  healing_done: number;
  kills: number;
  my_deaths: number;
  field_deaths: number;
  players_died: number;
  casts: number;
}

export interface SessionRow {
  id: number;
  start_ms: number;
  end_ms: number | null;
  offset_min: number;
  zone_name: string | null;
  duration_s: number;
  active_s: number;
  engaged_s: number;
  damage_done: number;
  damage_taken: number;
  healing_done: number;
  overheal: number;
  kills: number;
  deaths: number;
  my_deaths: number;
  players_died: number;
  casts: number;
  interrupts: number;
  character_name: string | null;
  zones: string | null;
  encounters: number;
  zones_count: number;
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Migrations for databases created by earlier builds. Cheap and safe: add missing columns.
    const cols = this.db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'zones')) this.db.exec('ALTER TABLE session ADD COLUMN zones TEXT');
    if (!cols.some((c) => c.name === 'players_died')) {
      this.db.exec('ALTER TABLE session ADD COLUMN players_died INTEGER NOT NULL DEFAULT 0');
    }
    // The camp model (bags plus inferred attendance) is gone: distances were guesses dressed as
    // data. Bag drops are hard events, and nothing in these tables was source data.
    this.db.exec('DROP TABLE IF EXISTS camp_attendee');
    this.db.exec('DROP TABLE IF EXISTS camp_bag');
    this.db.exec('DROP TABLE IF EXISTS camp');
  }

  close(): void {
    this.db.close();
  }

  /**
   * Zone in effect at the start of the newest session for a log — i.e. the zone the first segment
   * of that session carries, not the session's headline zone. This is what a resumed read needs.
   */
  lastSessionZone(logPath: string): { id: number | null; name: string } | null {
    const row = this.db
      .prepare(
        `SELECT z.zone_id, z.zone_name
           FROM zone_segment z JOIN session s ON s.id = z.session_id
          WHERE s.log_path = ?
          ORDER BY s.start_ms DESC, z.start_ms ASC
          LIMIT 1`,
      )
      .get(logPath) as { zone_id: number | null; zone_name: string | null } | undefined;
    if (!row) return null;
    return { id: row.zone_id, name: row.zone_name ?? '' };
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  logState(path: string): LogState | undefined {
    return this.db
      .prepare('SELECT path, bytes, mtime_ms, offset, layout, build, advanced, last_error FROM log_file WHERE path = ?')
      .get(path) as LogState | undefined;
  }

  saveLogProgress(p: {
    path: string;
    flavor: string;
    bytes: number;
    mtimeMs: number;
    offset: number;
    layout: string | null;
    lines: number;
    unparsed: number;
    unknownLines: number;
    build: string | null;
    advanced: number | null;
    characterGuid: string | null;
    characterName: string | null;
    lastError: string | null;
    scannedMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO log_file (path, flavor, bytes, mtime_ms, offset, layout, lines, unparsed,
           unknown_lines, build, advanced, character_guid, character_name, last_error, scanned_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           flavor=excluded.flavor, bytes=excluded.bytes, mtime_ms=excluded.mtime_ms,
           offset=excluded.offset, layout=excluded.layout, lines=excluded.lines,
           unparsed=excluded.unparsed, unknown_lines=excluded.unknown_lines, build=excluded.build,
           advanced=excluded.advanced, character_guid=excluded.character_guid,
           character_name=excluded.character_name, last_error=excluded.last_error,
           scanned_ms=excluded.scanned_ms`,
      )
      .run(
        p.path,
        p.flavor,
        p.bytes,
        p.mtimeMs,
        p.offset,
        p.layout,
        p.lines,
        p.unparsed,
        p.unknownLines,
        p.build,
        p.advanced,
        p.characterGuid,
        p.characterName,
        p.lastError,
        p.scannedMs,
      );
  }

  /** Replace every session at or after `fromMs` for this log, atomically. */
  replaceSessionsFrom(logPath: string, fromMs: number, sessions: SessionSnapshot[], character: { guid: string | null; name: string | null }): number[] {
    const ids: number[] = [];
    this.db.exec('BEGIN');
    try {
      const stale = this.db.prepare('SELECT id FROM session WHERE log_path = ? AND start_ms >= ?').all(logPath, fromMs) as { id: number }[];
      for (const row of stale) {
        this.db.prepare('DELETE FROM session_ability WHERE session_id = ?').run(row.id);
        this.db.prepare('DELETE FROM encounter WHERE session_id = ?').run(row.id);
        this.db.prepare('DELETE FROM zone_segment WHERE session_id = ?').run(row.id);
        this.db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
      }
      const now = Date.now();
      for (const s of sessions) {
        // The interesting zone is the one where the fighting happened, not the one the player
        // logged out in: a battleground session should say "Warsong Gulch", not "Tirisfal Glades".
        const primary = primaryZone(s);
        const info = this.db
          .prepare(
            `INSERT INTO session (log_path, start_ms, end_ms, offset_min, zone_id, zone_name, zones,
               duration_s, active_s, engaged_s, damage_done, damage_taken, healing_done, overheal,
               kills, deaths, my_deaths, players_died, casts, interrupts, character_guid, character_name, ingested_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            logPath,
            s.startMs,
            s.endMs,
            s.offsetMin,
            s.zoneId,
            primary,
            JSON.stringify(
              s.zones.map((z) => ({ name: z.name, kind: z.kind, startMs: z.startMs, endMs: z.endMs })),
            ),
            round((s.endMs - s.startMs) / 1000),
            round(s.open.durationS),
            round(s.open.engagedS),
            s.open.damageDone,
            s.open.damageTaken,
            s.open.healingDone,
            s.open.overheal,
            s.open.kills,
            s.open.deaths,
            s.open.myDeaths,
            s.open.playersDied,
            s.open.casts,
            s.open.interrupts,
            character.guid,
            character.name,
            now,
          );
        const id = Number(info.lastInsertRowid);
        ids.push(id);
        for (const z of s.zones) {
          this.db
            .prepare(
              `INSERT INTO zone_segment (session_id, zone_id, zone_name, kind, start_ms, end_ms,
                 duration_s, engaged_s, damage_done, damage_taken, healing_done, kills, my_deaths,
                 field_deaths, players_died, casts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              z.zoneId,
              z.name,
              z.kind,
              z.startMs,
              z.endMs,
              round((z.endMs - z.startMs) / 1000),
              round(z.engagedS),
              z.damageDone,
              z.damageTaken,
              z.healingDone,
              z.kills,
              z.myDeaths,
              z.deaths,
              z.playersDied,
              z.casts,
            );
        }
        const insertAbility = this.db.prepare(
          'INSERT INTO session_ability (session_id, kind, spell_id, name, amount, hits) VALUES (?,?,?,?,?,?)',
        );
        for (const a of s.open.topAbilities) {
          insertAbility.run(id, 'damage', a.id, a.name, a.amount, a.hits);
        }
        for (const a of s.open.topHealing) {
          insertAbility.run(id, 'healing', a.id, a.name, a.amount, a.hits);
        }
        for (const e of s.encounters) {
          this.db
            .prepare(
              `INSERT INTO encounter (session_id, start_ms, end_ms, boss_id, boss_name, difficulty,
                 size, success, duration_s, damage_done, damage_taken, healing_done, deaths, kills, dps)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              e.startMs,
              e.endMs,
              e.bossId,
              e.bossName,
              e.difficulty,
              e.size,
              e.success === null ? null : e.success ? 1 : 0,
              e.durationS,
              e.damageDone,
              e.damageTaken,
              e.healingDone,
              e.deaths,
              e.kills,
              e.dps,
            );
          for (const a of e.topAbilities) {
            this.db
              .prepare('INSERT INTO session_ability (session_id, kind, spell_id, name, amount, hits) VALUES (?,?,?,?,?,?)')
              .run(id, 'encounter', a.id, a.name, a.amount, a.hits);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return ids;
  }

  listSessions(limit = 60): SessionRow[] {
    return this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM encounter e WHERE e.session_id = s.id) AS encounters,
           (SELECT COUNT(*) FROM zone_segment z WHERE z.session_id = s.id) AS zones_count
         FROM session s ORDER BY s.start_ms DESC LIMIT ?`,
      )
      .all(limit) as unknown as SessionRow[];
  }

  session(id: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  abilities(sessionId: number, kind = 'damage'): { name: string; amount: number; hits: number }[] {
    return this.db
      .prepare('SELECT name, amount, hits FROM session_ability WHERE session_id = ? AND kind = ? ORDER BY amount DESC LIMIT 10')
      .all(sessionId, kind) as unknown as { name: string; amount: number; hits: number }[];
  }

  /** Bag drops for one log, replacing whatever this log produced before. */
  replaceBagDrops(logPath: string, drops: BagDrop[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM bag_drop WHERE log_path = ?').run(logPath);
      const insert = this.db.prepare(
        `INSERT INTO bag_drop (log_path, ts_ms, guid, name, mine, zone_name, map_id, x, y)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const d of drops) {
        insert.run(logPath, d.ms, d.guid, d.name, d.mine ? 1 : 0, d.zoneName, d.map, d.x, d.y);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Every bag drop, newest first. */
  bagDrops(limit = 200): BagDropRow[] {
    return this.db
      .prepare('SELECT * FROM bag_drop ORDER BY ts_ms DESC LIMIT ?')
      .all(limit) as unknown as BagDropRow[];
  }

  /** Who drops bags, how often, and where. */
  bagDropStats(): BagDropStats {
    const one = (sql: string, ...args: (string | number)[]): number =>
      (this.db.prepare(sql).get(...args) as { c: number }).c;
    return {
      total: one('SELECT COUNT(*) c FROM bag_drop'),
      mine: one('SELECT COUNT(*) c FROM bag_drop WHERE mine = 1'),
      droppers: this.db
        .prepare(
          `SELECT COALESCE(name, 'unknown') name, COUNT(*) count, MAX(mine) mine
             FROM bag_drop GROUP BY guid, name ORDER BY count DESC, name LIMIT 15`,
        )
        .all() as unknown as { name: string; count: number; mine: number }[],
      zones: this.db
        .prepare(
          `SELECT COALESCE(NULLIF(zone_name, ''), 'unknown') zone_name, COUNT(*) count
             FROM bag_drop GROUP BY zone_name ORDER BY count DESC, zone_name LIMIT 15`,
        )
        .all() as unknown as { zone_name: string; count: number }[],
    };
  }

  encounters(sessionId: number): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM encounter WHERE session_id = ? ORDER BY start_ms')
      .all(sessionId) as unknown as Record<string, unknown>[];
  }

  /** Every zone visit in a session, in order: the runs. */
  segments(sessionId: number): SegmentRow[] {
    return this.db
      .prepare('SELECT * FROM zone_segment WHERE session_id = ? ORDER BY start_ms')
      .all(sessionId) as unknown as SegmentRow[];
  }

  /** Recent runs across all sessions, newest first. Instances first in the UI's eyes. */
  recentRuns(limit = 60): SegmentRow[] {
    return this.db
      .prepare('SELECT * FROM zone_segment ORDER BY start_ms DESC LIMIT ?')
      .all(limit) as unknown as SegmentRow[];
  }

  logFiles(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM log_file ORDER BY scanned_ms DESC').all() as unknown as Record<string, unknown>[];
  }

  totals(): { sessions: number; damage: number; kills: number; firstMs: number | null; lastMs: number | null } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(damage_done),0) AS damage, COALESCE(SUM(kills),0) AS kills, MIN(start_ms) AS firstMs, MAX(end_ms) AS lastMs FROM session')
      .get() as { sessions: number; damage: number; kills: number; firstMs: number | null; lastMs: number | null };
    return row;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Zone with the most time actually spent fighting, then damage, then time present. */
function primaryZone(s: SessionSnapshot): string {
  if (!s.zones || s.zones.length === 0) return s.zoneName;
  const best = [...s.zones].sort(
    (a, b) =>
      b.engagedS - a.engagedS ||
      b.damageDone - a.damageDone ||
      b.endMs - b.startMs - (a.endMs - a.startMs),
  )[0];
  return best?.name ?? s.zoneName;
}

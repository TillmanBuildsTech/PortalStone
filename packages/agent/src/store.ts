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
  casts INTEGER NOT NULL DEFAULT 0,
  interrupts INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS session_ability (
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  spell_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_start ON session (start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ability_session ON session_ability (session_id);
`;

export interface LogState {
  path: string;
  bytes: number;
  mtime_ms: number;
  offset: number;
  layout: string | null;
  last_error: string | null;
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
  casts: number;
  interrupts: number;
  character_name: string | null;
  encounters: number;
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
  }

  close(): void {
    this.db.close();
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
      .prepare('SELECT path, bytes, mtime_ms, offset, layout, last_error FROM log_file WHERE path = ?')
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
        this.db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
      }
      const now = Date.now();
      for (const s of sessions) {
        const info = this.db
          .prepare(
            `INSERT INTO session (log_path, start_ms, end_ms, offset_min, zone_id, zone_name,
               duration_s, active_s, engaged_s, damage_done, damage_taken, healing_done, overheal,
               kills, deaths, my_deaths, casts, interrupts, character_guid, character_name, ingested_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            logPath,
            s.startMs,
            s.endMs,
            s.offsetMin,
            s.zoneId,
            s.zoneName,
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
            s.open.casts,
            s.open.interrupts,
            character.guid,
            character.name,
            now,
          );
        const id = Number(info.lastInsertRowid);
        ids.push(id);
        for (const a of s.open.topAbilities) {
          this.db
            .prepare('INSERT INTO session_ability (session_id, kind, spell_id, name, amount, hits) VALUES (?,?,?,?,?,?)')
            .run(id, 'damage', a.id, a.name, a.amount, a.hits);
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
        `SELECT s.*, (SELECT COUNT(*) FROM encounter e WHERE e.session_id = s.id) AS encounters
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

  encounters(sessionId: number): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM encounter WHERE session_id = ? ORDER BY start_ms')
      .all(sessionId) as unknown as Record<string, unknown>[];
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

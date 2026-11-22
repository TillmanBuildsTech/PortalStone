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

/**
 * Bumped when the derived data gains a dimension that an older database cannot have. A mismatch
 * triggers one full re-read of every log, which is cheap next to telling the user to run --rebuild.
 */
// 5: sessions carry their own character (a log file can span two toons). Older databases stamped
// every session in a file with one name, which cannot be repaired from what they stored — so the
// bump buys one full re-read.
const DETAIL_SCHEMA = '6';


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
  field_kills INTEGER NOT NULL DEFAULT 0,
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
  field_kills INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS segment_ability (
  segment_id INTEGER NOT NULL REFERENCES zone_segment(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  spell_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0
);

-- A property the user chose to track, from any installed addon. The base adapter discovers what
-- is available; these two tables are what turns one of those properties into a time series.
CREATE TABLE IF NOT EXISTS tracked_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  addon_file TEXT NOT NULL,
  global_name TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'plain',
  -- 'number': summed scalar, charted. 'set': the members of a table (equipment slots), diffed.
  kind TEXT NOT NULL DEFAULT 'number',
  -- the concrete key behind the first wildcard; null means "every instance, summed". Two metrics
  -- may share a path and differ only here: one character's level beside another's.
  entity TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL
);

-- The series identity is (file, path, entity): the same property about two characters is two
-- series, and re-tracking either one must land on its own row instead of hijacking the other's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_metric_unique
  ON tracked_metric (addon_file, path, COALESCE(entity, ''));

CREATE TABLE IF NOT EXISTS tracked_sample (
  metric_id INTEGER NOT NULL REFERENCES tracked_metric(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  value REAL NOT NULL,
  instances INTEGER NOT NULL DEFAULT 1,
  min_value REAL,
  max_value REAL,
  -- set metrics: JSON [{k,v}] of the members observed at this flush
  members TEXT,
  source_file TEXT,
  source_mtime_ms INTEGER NOT NULL DEFAULT 0
);

-- One sample per SavedVariables flush: the file only changes when the game writes it, so the
-- mtime is the natural key and re-scanning the same file cannot duplicate a point.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_sample_flush ON tracked_sample (metric_id, source_mtime_ms);
CREATE INDEX IF NOT EXISTS idx_tracked_sample_ts ON tracked_sample (metric_id, ts_ms DESC);

-- Player-versus-player, one row per event: this is a log of encounters, not a counter, because the
-- question is "who keeps killing me" and that needs names with times.
CREATE TABLE IF NOT EXISTS pvp_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  /** 'kill' = you killed them, 'death' = they killed you */
  direction TEXT NOT NULL,
  opponent_name TEXT NOT NULL,
  opponent_guid TEXT,
  /** the ability that landed the last hit, '' when the log does not say */
  spell TEXT,
  zone_name TEXT,
  zone_kind TEXT,
  character_name TEXT,
  character_guid TEXT,
  UNIQUE (session_id, ts_ms, direction, opponent_name)
);
CREATE INDEX IF NOT EXISTS idx_pvp_opponent ON pvp_event (opponent_name, direction, ts_ms);
CREATE INDEX IF NOT EXISTS idx_pvp_ts ON pvp_event (ts_ms);

-- A dashboard is a named collection of cards; a card names the metric it reads and the view it
-- uses. Nothing here is derived from the logs, so a schema bump never has to re-read them.
CREATE TABLE IF NOT EXISTS dashboard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_card (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id INTEGER NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  view TEXT NOT NULL DEFAULT 'bar',
  -- legacy: 1 = half of the old two-column grid, 2 = the whole row
  span INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  -- gridstack geometry on a 12-column grid; -1 means "let the grid place it"
  x INTEGER NOT NULL DEFAULT -1,
  y INTEGER NOT NULL DEFAULT -1,
  w INTEGER NOT NULL DEFAULT 6,
  h INTEGER NOT NULL DEFAULT 3,
  -- 0 = all time; otherwise the window in minutes (15, 60, 1440, ...)
  range_minutes INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_card_dashboard ON dashboard_card (dashboard_id, position);

-- Item names, once known, never fetched again. Ids are always the fallback, so a slow or partial
-- name source degrades the display and nothing else.
CREATE TABLE IF NOT EXISTS item_name (
  item_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL
);

-- Ids a source looked up and could not resolve. Without this, a private-server item that simply
-- does not exist upstream would be re-requested on every scan forever.
CREATE TABLE IF NOT EXISTS item_name_miss (
  item_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  checked_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_start ON session (start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_segment_session ON zone_segment (session_id);
CREATE INDEX IF NOT EXISTS idx_segment_start ON zone_segment (start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_segment_zone ON zone_segment (zone_name);
CREATE INDEX IF NOT EXISTS idx_ability_session ON session_ability (session_id);
CREATE INDEX IF NOT EXISTS idx_segment_ability ON segment_ability (segment_id, kind);
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

export interface AbilityRow {
  spell_id: number;
  name: string;
  amount: number;
  hits: number;
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
  field_kills: number;
  my_deaths: number;
  field_deaths: number;
  players_died: number;
  casts: number;
  /** whose run this is: the run page compares only this character's own runs */
  character_guid: string | null;
  character_name: string | null;
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
  field_kills: number;
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

/** One character, with what every session of theirs added up to. */
export interface CharacterRow {
  name: string;
  guid: string | null;
  sessions: number;
  first_ms: number;
  last_ms: number;
  duration_s: number;
  engaged_s: number;
  damage: number;
  healing: number;
  kills: number;
  deaths: number;
}

/** A property the user chose to track, and what it meant to them. */
export interface TrackedMetricRow {
  id: number;
  addon_file: string;
  global_name: string;
  /** JSON array of path segments, because addon keys may contain anything */
  path: string;
  label: string;
  unit: string;
  /** 'number' (summed scalar) or 'set' (members of a table, e.g. equipped gear) */
  kind: string;
  /** the key behind the first wildcard (`Slouch Mage`), or null for "all of them, summed" */
  entity: string | null;
  enabled: number;
  created_ms: number;
}

/** One PvP event as stored: the opponent, when, where, and with what. */
export interface PvpEventRow {
  id: number;
  session_id: number;
  ts_ms: number;
  direction: 'kill' | 'death';
  opponent_name: string;
  opponent_guid: string | null;
  spell: string | null;
  zone_name: string | null;
  zone_kind: string | null;
  character_name: string | null;
}

/** One opponent, added up: how often, over what span, and where. */
export interface PvpOpponentRow {
  opponent_name: string;
  times: number;
  first_ms: number;
  last_ms: number;
  zones: number;
  /** the ability that landed it most often — the last one tells you what hurt */
  spell: string | null;
}

export interface PvpSummary {
  kills: number;
  deaths: number;
  /** distinct people you killed */
  opponents: number;
  /** distinct people who killed you */
  killers: number;
  /** people who killed you more than once: the list that makes this page worth opening */
  repeatKillers: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface TrackedSampleRow {
  metric_id: number;
  ts_ms: number;
  value: number;
  instances: number;
  min_value: number | null;
  max_value: number | null;
  /** set metrics: JSON array of {k,v} members observed at this flush */
  members: string | null;
  source_file: string | null;
  source_mtime_ms: number;
}

export interface DashboardRow {
  id: number;
  name: string;
  created_ms: number;
  updated_ms: number;
}

export interface DashboardSummary extends DashboardRow {
  cards: number;
}

export interface DashboardCardRow {
  id: number;
  dashboard_id: number;
  title: string;
  metric: string;
  view: string;
  span: number;
  position: number;
  x: number;
  y: number;
  w: number;
  h: number;
  range_minutes: number;
  created_ms: number;
}

/** Zone visits added up per zone: the comparison basis for "where did my time go". */
export interface ZoneAggregateRow {
  zone_name: string;
  kind: string;
  runs: number;
  duration_s: number;
  engaged_s: number;
  damage_done: number;
  healing_done: number;
  damage_taken: number;
  kills: number;
  my_deaths: number;
  casts: number;
}

export interface Totals {
  sessions: number;
  damage: number;
  healing: number;
  kills: number;
  myDeaths: number;
  deaths: number;
  durationS: number;
  engagedS: number;
  firstMs: number | null;
  lastMs: number | null;
}

/**
 * Which account a SavedVariables path belongs to: `_forever_/LANC3RR1` for
 * `…/_forever_/WTF/Account/LANC3RR1/SavedVariables/BagBrother.lua`. Keyed by flavor and account
 * rather than the whole path, so the same account under a moved install is still one account.
 */
export function accountOf(sourceFile: string | null): string {
  if (!sourceFile) return '';
  const m = /[\\/]([^\\/]+)[\\/]WTF[\\/]Account[\\/]([^\\/]+)[\\/]SavedVariables[\\/]/i.exec(sourceFile);
  return m ? `${m[1]}/${m[2]}` : dirname(sourceFile);
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
    const metricCols = this.db.prepare('PRAGMA table_info(tracked_metric)').all() as { name: string }[];
    if (!metricCols.some((c) => c.name === 'kind')) {
      this.db.exec("ALTER TABLE tracked_metric ADD COLUMN kind TEXT NOT NULL DEFAULT 'number'");
    }
    // Per-character tracked values: an older database has no entity column, and its unique index
    // would refuse a second metric on the same path. Add the column and widen the index, once.
    if (!metricCols.some((c) => c.name === 'entity')) {
      this.db.exec('ALTER TABLE tracked_metric ADD COLUMN entity TEXT');
      this.db.exec('DROP INDEX IF EXISTS idx_tracked_metric_unique');
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_metric_unique ON tracked_metric (addon_file, path, COALESCE(entity, ''))",
      );
    }
    const sampleCols = this.db.prepare('PRAGMA table_info(tracked_sample)').all() as { name: string }[];
    if (!sampleCols.some((c) => c.name === 'members')) {
      this.db.exec('ALTER TABLE tracked_sample ADD COLUMN members TEXT');
    }
    // Dashboard cards grew a grid geometry and a time window. Backfill both once: cards created
    // before the grid existed pair up two to a row, wide cards take the whole row.
    const cardCols = this.db.prepare('PRAGMA table_info(dashboard_card)').all() as { name: string }[];
    if (!cardCols.some((c) => c.name === 'x')) {
      this.db.exec('ALTER TABLE dashboard_card ADD COLUMN x INTEGER NOT NULL DEFAULT -1');
      this.db.exec('ALTER TABLE dashboard_card ADD COLUMN y INTEGER NOT NULL DEFAULT -1');
      this.db.exec('ALTER TABLE dashboard_card ADD COLUMN w INTEGER NOT NULL DEFAULT 6');
      this.db.exec('ALTER TABLE dashboard_card ADD COLUMN h INTEGER NOT NULL DEFAULT 3');
      const legacy = this.db
        .prepare('SELECT id, dashboard_id, span FROM dashboard_card ORDER BY dashboard_id, position, id')
        .all() as { id: number; dashboard_id: number; span: number }[];
      const cursor = new Map<number, { x: number; y: number }>();
      const update = this.db.prepare('UPDATE dashboard_card SET x=?, y=?, w=?, h=? WHERE id=?');
      for (const row of legacy) {
        const w = row.span === 2 ? 12 : 6;
        const h = 3;
        let at = cursor.get(row.dashboard_id) ?? { x: 0, y: 0 };
        if (at.x + w > 12) at = { x: 0, y: at.y + h };
        update.run(at.x, at.y, w, h, row.id);
        at = at.x + w >= 12 ? { x: 0, y: at.y + h } : { x: at.x + w, y: at.y };
        cursor.set(row.dashboard_id, at);
      }
    }
    if (!cardCols.some((c) => c.name === 'range_minutes')) {
      this.db.exec('ALTER TABLE dashboard_card ADD COLUMN range_minutes INTEGER NOT NULL DEFAULT 0');
    }
    const cols = this.db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'zones')) this.db.exec('ALTER TABLE session ADD COLUMN zones TEXT');
    if (!cols.some((c) => c.name === 'field_kills')) {
      this.db.exec('ALTER TABLE session ADD COLUMN field_kills INTEGER NOT NULL DEFAULT 0');
    }
    const segCols = this.db.prepare('PRAGMA table_info(zone_segment)').all() as { name: string }[];
    if (!segCols.some((c) => c.name === 'field_kills')) {
      this.db.exec('ALTER TABLE zone_segment ADD COLUMN field_kills INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'players_died')) {
      this.db.exec('ALTER TABLE session ADD COLUMN players_died INTEGER NOT NULL DEFAULT 0');
    }
    // A run belongs to a character just as much as a session does. These columns were in the
    // zone_segment CREATE TABLE but were never added to databases built before them, and the insert
    // never wrote them — so every run predating this migration knows only its session. Backfill
    // from the session, then index: without this, "my other runs in this zone" is empty for anyone
    // who has been using the app, and filtering runs by character hides their whole history.
    if (!segCols.some((c) => c.name === 'character_name')) {
      if (!cols.some((c) => c.name === 'character_name')) {
        this.db.exec('ALTER TABLE session ADD COLUMN character_guid TEXT');
        this.db.exec('ALTER TABLE session ADD COLUMN character_name TEXT');
      }
      this.db.exec('ALTER TABLE zone_segment ADD COLUMN character_guid TEXT');
      this.db.exec('ALTER TABLE zone_segment ADD COLUMN character_name TEXT');
    }
    this.db.exec(
      `UPDATE zone_segment SET
         character_name = (SELECT s.character_name FROM session s WHERE s.id = zone_segment.session_id),
         character_guid = (SELECT s.character_guid FROM session s WHERE s.id = zone_segment.session_id)
       WHERE character_name IS NULL
         AND EXISTS (SELECT 1 FROM session s WHERE s.id = zone_segment.session_id AND s.character_name IS NOT NULL)`,
    );
    // Sessions are read per character far more often than across all of them, and one player's log
    // directory grows to thousands of rows: without these the filter is a full scan on every page.
    // Created here rather than in SCHEMA, because they name columns old databases only just gained.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_session_character ON session (character_name, start_ms)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_segment_character ON zone_segment (character_name, start_ms)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_segment_zone ON zone_segment (zone_name, character_name, start_ms)');
    // The camp model (bags plus inferred attendance) is gone: distances were guesses dressed as
    // data. Bag drops are hard events, and nothing in these tables was source data.
    this.db.exec('DROP TABLE IF EXISTS camp_attendee');
    this.db.exec('DROP TABLE IF EXISTS camp_bag');
    this.db.exec('DROP TABLE IF EXISTS camp');
    if (this.meta('samples_cross_account') === null) {
      this.mergeAccountSamples();
      this.setMeta('samples_cross_account', '1');
    }
  }

  /**
   * One-time repair of summed series recorded before sampling read every account.
   *
   * Each old sample was one account's total — whichever account had flushed last — so playing alts
   * on two accounts drew a sawtooth between their totals. Every sample still names its source file,
   * which names its account, so the true series is recoverable: at each flush, the total is that
   * account's new value plus every other account's last known one. The original rows are copied to
   * `tracked_sample_premerge` first, so nothing is lost.
   */
  private mergeAccountSamples(): void {
    const metrics = this.db
      .prepare("SELECT id FROM tracked_metric WHERE kind = 'number' AND entity IS NULL")
      .all() as { id: number }[];
    this.db.exec('BEGIN');
    try {
      for (const { id } of metrics) {
        const rows = this.db
          .prepare(
            `SELECT rowid, ts_ms, value, instances, min_value, max_value, source_file
               FROM tracked_sample WHERE metric_id = ? ORDER BY ts_ms, rowid`,
          )
          .all(id) as {
          rowid: number;
          ts_ms: number;
          value: number;
          instances: number;
          min_value: number | null;
          max_value: number | null;
          source_file: string | null;
        }[];
        const accounts = new Set(rows.map((r) => accountOf(r.source_file)));
        if (accounts.size < 2) continue;

        this.db.exec('CREATE TABLE IF NOT EXISTS tracked_sample_premerge AS SELECT * FROM tracked_sample WHERE 0');
        this.db.prepare('INSERT INTO tracked_sample_premerge SELECT * FROM tracked_sample WHERE metric_id = ?').run(id);

        // Before an account's first observation, its first observed value stands in for it. That is
        // exact for an account created mid-history (it starts at 0, as a fresh one does) and the best
        // available estimate otherwise; dropping those points instead would erase all the history
        // from before the second account existed.
        const latest = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          const key = accountOf(row.source_file);
          if (!latest.has(key)) latest.set(key, row);
        }
        const update = this.db.prepare(
          'UPDATE tracked_sample SET value = ?, instances = ?, min_value = ?, max_value = ? WHERE rowid = ?',
        );
        for (const row of rows) {
          latest.set(accountOf(row.source_file), row);
          const parts = [...latest.values()];
          const mins = parts.map((p) => p.min_value ?? p.value);
          const maxes = parts.map((p) => p.max_value ?? p.value);
          update.run(
            parts.reduce((a, p) => a + p.value, 0),
            parts.reduce((a, p) => a + p.instances, 0),
            Math.min(...mins),
            Math.max(...maxes),
            row.rowid,
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  /**
   * The character the last session of this log belonged to.
   *
   * A resumed read starts in the middle of the session still being written, so the events that
   * identified the player are behind the read offset. Seeding from the stored session keeps the
   * re-read session attributed to the same character instead of blanking it.
   */
  lastSessionCharacter(logPath: string): { guid: string | null; name: string | null } | null {
    const row = this.db
      .prepare(
        'SELECT character_guid, character_name FROM session WHERE log_path = ? ORDER BY start_ms DESC LIMIT 1',
      )
      .get(logPath) as { character_guid: string | null; character_name: string | null } | undefined;
    if (!row) return null;
    return { guid: row.character_guid, name: row.character_name };
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
  /**
   * Rewrite every session from `fromMs` on.
   *
   * Each session carries its own character (`selfGuid`/`selfName`), because one log file is one
   * *client launch*: logging out to another toon without restarting keeps writing to the same file,
   * and stamping the whole pass with one name is how a paladin's evening got labelled as the mage's.
   */
  replaceSessionsFrom(
    logPath: string,
    fromMs: number,
    sessions: SessionSnapshot[],
    /** used only when a session carries no identity of its own (hand-built snapshots, old data) */
    fallback?: { guid: string | null; name: string | null },
  ): number[] {
    const ids: number[] = [];
    this.db.exec('BEGIN');
    try {
      const stale = this.db.prepare('SELECT id FROM session WHERE log_path = ? AND start_ms >= ?').all(logPath, fromMs) as { id: number }[];
      const dropAbilities = this.db.prepare(
        'DELETE FROM segment_ability WHERE segment_id IN (SELECT id FROM zone_segment WHERE session_id = ?)',
      );
      for (const row of stale) {
        this.db.prepare('DELETE FROM session_ability WHERE session_id = ?').run(row.id);
        dropAbilities.run(row.id);
        this.db.prepare('DELETE FROM encounter WHERE session_id = ?').run(row.id);
        this.db.prepare('DELETE FROM zone_segment WHERE session_id = ?').run(row.id);
        this.db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
      }
      const now = Date.now();
      for (const s of sessions) {
        // The interesting zone is the one where the fighting happened, not the one the player
        // logged out in: a battleground session should say "Warsong Gulch", not "Tirisfal Glades".
        const primary = primaryZone(s);
        const character = {
          guid: s.selfGuid ?? fallback?.guid ?? null,
          name: s.selfName ?? fallback?.name ?? null,
        };
        const info = this.db
          .prepare(
            `INSERT INTO session (log_path, start_ms, end_ms, offset_min, zone_id, zone_name, zones,
               duration_s, active_s, engaged_s, damage_done, damage_taken, healing_done, overheal,
               kills, field_kills, deaths, my_deaths, players_died, casts, interrupts, character_guid,
               character_name, ingested_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            s.open.fieldKills,
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
        const insertSegment = this.db.prepare(
          `INSERT INTO zone_segment (session_id, zone_id, zone_name, kind, start_ms, end_ms,
             duration_s, engaged_s, damage_done, damage_taken, healing_done, kills, field_kills,
             my_deaths, field_deaths, players_died, casts, character_guid, character_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        const insertSegmentAbility = this.db.prepare(
          'INSERT INTO segment_ability (segment_id, kind, spell_id, name, amount, hits) VALUES (?,?,?,?,?,?)',
        );
        for (const z of s.zones) {
          const seg = insertSegment.run(
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
            z.fieldKills,
            z.myDeaths,
            z.deaths,
            z.playersDied,
            z.casts,
            // Stamped on the run, not just the session: the run page compares this character's
            // own runs, and a run has to be able to answer "whose" without a join.
            character.guid,
            character.name,
          );
          // Per-run detail is what the run page drills into: the same ability breakdown the
          // session gets, kept against the zone visit it happened in.
          const segmentId = Number(seg.lastInsertRowid);
          for (const a of z.topAbilities) insertSegmentAbility.run(segmentId, 'damage', a.id, a.name, a.amount, a.hits);
          for (const a of z.topHealing) insertSegmentAbility.run(segmentId, 'healing', a.id, a.name, a.amount, a.hits);
          for (const a of z.topDamageTaken) insertSegmentAbility.run(segmentId, 'taken', a.id, a.name, a.amount, a.hits);
          // Casts keep the spell id, so two ranks of one spell stay two rows.
          for (const c of z.topCasts) insertSegmentAbility.run(segmentId, 'cast', c.id, c.name, c.casts, 0);
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
        for (const a of s.open.topDamageTaken) {
          insertAbility.run(id, 'taken', a.id, a.name, a.amount, a.hits);
        }
        for (const c of s.open.topCasts) {
          insertAbility.run(id, 'cast', c.id, c.name, c.casts, 0);
        }
        // PvP is kept per event, and the zone comes from the segment the event falls in: the
        // session bag does not know it, but the zone is what a player remembers.
        const insertPvp = this.db.prepare(
          `INSERT OR IGNORE INTO pvp_event (session_id, ts_ms, direction, opponent_name, opponent_guid,
             spell, zone_name, zone_kind, character_name, character_guid)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        );
        const zoneAt = (ms: number): { name: string; kind: string } => {
          const hit = s.zones.find((z) => ms >= z.startMs && ms <= z.endMs);
          return hit ? { name: hit.name, kind: hit.kind } : { name: primary, kind: 'zone' };
        };
        for (const k of s.open.pvpKills) {
          const z = zoneAt(k.ms);
          insertPvp.run(id, k.ms, 'kill', k.name, k.guid, k.spell, z.name, z.kind, character.name, character.guid);
        }
        for (const d of s.open.pvpDeaths) {
          const z = zoneAt(d.ms);
          insertPvp.run(id, d.ms, 'death', d.name, d.guid, d.spell, z.name, z.kind, character.name, character.guid);
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

  listSessions(limit = 60, character: string | null = null): SessionRow[] {
    const where = character ? 'WHERE s.character_name = ?' : '';
    const args = character ? [character, limit] : [limit];
    return this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM encounter e WHERE e.session_id = s.id) AS encounters,
           (SELECT COUNT(*) FROM zone_segment z WHERE z.session_id = s.id) AS zones_count
         FROM session s ${where} ORDER BY s.start_ms DESC LIMIT ?`,
      )
      .all(...args) as unknown as SessionRow[];
  }

  /**
   * Every character that has a session, newest play first.
   *
   * A player's alt and their main are different people as far as every rate on these pages is
   * concerned: a level-15 mage's damage and a level-36 paladin's are not the same measurement, so
   * anything that adds sessions up has to name which character it added. This is the roster that
   * choice is made from.
   */
  characters(): CharacterRow[] {
    return this.db
      .prepare(
        `SELECT COALESCE(NULLIF(character_name, ''), 'unknown') AS name,
                MAX(character_guid) AS guid,
                COUNT(*) AS sessions,
                MIN(start_ms) AS first_ms,
                MAX(COALESCE(end_ms, start_ms)) AS last_ms,
                COALESCE(SUM(duration_s), 0) AS duration_s,
                COALESCE(SUM(engaged_s), 0) AS engaged_s,
                COALESCE(SUM(damage_done), 0) AS damage,
                COALESCE(SUM(healing_done), 0) AS healing,
                COALESCE(SUM(kills), 0) AS kills,
                COALESCE(SUM(my_deaths), 0) AS deaths
           FROM session
         GROUP BY name
         ORDER BY last_ms DESC`,
      )
      .all() as unknown as CharacterRow[];
  }

  /** Headline PvP numbers, optionally for one character. */
  pvpSummary(character: string | null = null): PvpSummary {
    const where = character ? 'WHERE character_name = ?' : '';
    const args = character ? [character] : [];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(direction = 'kill'), 0) AS kills,
                COALESCE(SUM(direction = 'death'), 0) AS deaths,
                COUNT(DISTINCT CASE WHEN direction = 'kill' THEN opponent_name END) AS opponents,
                COUNT(DISTINCT CASE WHEN direction = 'death' THEN opponent_name END) AS killers,
                MIN(ts_ms) AS firstMs,
                MAX(ts_ms) AS lastMs
           FROM pvp_event ${where}`,
      )
      .get(...args) as unknown as Omit<PvpSummary, 'repeatKillers'>;
    const repeat = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT opponent_name FROM pvp_event
            ${where ? `${where} AND` : 'WHERE'} direction = 'death'
            GROUP BY opponent_name HAVING COUNT(*) > 1)`,
      )
      .get(...args) as unknown as { n: number };
    return { ...row, repeatKillers: repeat.n };
  }

  /**
   * Opponents on one side of the exchange, most frequent first.
   *
   * Grouped by name, not guid: the same person can appear under one guid per session in some logs,
   * and the question "is this the same player" is answered by the name a player recognises.
   */
  pvpOpponents(direction: 'kill' | 'death', character: string | null = null, limit = 100): PvpOpponentRow[] {
    const clauses = ['direction = ?'];
    const args: (string | number)[] = [direction];
    if (character) {
      clauses.push('character_name = ?');
      args.push(character);
    }
    args.push(limit);
    return this.db
      .prepare(
        `SELECT opponent_name,
                COUNT(*) AS times,
                MIN(ts_ms) AS first_ms,
                MAX(ts_ms) AS last_ms,
                COUNT(DISTINCT COALESCE(NULLIF(zone_name, ''), 'unknown')) AS zones,
                (SELECT spell FROM pvp_event p2
                  WHERE p2.opponent_name = pvp_event.opponent_name AND p2.direction = pvp_event.direction
                    AND p2.spell IS NOT NULL AND p2.spell <> ''
                  ORDER BY p2.ts_ms DESC LIMIT 1) AS spell
           FROM pvp_event
          WHERE ${clauses.join(' AND ')}
          GROUP BY opponent_name
          ORDER BY times DESC, last_ms DESC
          LIMIT ?`,
      )
      .all(...args) as unknown as PvpOpponentRow[];
  }

  /** The events themselves, newest first: the timeline behind the tables. */
  pvpEvents(character: string | null = null, limit = 200): PvpEventRow[] {
    const where = character ? 'WHERE character_name = ?' : '';
    const args = character ? [character, limit] : [limit];
    return this.db
      .prepare(`SELECT * FROM pvp_event ${where} ORDER BY ts_ms DESC LIMIT ?`)
      .all(...args) as unknown as PvpEventRow[];
  }

  session(id: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  }

  abilities(sessionId: number, kind = 'damage', limit = 12): AbilityRow[] {
    return this.db
      .prepare(
        'SELECT spell_id, name, amount, hits FROM session_ability WHERE session_id = ? AND kind = ? ORDER BY amount DESC LIMIT ?',
      )
      .all(sessionId, kind, limit) as unknown as AbilityRow[];
  }

  /**
   * Average amount per hit for every spell id in a session, across damage and healing.
   * Casts are counted per id, so this is what turns "id 1042, 32 casts" into "id 1042, 32 casts at
   * 630 a hit" — size is the only way to tell which rank is which without a rank table.
   */
  spellAverages(sessionId: number): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT spell_id, CAST(SUM(amount) / NULLIF(SUM(hits), 0) AS INTEGER) avg
           FROM session_ability WHERE session_id = ? AND kind IN ('damage','healing')
           GROUP BY spell_id`,
      )
      .all(sessionId) as unknown as { spell_id: number; avg: number }[];
    return new Map(rows.map((r) => [r.spell_id, r.avg]));
  }

  segmentSpellAverages(segmentId: number): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT spell_id, CAST(SUM(amount) / NULLIF(SUM(hits), 0) AS INTEGER) avg
           FROM segment_ability WHERE segment_id = ? AND kind IN ('damage','healing')
           GROUP BY spell_id`,
      )
      .all(segmentId) as unknown as { spell_id: number; avg: number }[];
    return new Map(rows.map((r) => [r.spell_id, r.avg]));
  }

  /** One zone visit, by segment id: the drill-in target behind a run. */
  segment(id: number): SegmentRow | undefined {
    return this.db.prepare('SELECT * FROM zone_segment WHERE id = ?').get(id) as unknown as SegmentRow | undefined;
  }

  /** Damage, healing or damage taken for one run, largest first. */
  segmentAbilities(segmentId: number, kind = 'damage', limit = 12): AbilityRow[] {
    return this.db
      .prepare(
        'SELECT spell_id, name, amount, hits FROM segment_ability WHERE segment_id = ? AND kind = ? ORDER BY amount DESC LIMIT ?',
      )
      .all(segmentId, kind, limit) as unknown as AbilityRow[];
  }

  /**
   * Every ability recorded for one run, with the kind it was recorded under.
   *
   * The spec classifier needs the whole list, not the top twelve: the single talent-locked ability
   * in a run can sit below twenty generic ones, and a top-twelve table would never show it.
   */
  segmentAbilitiesAll(segmentId: number): (AbilityRow & { kind: string })[] {
    return this.db
      .prepare(
        'SELECT kind, spell_id, name, amount, hits FROM segment_ability WHERE segment_id = ? ORDER BY amount DESC',
      )
      .all(segmentId) as unknown as (AbilityRow & { kind: string })[];
  }

  /**
   * Every run in a zone, newest first. This is the comparison basis for "how did this run compare
   * to my other runs here" — the same character, the same content, so the rates are comparable.
   * Naming the character is not optional in practice: an alt leveling in the same zone as your main
   * would otherwise become the "median" you are measured against.
   */
  runsForZone(zoneName: string, limit = 200, character: string | null = null): SegmentRow[] {
    const where = character ? 'zone_name = ? AND character_name = ?' : 'zone_name = ?';
    const args = character ? [zoneName, character, limit] : [zoneName, limit];
    return this.db
      .prepare(`SELECT * FROM zone_segment WHERE ${where} ORDER BY start_ms DESC LIMIT ?`)
      .all(...args) as unknown as SegmentRow[];
  }

  /** True while the database predates per-run ability detail and needs one full re-read. */
  needsDetailBackfill(): boolean {
    return this.meta('detail_schema') !== DETAIL_SCHEMA;
  }

  markDetailSchema(): void {
    this.setMeta('detail_schema', DETAIL_SCHEMA);
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

  /** Who drops bags, how often, and where. `sinceMs` limits it to a card's time window. */
  bagDropStats(sinceMs: number | null = null): BagDropStats {
    const since = sinceMs && sinceMs > 0 ? sinceMs : 0;
    const where = since > 0 ? 'WHERE ts_ms >= ?' : '';
    const args = since > 0 ? [since] : [];
    const one = (sql: string, ...extra: (string | number)[]): number =>
      (this.db.prepare(sql).get(...extra) as { c: number }).c;
    return {
      total: one(`SELECT COUNT(*) c FROM bag_drop ${where}`, ...args),
      mine: one(`SELECT COUNT(*) c FROM bag_drop ${where}${where ? ' AND' : 'WHERE'} mine = 1`, ...args),
      droppers: this.db
        .prepare(
          `SELECT COALESCE(name, 'unknown') name, COUNT(*) count, MAX(mine) mine
             FROM bag_drop ${where} GROUP BY guid, name ORDER BY count DESC, name LIMIT 15`,
        )
        .all(...args) as unknown as { name: string; count: number; mine: number }[],
      zones: this.db
        .prepare(
          `SELECT COALESCE(NULLIF(zone_name, ''), 'unknown') zone_name, COUNT(*) count
             FROM bag_drop ${where} GROUP BY zone_name ORDER BY count DESC, zone_name LIMIT 15`,
        )
        .all(...args) as unknown as { zone_name: string; count: number }[],
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
  recentRuns(limit = 60, character: string | null = null): SegmentRow[] {
    const where = character ? 'WHERE character_name = ?' : '';
    const args = character ? [character, limit] : [limit];
    return this.db
      .prepare(`SELECT * FROM zone_segment ${where} ORDER BY start_ms DESC LIMIT ?`)
      .all(...args) as unknown as SegmentRow[];
  }

  /**
   * Properties the user chose to track.
   *
   * The base adapter discovers what an addon exposes; this is the selection half. A metric is
   * identified by (file, path) rather than by a provider id so the same money property in the same
   * addon keeps its history across restarts.
   */
  trackedMetrics(): TrackedMetricRow[] {
    return this.db
      .prepare('SELECT * FROM tracked_metric WHERE enabled = 1 ORDER BY created_ms, id')
      .all() as unknown as TrackedMetricRow[];
  }

  trackedMetric(id: number): TrackedMetricRow | undefined {
    return this.db.prepare('SELECT * FROM tracked_metric WHERE id = ?').get(id) as unknown as TrackedMetricRow | undefined;
  }

  /** Track a property. Tracking one twice re-enables it rather than duplicating the series. */
  addTrackedMetric(m: {
    addonFile: string;
    globalName: string;
    path: string[];
    label: string;
    unit: string;
    kind?: 'number' | 'set';
    /** pin the first wildcard to one key (a character); omit to keep summing every instance */
    entity?: string | null;
  }): number {
    const pathJson = JSON.stringify(m.path);
    const kind = m.kind === 'set' ? 'set' : 'number';
    const entity = m.entity && m.entity.length > 0 ? m.entity : null;
    const existing = this.db
      .prepare('SELECT id FROM tracked_metric WHERE addon_file = ? AND path = ? AND entity IS ?')
      .get(m.addonFile, pathJson, entity) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE tracked_metric SET enabled = 1, label = ?, unit = ?, kind = ? WHERE id = ?')
        .run(m.label, m.unit, kind, existing.id);
      return existing.id;
    }
    const info = this.db
      .prepare(
        `INSERT INTO tracked_metric (addon_file, global_name, path, label, unit, kind, entity, enabled, created_ms)
         VALUES (?,?,?,?,?,?,?,1,?)`,
      )
      .run(m.addonFile, m.globalName, pathJson, m.label, m.unit, kind, entity, Date.now());
    return Number(info.lastInsertRowid);
  }

  removeTrackedMetric(id: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM tracked_sample WHERE metric_id = ?').run(id);
      this.db.prepare('DELETE FROM tracked_metric WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** One observation per flush. Returns false when this flush is already stored. */
  recordSample(s: {
    metricId: number;
    tsMs: number;
    value: number;
    instances: number;
    minValue: number | null;
    maxValue: number | null;
    members?: { k: string; v: string }[] | null;
    sourceFile: string;
    sourceMtimeMs: number;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO tracked_sample
           (metric_id, ts_ms, value, instances, min_value, max_value, members, source_file, source_mtime_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.metricId,
        s.tsMs,
        s.value,
        s.instances,
        s.minValue,
        s.maxValue,
        s.members ? JSON.stringify(s.members) : null,
        s.sourceFile,
        s.sourceMtimeMs,
      );
    return Number(info.changes) > 0;
  }

  /** Samples oldest first (chart order), at most `limit` of the newest. */
  samples(metricId: number, limit = 400): TrackedSampleRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tracked_sample WHERE metric_id = ? ORDER BY ts_ms DESC LIMIT ?')
      .all(metricId, limit) as unknown as TrackedSampleRow[];
    return rows.reverse();
  }

  latestSample(metricId: number): TrackedSampleRow | undefined {
    return this.db
      .prepare('SELECT * FROM tracked_sample WHERE metric_id = ? ORDER BY ts_ms DESC LIMIT 1')
      .get(metricId) as unknown as TrackedSampleRow | undefined;
  }

  /* ---------------------------------------------------------------------------------------------
   * Dashboards. A dashboard is a name and an order; a card is a metric plus the view that reads it.
   * Cards are read in the order they were added, so the layout stays put between visits.
   * ------------------------------------------------------------------------------------------- */

  dashboards(): DashboardSummary[] {
    return this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM dashboard_card c WHERE c.dashboard_id = d.id) AS cards
           FROM dashboard d ORDER BY d.created_ms, d.id`,
      )
      .all() as unknown as DashboardSummary[];
  }

  dashboard(id: number): DashboardRow | undefined {
    return this.db.prepare('SELECT * FROM dashboard WHERE id = ?').get(id) as unknown as DashboardRow | undefined;
  }

  createDashboard(name: string): number {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO dashboard (name, created_ms, updated_ms) VALUES (?,?,?)')
      .run(name, now, now);
    return Number(info.lastInsertRowid);
  }

  renameDashboard(id: number, name: string): void {
    this.db
      .prepare('UPDATE dashboard SET name = ?, updated_ms = ? WHERE id = ?')
      .run(name, Date.now(), id);
  }

  /** Remove a dashboard and every card on it, in one transaction. */
  deleteDashboard(id: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM dashboard_card WHERE dashboard_id = ?').run(id);
      this.db.prepare('DELETE FROM dashboard WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  dashboardCards(dashboardId: number): DashboardCardRow[] {
    return this.db
      .prepare('SELECT * FROM dashboard_card WHERE dashboard_id = ? ORDER BY position, id')
      .all(dashboardId) as unknown as DashboardCardRow[];
  }

  dashboardCard(id: number): DashboardCardRow | undefined {
    return this.db.prepare('SELECT * FROM dashboard_card WHERE id = ?').get(id) as unknown as DashboardCardRow | undefined;
  }

  /** Append a card to the end of a dashboard. The dashboard's updated stamp moves with it. */
  addDashboardCard(c: {
    dashboardId: number;
    metric: string;
    title: string;
    view: string;
    span?: number;
    w?: number;
    h?: number;
    x?: number;
    y?: number;
    rangeMinutes?: number;
  }): number {
    const now = Date.now();
    const next = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM dashboard_card WHERE dashboard_id = ?')
      .get(c.dashboardId) as { next: number };
    const span = c.span === 2 || (c.w ?? 0) >= 9 ? 2 : 1;
    const info = this.db
      .prepare(
        `INSERT INTO dashboard_card
           (dashboard_id, title, metric, view, span, position, x, y, w, h, range_minutes, created_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.dashboardId,
        c.title,
        c.metric,
        c.view,
        span,
        next.next,
        clampInt(c.x ?? -1, -1, 11),
        clampInt(c.y ?? -1, -1, 1000),
        clampInt(c.w ?? (span === 2 ? 12 : 6), 1, 12),
        clampInt(c.h ?? 3, 1, 40),
        Math.max(0, Math.round(c.rangeMinutes ?? 0)),
        now,
      );
    this.db.prepare('UPDATE dashboard SET updated_ms = ? WHERE id = ?').run(now, c.dashboardId);
    return Number(info.lastInsertRowid);
  }

  /** Rewrite the non-geometry half of a card. Geometry belongs to the drag/resize layout. */
  updateDashboardCard(
    id: number,
    c: { title: string; metric: string; view: string; rangeMinutes: number },
  ): number {
    const card = this.dashboardCard(id);
    if (!card) return 0;
    const now = Date.now();
    this.db
      .prepare('UPDATE dashboard_card SET title = ?, metric = ?, view = ?, range_minutes = ? WHERE id = ?')
      .run(c.title || c.metric, c.metric, c.view, Math.max(0, Math.round(c.rangeMinutes)), id);
    this.db.prepare('UPDATE dashboard SET updated_ms = ? WHERE id = ?').run(now, card.dashboard_id);
    return card.dashboard_id;
  }

  /**
   * Save the grid after a drag or resize. Only cards that belong to this dashboard are touched; a
   * hand-crafted payload cannot move another dashboard's card.
   */
  saveDashboardLayout(
    dashboardId: number,
    items: { id: number; x: number; y: number; w: number; h: number }[],
  ): number {
    const owned = new Set(this.dashboardCards(dashboardId).map((c) => c.id));
    const update = this.db.prepare(
      'UPDATE dashboard_card SET x = ?, y = ?, w = ?, h = ? WHERE id = ? AND dashboard_id = ?',
    );
    let saved = 0;
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        if (!owned.has(item.id)) continue;
        saved += Number(
          update.run(
            clampInt(item.x, 0, 11),
            clampInt(item.y, 0, 1000),
            clampInt(item.w, 1, 12),
            clampInt(item.h, 1, 40),
            item.id,
            dashboardId,
          ).changes,
        );
      }
      this.db.prepare('UPDATE dashboard SET updated_ms = ? WHERE id = ?').run(Date.now(), dashboardId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return saved;
  }

  /** Remove one card. Returns the dashboard it was on so the caller can send the user back to it. */
  removeDashboardCard(id: number): number {
    const card = this.dashboardCard(id);
    if (!card) return 0;
    this.db.prepare('DELETE FROM dashboard_card WHERE id = ?').run(id);
    this.db.prepare('UPDATE dashboard SET updated_ms = ? WHERE id = ?').run(Date.now(), card.dashboard_id);
    return card.dashboard_id;
  }

  /**
   * Every zone visit, added up per zone. One query, because a dashboard can show half a dozen
   * cards that all group the same runs differently. `sinceMs` limits it to the dashboard card's
   * time window.
   */
  zoneAggregates(sinceMs: number | null = null, character: string | null = null): ZoneAggregateRow[] {
    const clauses: string[] = [];
    const args: (number | string)[] = [];
    if (sinceMs && sinceMs > 0) {
      clauses.push('start_ms >= ?');
      args.push(sinceMs);
    }
    if (character) {
      clauses.push('character_name = ?');
      args.push(character);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT COALESCE(NULLIF(zone_name, ''), 'unknown zone') AS zone_name, kind,
           COUNT(*) AS runs,
           COALESCE(SUM(duration_s), 0) AS duration_s,
           COALESCE(SUM(engaged_s), 0) AS engaged_s,
           COALESCE(SUM(damage_done), 0) AS damage_done,
           COALESCE(SUM(healing_done), 0) AS healing_done,
           COALESCE(SUM(damage_taken), 0) AS damage_taken,
           COALESCE(SUM(kills), 0) AS kills,
           COALESCE(SUM(my_deaths), 0) AS my_deaths,
           COALESCE(SUM(casts), 0) AS casts
         FROM zone_segment ${where}
         GROUP BY zone_name, kind
         ORDER BY zone_name, kind`,
      )
      .all(...args) as unknown as ZoneAggregateRow[];
  }

  /** Names for the ids we have, best-effort. Missing ids are simply absent from the map. */
  itemNames(ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const chunk: number[] = [];
    const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    for (const id of unique) chunk.push(id);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT item_id, name FROM item_name WHERE item_id IN (${placeholders})`)
      .all(...chunk) as unknown as { item_id: number; name: string }[];
    for (const row of rows) out.set(row.item_id, row.name);
    return out;
  }

  /** Names plus which source produced them, so the UI can say where a name came from. */
  itemNameDetails(ids: number[]): Map<number, { name: string; source: string }> {
    const out = new Map<number, { name: string; source: string }>();
    const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    if (unique.length === 0) return out;
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT item_id, name, source FROM item_name WHERE item_id IN (${placeholders})`)
      .all(...unique) as unknown as { item_id: number; name: string; source: string }[];
    for (const row of rows) out.set(row.item_id, { name: row.name, source: row.source });
    return out;
  }

  /** Store names. Existing rows are kept: a name never has to be fetched twice. */
  saveItemNames(rows: { id: number; name: string; source: string }[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      'INSERT INTO item_name (item_id, name, source, fetched_ms) VALUES (?,?,?,?) ON CONFLICT(item_id) DO NOTHING',
    );
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const info = stmt.run(row.id, row.name, row.source, Date.now());
        added += Number(info.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  itemNameCount(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM item_name').get() as { c: number }).c;
  }

  /** How many names came from each source, for the diagnostics page. */
  itemNameSources(): { source: string; count: number }[] {
    return this.db
      .prepare('SELECT source, COUNT(*) count FROM item_name GROUP BY source ORDER BY count DESC')
      .all() as unknown as { source: string; count: number }[];
  }

  /** Ids a source failed to resolve recently: retried after `maxAgeMs`, not every scan. */
  itemNameMisses(ids: number[], maxAgeMs: number): Set<number> {
    const out = new Set<number>();
    const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    if (unique.length === 0) return out;
    const placeholders = unique.map(() => '?').join(',');
    const since = Date.now() - maxAgeMs;
    const rows = this.db
      .prepare(`SELECT item_id FROM item_name_miss WHERE item_id IN (${placeholders}) AND checked_ms >= ?`)
      .all(...unique, since) as unknown as { item_id: number }[];
    for (const row of rows) out.add(row.item_id);
    return out;
  }

  saveItemNameMisses(ids: number[], source: string): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO item_name_miss (item_id, source, checked_ms) VALUES (?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET source = excluded.source, checked_ms = excluded.checked_ms`,
    );
    const now = Date.now();
    for (const id of ids) stmt.run(id, source, now);
  }

  logFiles(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM log_file ORDER BY scanned_ms DESC').all() as unknown as Record<string, unknown>[];
  }

  totals(character: string | null = null): Totals {
    const where = character ? 'WHERE character_name = ?' : '';
    return this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(damage_done),0) AS damage,
                COALESCE(SUM(healing_done),0) AS healing,
                COALESCE(SUM(kills),0) AS kills,
                COALESCE(SUM(my_deaths),0) AS myDeaths,
                COALESCE(SUM(deaths),0) AS deaths,
                COALESCE(SUM(duration_s),0) AS durationS,
                COALESCE(SUM(engaged_s),0) AS engagedS,
                MIN(start_ms) AS firstMs,
                MAX(end_ms) AS lastMs
           FROM session ${where}`,
      )
      .get(...(character ? [character] : [])) as unknown as Totals;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.round(Number.isFinite(n) ? n : min);
  return Math.min(Math.max(v, min), max);
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

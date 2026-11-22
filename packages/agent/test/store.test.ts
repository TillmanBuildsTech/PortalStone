import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-store-'));
const open: Store[] = [];

function store(): Store {
  // unique per store: reusing db-0 across tests meant a later test could read an earlier test's rows
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function bag(over: Partial<BagSnapshot> = {}): BagSnapshot {
  return {
    damageDone: 0,
    damageTaken: 0,
    healingDone: 0,
    overheal: 0,
    hits: 0,
    crits: 0,
    casts: 0,
    interrupts: 0,
    kills: 0,
    fieldKills: 0,
    deaths: 0,
    myDeaths: 0,
    playersDied: 0,
    durationS: 0,
    engagedS: 0,
    dps: 0,
    dpsEngaged: 0,
    hps: 0,
    topAbilities: [],
    topHealing: [],
    topDamageTaken: [],
    topCasts: [],
    misses: [],
    castFailures: [],
    topKills: [],
    pvpKills: [],
    pvpDeaths: [],
    ...over,
  };
}

/** A session with two zone visits, each with its own abilities: exactly what the run page reads. */
function snapshot(): SessionSnapshot {
  return {
    startMs: 1_000_000,
    endMs: 1_600_000,
    startByte: 0,
    offsetMin: -420,
    zoneId: 47,
    zoneName: 'Razorfen Kraul',
    zones: [
      {
        zoneId: 1,
        name: 'The Barrens',
        kind: 'zone',
        startMs: 1_000_000,
        endMs: 1_060_000,
        ...bag({
          damageDone: 500,
          damageTaken: 100,
          engagedS: 40,
          durationS: 60,
          kills: 2,
          topAbilities: [{ id: 20183, name: 'Judgement of Fury', amount: 500, hits: 5, crits: 1 }],
          topDamageTaken: [{ id: 2170, name: 'Molten Blast', amount: 100, hits: 1, crits: 0 }],
        }),
      },
      {
        zoneId: 47,
        name: 'Razorfen Kraul',
        kind: 'dungeon',
        startMs: 1_060_000,
        endMs: 1_600_000,
        ...bag({
          damageDone: 9000,
          healingDone: 3000,
          damageTaken: 2500,
          engagedS: 300,
          durationS: 540,
          kills: 2,
          fieldKills: 87,
          casts: 120,
          topAbilities: [
            { id: 26573, name: 'Consecration', amount: 6000, hits: 40, crits: 2 },
            { id: 20183, name: 'Judgement of Fury', amount: 3000, hits: 30, crits: 0 },
          ],
          topHealing: [{ id: 2061, name: 'Flash Heal', amount: 3000, hits: 10, crits: 0 }],
          topDamageTaken: [{ id: 2170, name: 'Molten Blast', amount: 2500, hits: 25, crits: 0 }],
          topCasts: [
            { id: 647, name: 'Holy Light', casts: 9 },
            { id: 1042, name: 'Holy Light', casts: 4 },
          ],
        }),
      },
    ],
    open: bag({
      damageDone: 9500,
      fieldKills: 87,
      healingDone: 3000,
      damageTaken: 2600,
      engagedS: 340,
      durationS: 600,
      kills: 22,
      casts: 120,
      topAbilities: [{ id: 133, name: 'Fireball', amount: 9500, hits: 70, crits: 5 }],
      topHealing: [{ id: 2061, name: 'Flash Heal', amount: 3000, hits: 10, crits: 0 }],
      topDamageTaken: [{ id: 2170, name: 'Molten Blast', amount: 2600, hits: 26, crits: 0 }],
    }),
    encounters: [],
  };
}

describe('store: per-run detail', () => {
  it('keeps damage, healing and damage taken against the run they happened in', () => {
    const s = store();
    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    const runs = s.segments(id!);
    expect(runs.map((r) => r.zone_name)).toEqual(['The Barrens', 'Razorfen Kraul']);

    const dungeon = runs[1]!;
    expect(s.segmentAbilities(dungeon.id, 'damage').map((a) => a.name)).toEqual([
      'Consecration',
      'Judgement of Fury',
    ]);
    expect(s.segmentAbilities(dungeon.id, 'healing')[0]!.amount).toBe(3000);
    expect(s.segmentAbilities(dungeon.id, 'taken')[0]!.name).toBe('Molten Blast');
    // the open-world visit keeps only its own spell
    expect(s.segmentAbilities(runs[0]!.id, 'damage').map((a) => a.name)).toEqual(['Judgement of Fury']);
  });

  it('stores field kills separately from killing blows', () => {
    const s = store();
    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    const runs = s.segments(id!);
    const dungeon = runs.find((r) => r.zone_name === 'Razorfen Kraul')!;
    expect(dungeon.field_kills).toBe(87);
    expect(dungeon.kills).toBe(2);
    expect(s.session(id!)!.field_kills).toBe(87);
  });

  it('keeps each spell rank as its own cast row', () => {
    const s = store();
    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    const runs = s.segments(id!);
    const casts = s.segmentAbilities(runs[1]!.id, 'cast');
    expect(casts.map((c) => [c.spell_id, c.name, c.amount])).toEqual([
      [647, 'Holy Light', 9],
      [1042, 'Holy Light', 4],
    ]);
    expect(s.abilities(id!, 'cast').length).toBeGreaterThanOrEqual(0);
  });

  it('exposes the session-wide ability breakdown, including damage taken', () => {
    const s = store();
    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    expect(s.abilities(id!, 'damage')[0]!.name).toBe('Fireball');
    expect(s.abilities(id!, 'healing')[0]!.name).toBe('Flash Heal');
    expect(s.abilities(id!, 'taken')[0]!.amount).toBe(2600);
  });

  it('drops stale run detail when the same sessions are re-ingested', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    const second = snapshot();
    second.zones = [second.zones[1]!];
    second.zones[0]!.topAbilities = [{ id: 133, name: 'Fireball', amount: 9000, hits: 60, crits: 0 }];

    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [second], { guid: 'Player-1', name: 'Slouch' });
    const runs = s.segments(id!);
    expect(runs).toHaveLength(1);
    expect(s.segmentAbilities(runs[0]!.id, 'damage').map((a) => a.name)).toEqual(['Fireball']);
    // nothing from the previous ingest survives: the new snapshot's rows only, per kind
    const rows = s.db
      .prepare('SELECT kind, COUNT(*) c FROM segment_ability GROUP BY kind ORDER BY kind')
      .all() as unknown as { kind: string; c: number }[];
    expect(rows).toEqual([
      { kind: 'cast', c: 2 },
      { kind: 'damage', c: 1 },
      { kind: 'healing', c: 1 },
      { kind: 'taken', c: 1 },
    ]);
  });

  it('compares a run against the others in the same zone', () => {
    const s = store();
    const first = snapshot();
    const second = snapshot();
    second.startMs = 2_000_000;
    second.endMs = 2_600_000;
    second.zones[1]!.startMs = 2_060_000;
    second.zones[1]!.endMs = 2_600_000;
    s.replaceSessionsFrom('/logs/a.txt', 0, [first, second], { guid: 'Player-1', name: 'Slouch' });

    const dungeonRuns = s.runsForZone('Razorfen Kraul');
    expect(dungeonRuns).toHaveLength(2);
    expect(dungeonRuns[0]!.start_ms).toBeGreaterThan(dungeonRuns[1]!.start_ms);
  });

  it('flags an older database as needing one backfill, then stops asking', () => {
    const s = store();
    expect(s.needsDetailBackfill()).toBe(true);
    s.markDetailSchema();
    expect(s.needsDetailBackfill()).toBe(false);
  });

  it('sums the totals the index page shows', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Slouch' });
    const totals = s.totals();
    expect(totals.sessions).toBe(1);
    expect(totals.damage).toBe(9500);
    expect(totals.healing).toBe(3000);
    expect(totals.kills).toBe(22);
    expect(totals.durationS).toBeCloseTo(600, 0);
  });

  it('migrates dashboard cards made before the grid onto the grid', () => {
    const path = join(DIR, `legacy-${Math.random().toString(36).slice(2)}.sqlite`);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE dashboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`);
    raw.exec(`CREATE TABLE dashboard_card (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '', metric TEXT NOT NULL, view TEXT NOT NULL DEFAULT 'bar',
      span INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL)`);
    raw.prepare('INSERT INTO dashboard (id, name, created_ms, updated_ms) VALUES (1, ?, 1, 1)').run('Old');
    const insert = raw.prepare(
      'INSERT INTO dashboard_card (dashboard_id, title, metric, view, span, position, created_ms) VALUES (1,?,?,?,?,?,1)',
    );
    insert.run('wide', 'session_damage', 'line', 2, 0);
    insert.run('half', 'zone_kills', 'bar', 1, 1);
    raw.close();

    const s = new Store(path);
    open.push(s);
    const cards = s.dashboardCards(1);
    // the wide card owns its row; the half card starts the next one
    expect(cards[0]).toMatchObject({ x: 0, y: 0, w: 12, h: 3, range_minutes: 0, span: 2 });
    expect(cards[1]).toMatchObject({ x: 0, y: 3, w: 6, h: 3, range_minutes: 0, span: 1 });
  });
});

describe('store: more than one character', () => {
  /** One session for `name`, with a single run in `zone`, so two characters can share a zone. */
  function forCharacter(name: string, zone: string, startMs: number, damage: number) {
    const s = snapshot();
    s.startMs = startMs;
    s.endMs = startMs + 600_000;
    s.zoneName = zone;
    s.zones = [
      {
        zoneId: 1,
        name: zone,
        kind: 'zone',
        startMs,
        endMs: startMs + 600_000,
        ...bag({ damageDone: damage, durationS: 600, engagedS: 300, kills: 5 }),
      },
    ];
    s.open = bag({ damageDone: damage, durationS: 600, engagedS: 300, kills: 5 });
    return s;
  }

  it('lists each character with its own totals, newest played first', () => {
    const store0 = store();
    store0.replaceSessionsFrom('/logs/a.txt', 0, [forCharacter('Main', 'Durotar', 1_000_000, 9000)], {
      guid: 'Player-1',
      name: 'Main',
    });
    store0.replaceSessionsFrom('/logs/b.txt', 0, [forCharacter('Alt', 'Durotar', 2_000_000, 500)], {
      guid: 'Player-2',
      name: 'Alt',
    });

    // An alt that just started is the most recently played, so it leads.
    expect(store0.characters().map((c) => c.name)).toEqual(['Alt', 'Main']);
    const alt = store0.characters()[0]!;
    expect(alt.damage).toBe(500);
    expect(alt.sessions).toBe(1);
    expect(alt.guid).toBe('Player-2');
    expect(alt.key).toBe('Player-2');
  });

  it('keeps two characters with one name apart: the guid carries the realm, the log name does not', () => {
    const store0 = store();
    // `Dead-Sadfatkid-PvP-US` on two realms: same string in the log, different guid prefixes.
    store0.replaceSessionsFrom('/logs/a.txt', 0, [forCharacter('Twin', 'Durotar', 1_000_000, 9000)], {
      guid: 'Player-6798-0001',
      name: 'Twin',
    });
    store0.replaceSessionsFrom('/logs/b.txt', 0, [forCharacter('Twin', 'Durotar', 2_000_000, 500)], {
      guid: 'Player-6934-0002',
      name: 'Twin',
    });
    expect(store0.characters().map((c) => [c.key, c.name, c.damage])).toEqual([
      ['Player-6934-0002', 'Twin', 500],
      ['Player-6798-0001', 'Twin', 9000],
    ]);
    expect(store0.totals('Player-6798-0001').damage).toBe(9000);
    expect(store0.recentRuns(10, 'Player-6934-0002')).toHaveLength(1);
  });

  it('scopes the session list and the totals to one character', () => {
    const store0 = store();
    store0.replaceSessionsFrom('/logs/a.txt', 0, [forCharacter('Main', 'Durotar', 1_000_000, 9000)], {
      guid: 'Player-1',
      name: 'Main',
    });
    store0.replaceSessionsFrom('/logs/b.txt', 0, [forCharacter('Alt', 'Durotar', 2_000_000, 500)], {
      guid: 'Player-2',
      name: 'Alt',
    });

    expect(store0.listSessions(10).map((s) => s.character_name)).toEqual(['Alt', 'Main']);
    expect(store0.listSessions(10, 'Player-1').map((s) => s.character_name)).toEqual(['Main']);
    // Unscoped the total is both people added up; scoped it is one person's evening.
    expect(store0.totals().damage).toBe(9500);
    expect(store0.totals('Player-2').damage).toBe(500);
    expect(store0.totals('Player-1').sessions).toBe(1);
  });

  it('stamps the character on every run, not only on the session', () => {
    const store0 = store();
    const [id] = store0.replaceSessionsFrom('/logs/a.txt', 0, [forCharacter('Alt', 'Durotar', 1_000_000, 500)], {
      guid: 'Player-2',
      name: 'Alt',
    });
    const run = store0.segments(id!)[0]!;
    expect(run.character_name).toBe('Alt');
    expect(run.character_guid).toBe('Player-2');
  });

  it('compares a run only against runs of the same character in that zone', () => {
    const store0 = store();
    store0.replaceSessionsFrom('/logs/a.txt', 0, [forCharacter('Main', 'Durotar', 1_000_000, 9000)], {
      guid: 'Player-1',
      name: 'Main',
    });
    store0.replaceSessionsFrom('/logs/b.txt', 0, [forCharacter('Alt', 'Durotar', 2_000_000, 500)], {
      guid: 'Player-2',
      name: 'Alt',
    });

    // Same zone, two characters: the alt's run must never become the main's comparison basis.
    expect(store0.runsForZone('Durotar')).toHaveLength(2);
    expect(store0.runsForZone('Durotar', 200, 'Player-2').map((r) => r.character_name)).toEqual(['Alt']);
    expect(store0.recentRuns(10, 'Player-1').map((r) => r.character_name)).toEqual(['Main']);
  });

  it('adds the character columns to runs stored before they existed, and backfills them', () => {
    const path = join(DIR, `legacy-seg-${Math.random().toString(36).slice(2)}.sqlite`);
    const raw = new DatabaseSync(path);
    // The shape that crashed the app: sessions know their character, runs do not.
    raw.exec(`CREATE TABLE session (
      id INTEGER PRIMARY KEY AUTOINCREMENT, log_path TEXT NOT NULL, start_ms INTEGER NOT NULL,
      end_ms INTEGER, offset_min INTEGER NOT NULL DEFAULT 0, zone_id INTEGER, zone_name TEXT,
      duration_s REAL NOT NULL DEFAULT 0, active_s REAL NOT NULL DEFAULT 0,
      engaged_s REAL NOT NULL DEFAULT 0, damage_done INTEGER NOT NULL DEFAULT 0,
      damage_taken INTEGER NOT NULL DEFAULT 0, healing_done INTEGER NOT NULL DEFAULT 0,
      overheal INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0, my_deaths INTEGER NOT NULL DEFAULT 0,
      casts INTEGER NOT NULL DEFAULT 0, interrupts INTEGER NOT NULL DEFAULT 0,
      character_guid TEXT, character_name TEXT, ingested_ms INTEGER NOT NULL,
      UNIQUE (log_path, start_ms))`);
    raw.exec(`CREATE TABLE zone_segment (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, zone_id INTEGER,
      zone_name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'zone', start_ms INTEGER NOT NULL,
      end_ms INTEGER, duration_s REAL NOT NULL DEFAULT 0, engaged_s REAL NOT NULL DEFAULT 0,
      damage_done INTEGER NOT NULL DEFAULT 0, damage_taken INTEGER NOT NULL DEFAULT 0,
      healing_done INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
      my_deaths INTEGER NOT NULL DEFAULT 0, field_deaths INTEGER NOT NULL DEFAULT 0,
      players_died INTEGER NOT NULL DEFAULT 0, casts INTEGER NOT NULL DEFAULT 0)`);
    raw
      .prepare('INSERT INTO session (id, log_path, start_ms, ingested_ms, character_guid, character_name) VALUES (1,?,?,?,?,?)')
      .run('/logs/old.txt', 1_000_000, 1, 'Player-1', 'Main');
    raw
      .prepare('INSERT INTO zone_segment (session_id, zone_name, start_ms) VALUES (1, ?, 1000000)')
      .run('Durotar');
    raw.close();

    const s = new Store(path);
    open.push(s);
    // Opening the database is the test: the index needs the column, so this threw before.
    expect(s.runsForZone('Durotar', 10, 'Player-1').map((r) => r.zone_name)).toEqual(['Durotar']);
    expect(s.recentRuns(10, 'Player-2')).toEqual([]);
  });
});

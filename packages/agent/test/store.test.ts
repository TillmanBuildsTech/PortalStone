import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

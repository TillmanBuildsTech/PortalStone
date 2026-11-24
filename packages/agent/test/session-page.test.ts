import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { renderSession } from '../src/ui/pages/session';
import { resolveScope, type Ctx } from '../src/ui/context';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-session-'));
const open: Store[] = [];

function store(): Store {
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
    yourDeaths: [],
    companions: [],
    ...over,
  };
}

function snapshot(start: number, end: number): SessionSnapshot {
  const stats = bag({ damageDone: 1000, healingDone: 500, durationS: 4, engagedS: 3, kills: 2 });
  return {
    startMs: start,
    endMs: end,
    startByte: 0,
    offsetMin: -420,
    zoneId: 1,
    zoneName: 'Scarlet Monastery',
    zones: [
      { zoneId: 1, name: 'Scarlet Monastery', kind: 'dungeon', startMs: start, endMs: end, ...stats },
    ],
    open: stats,
    encounters: [],
  };
}

function ctxFor(s: Store, character: string | null = null): Ctx {
  return {
    store: s,
    installs: [],
    lastScan: { at: 0, entries: 0, errors: 0 },
    dbPath: ':memory:',
    ...resolveScope(s, character),
  };
}

/** Gold is a wildcard path (two characters summed); level is one character's own field. */
function track(s: Store): { gold: number; level: number } {
  const gold = s.addTrackedMetric({
    addonFile: 'BagBrother.lua',
    globalName: 'BrotherBags',
    path: ['BrotherBags', 'forever', '*', 'money'],
    label: 'Gold',
    unit: 'copper',
  });
  const level = s.addTrackedMetric({
    addonFile: 'BagBrother.lua',
    globalName: 'BrotherBags',
    path: ['BrotherBags', 'forever', 'Dead Sadfatkid', 'level'],
    label: 'Level',
    unit: 'plain',
  });
  return { gold, level };
}

function sample(s: Store, metricId: number, ts: number, value: number, instances: number): void {
  s.recordSample({
    metricId,
    tsMs: ts,
    value,
    instances,
    minValue: null,
    maxValue: null,
    sourceFile: '/sv/BagBrother.lua',
    sourceMtimeMs: ts,
  });
}

/**
 * The shape of the user's evening: the session ended at 5000 (last combat event), the logout flush
 * at 6000 showed the values, and two later flushes (7000, 9000) captured gold spent and levels
 * gained with no combat logged in between.
 */
function seed(s: Store): number {
  const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot(1000, 5000)], { guid: 'P-1', name: 'Dead' });
  const { gold, level } = track(s);
  for (const [ts, copper] of [
    [500, 194_213],
    [6000, 209_248],
    [7000, 210_484],
    [9000, 188_129],
  ] as const) {
    sample(s, gold, ts, copper, 2);
  }
  for (const [ts, lvl] of [
    [500, 31],
    [6000, 31],
    [7000, 31],
    [9000, 36],
  ] as const) {
    sample(s, level, ts, lvl, 1);
  }
  return id!;
}

describe('session page: tracked values', () => {
  it('shows what changed after the session, where no session exists to claim it', () => {
    const s = store();
    const id = seed(s);
    const html = renderSession(ctxFor(s), id)!;

    // The session's own bracket: gold gained 1g 50s 35c, level flat.
    expect(html).toContain('+1g 50s 35c');
    expect(html).toContain('no change');

    // The unattributed tail: net gold since the session-end flush, and the levels gained.
    expect(html).toContain('after this session');
    expect(html).toContain('-2g 11s 19c');
    expect(html).toContain('+5');
    expect(html).toContain('no later session to claim them');
    expect(html).toContain('the combat log recorded nothing after');
  });

  it('says the gold number is a sum over characters, not one wallet', () => {
    const s = store();
    const id = seed(s);
    const html = renderSession(ctxFor(s), id)!;
    expect(html).toContain('sum of 2');
    expect(html).toContain('one per character');
  });

  it('persists your deaths and shows what killed you, grouped by killer and blow', () => {
    const s = store();
    const start = 1000;
    const end = 5000;
    const deaths = [
      { ms: 2000, killer: 'Scarlet Centurion', killerGuid: null, killerPlayer: false, spell: 'Heroic Strike' },
      { ms: 3000, killer: 'Scarlet Centurion', killerGuid: null, killerPlayer: false, spell: 'Heroic Strike' },
      { ms: 4000, killer: 'unknown', killerGuid: null, killerPlayer: false, spell: 'Falling' },
    ];
    const stats = bag({ damageDone: 1000, durationS: 4, engagedS: 3, myDeaths: 3, yourDeaths: deaths });
    const snap: SessionSnapshot = {
      startMs: start,
      endMs: end,
      startByte: 0,
      offsetMin: -420,
      zoneId: 1,
      zoneName: 'Scarlet Monastery',
      zones: [{ zoneId: 1, name: 'Scarlet Monastery', kind: 'dungeon', startMs: start, endMs: end, ...stats }],
      open: stats,
      encounters: [],
    };
    const [id] = s.replaceSessionsFrom('/logs/d.txt', 0, [snap], { guid: 'P-1', name: 'Dead' });

    // The store groups identical killer+blow and counts them.
    const rows = s.deaths(id!);
    expect(rows.find((r) => r.killer === 'Scarlet Centurion')!.n).toBe(2);
    // Deaths resolve to the zone visit they fell in, for the run page.
    const seg = s.segments(id!)[0]!;
    expect(s.segmentDeaths(seg.id).reduce((sum, r) => sum + r.n, 0)).toBe(3);

    const html = renderSession(ctxFor(s), id!)!;
    expect(html).toContain('what killed you');
    expect(html).toContain('Scarlet Centurion');
    expect(html).toContain('×2');
    expect(html).toContain('Falling'); // environmental death: no killer, blow names it
  });

  it('does not pretend a comparison exists for the first session of its kind', () => {
    const s = store();
    const id = seed(s);
    const html = renderSession(ctxFor(s), id)!;
    expect(html).toContain('how this session stacked up');
    expect(html).toContain('Nothing to compare against yet');
  });

  it('shows where a session sat against your own history once there is history', () => {
    const s = store();
    // Four Scarlet Monastery nights on one character, with rising damage so rates differ.
    const snaps = [1, 2, 3, 4].map((i) => {
      const start = i * 100_000;
      const stats = bag({ damageDone: i * 30_000, healingDone: 0, durationS: 100, engagedS: 100, fieldKills: i * 10 });
      return {
        startMs: start,
        endMs: start + 100_000,
        startByte: 0,
        offsetMin: -420,
        zoneId: 1,
        zoneName: 'Scarlet Monastery',
        zones: [{ zoneId: 1, name: 'Scarlet Monastery', kind: 'dungeon', startMs: start, endMs: start + 100_000, ...stats }],
        open: stats,
        encounters: [],
      };
    });
    s.replaceSessionsFrom('/logs/b.txt', 0, snaps, { guid: 'P-9', name: 'Grind' });
    const rows = s.listSessions(10, 'P-9');
    const middle = rows.find((r) => r.damage_done === 90_000)!; // the i=3 night
    const html = renderSession(ctxFor(s), middle.id)!;

    expect(html).toContain('how this session stacked up');
    expect(html).toContain('your median');
    expect(html).toContain('your best');
    expect(html).toContain('class="dist"'); // the dot plot rendered
    expect(html).toContain('Scarlet Monastery session'); // basis disclosure names the zone
  });

  it('stops the after-session window at the next session', () => {
    const s = store();
    seed(s);
    // A later session starting at 8000: the 9000 flush belongs to it, not to this one.
    s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot(1000, 5000), snapshot(8000, 12_000)], {
      guid: 'P-1',
      name: 'Dead',
    });
    // replaceSessionsFrom re-inserts both sessions, so the first one has a new id.
    const first = s.listSessions(10).find((row) => row.start_ms === 1000)!;
    const html = renderSession(ctxFor(s), first.id)!;

    expect(html).toContain('+12s 36c'); // the 7000 flush, before the next session began
    expect(html).not.toContain('-2g 11s 19c'); // the 9000 flush belongs to the next session's bracket
    expect(html).toContain('between the end of this session and the start of the next one');
  });
});

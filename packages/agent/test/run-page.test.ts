import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { renderRun } from '../src/ui/pages/run';
import { resolveScope, type Ctx } from '../src/ui/context';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-run-'));
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

/** One Razorfen Kraul run with the given damage over a fixed 100s of combat. */
function runSnap(day: number, damage: number): SessionSnapshot {
  const start = day * 86_400_000;
  const end = start + 100_000;
  const stats = bag({ damageDone: damage, durationS: 100, engagedS: 100, fieldKills: 10 });
  return {
    startMs: start,
    endMs: end,
    startByte: 0,
    offsetMin: -420,
    zoneId: 2,
    zoneName: 'Razorfen Kraul',
    zones: [{ zoneId: 2, name: 'Razorfen Kraul', kind: 'dungeon', startMs: start, endMs: end, ...stats }],
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

describe('run page: trend and percentile against your own runs', () => {
  it('shows the over-time trend once there is enough history, newest run speeding up', () => {
    const s = store();
    // Six nights in one dungeon on one character, damage climbing, so the later runs are faster.
    const snaps = [1, 2, 3, 4, 5, 6].map((d) => runSnap(d, d * 100_000));
    s.replaceSessionsFrom('/logs/rk.txt', 0, snaps, { guid: 'P-7', name: 'Digger' });

    const runs = s.runsForZone('Razorfen Kraul', 50, 'P-7').sort((a, b) => a.start_ms - b.start_ms);
    const newest = runs[runs.length - 1]!; // day 6, the fastest
    const html = renderRun(ctxFor(s), newest.id)!;

    // Percentile phrasing: the newest beats every other run here.
    expect(html).toContain('faster than 100% of them');
    // The trend chart and an improving verdict.
    expect(html).toContain('per second here over time');
    expect(html).toContain('speeding up');
    expect(html).toContain('oldest left; this run is the last');
  });

  it('does not claim a trend with too few runs, but still ranks the run', () => {
    const s = store();
    const snaps = [1, 2, 3].map((d) => runSnap(d, 100_000));
    s.replaceSessionsFrom('/logs/rk.txt', 0, snaps, { guid: 'P-7', name: 'Digger' });

    const runs = s.runsForZone('Razorfen Kraul', 50, 'P-7').sort((a, b) => a.start_ms - b.start_ms);
    const html = renderRun(ctxFor(s), runs[runs.length - 1]!.id)!;

    expect(html).toContain('against your other runs here');
    expect(html).not.toContain('per second here over time'); // trend withheld
  });
});

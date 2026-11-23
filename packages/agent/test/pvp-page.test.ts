/**
 * The PvP page and the store behind it.
 *
 * The behaviour under test is the one the page exists for: the same player killing you twice has to
 * read as one person with two deaths, not as two anonymous rows — and a creature death must never
 * appear at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { renderPvp } from '../src/ui/pages/pvp';
import { resolveScope, type Ctx } from '../src/ui/context';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-pvp-page-'));
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
    ...over,
  };
}

/** A session in one zone, with the PvP exchanges listed against the session bag. */
function snapshot(start: number, pvp: { kills?: [number, string, string][]; deaths?: [number, string, string][] }): SessionSnapshot {
  const stats = bag({
    durationS: 600,
    engagedS: 300,
    kills: pvp.kills?.length ?? 0,
    myDeaths: pvp.deaths?.length ?? 0,
    pvpKills: (pvp.kills ?? []).map(([ms, name, spell]) => ({ ms, name, guid: `Player-9-${name.slice(0, 4)}`, spell })),
    pvpDeaths: (pvp.deaths ?? []).map(([ms, name, spell]) => ({ ms, name, guid: `Player-9-${name.slice(0, 4)}`, spell })),
  });
  return {
    startMs: start,
    endMs: start + 600_000,
    startByte: 0,
    offsetMin: -420,
    zoneId: 33,
    zoneName: 'Stranglethorn Vale',
    zones: [
      { zoneId: 33, name: 'Stranglethorn Vale', kind: 'zone', startMs: start, endMs: start + 600_000, ...stats },
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

/** Uncle-Garry kills you twice and Dryke-Hunt once; you kill Red-Tester once. */
function pvpStore(): Store {
  const s = store();
  s.replaceSessionsFrom(
    '/logs/main.txt',
    0,
    [
      snapshot(1_000_000, {
        kills: [[1_100_000, 'Red-Tester-PvP-US', 'Hammer of Wrath']],
        deaths: [
          [1_200_000, 'Uncle-Garry-PvP-US', 'Shadow Bolt'],
          [1_300_000, 'Dryke-Hunt-PvP-US', 'Aimed Shot'],
          [1_400_000, 'Uncle-Garry-PvP-US', 'Fear'],
        ],
      }),
    ],
    { guid: 'Player-1', name: 'Dead Sadfatkid' },
  );
  return s;
}

describe('pvp store', () => {
  it('counts events, opponents and the people who came back', () => {
    const s = pvpStore();
    const summary = s.pvpSummary();
    expect(summary.kills).toBe(1);
    expect(summary.deaths).toBe(3);
    expect(summary.opponents).toBe(1);
    expect(summary.killers).toBe(2);
    // Uncle-Garry killed you twice: one repeat killer, not two events
    expect(summary.repeatKillers).toBe(1);
  });

  it('keeps one row per opponent, newest exchange first, with the zone', () => {
    const s = pvpStore();
    const killers = s.pvpOpponents('death');
    expect(killers.map((k) => k.opponent_name)).toEqual(['Uncle-Garry-PvP-US', 'Dryke-Hunt-PvP-US']);
    expect(killers[0]).toMatchObject({ times: 2, zones: 1 });
    expect(killers[0]!.first_ms).toBe(1_200_000);
    expect(killers[0]!.last_ms).toBe(1_400_000);
    // the most recent ability is the one shown: it is what they last killed you with
    expect(killers[0]!.spell).toBe('Fear');
  });

  it('scopes the pvp log to a character when asked', () => {
    const s = pvpStore();
    s.replaceSessionsFrom('/logs/alt.txt', 0, [snapshot(2_000_000, { kills: [[2_100_000, 'Someone-Else-PvP-US', 'Frostbolt']] })], {
      guid: 'Player-2',
      name: 'Slouch Mage',
    });
    expect(s.pvpSummary().kills).toBe(2);
    expect(s.pvpSummary('Player-2')).toMatchObject({ kills: 1, deaths: 0 });
    expect(s.pvpOpponents('death', 'Player-2')).toEqual([]);
    expect(s.pvpOpponents('kill', 'Player-2').map((k) => k.opponent_name)).toEqual(['Someone-Else-PvP-US']);
  });

  it('drops the pvp rows when the same session is re-read', () => {
    const s = pvpStore();
    s.replaceSessionsFrom('/logs/main.txt', 0, [snapshot(1_000_000, { kills: [[1_100_000, 'Red-Tester-PvP-US', 'x']] })], {
      guid: 'Player-1',
      name: 'Dead Sadfatkid',
    });
    expect(s.pvpSummary()).toMatchObject({ kills: 1, deaths: 0 });
  });
});

describe('pvp page', () => {
  it('names who killed you and says when they came back', () => {
    const html = renderPvp(ctxFor(pvpStore()));
    expect(html).toContain('Uncle-Garry-PvP-US');
    expect(html).toContain('Dryke-Hunt-PvP-US');
    expect(html).toContain('killed you more than once');
    expect(html).toContain('×2');
    expect(html).toContain('Shadow Bolt');
    // the notice is about the person who has killed you most, not about the last death
    expect(html).toContain('has killed you 2 times');
  });

  it('separates your kills from your deaths', () => {
    const html = renderPvp(ctxFor(pvpStore()));
    expect(html).toContain('who killed you');
    expect(html).toContain('who you killed');
    expect(html).toContain('Red-Tester-PvP-US');
    expect(html).toContain('you killed them');
    expect(html).toContain('they killed you');
  });

  it('says so plainly when there is no pvp at all', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/pve.txt', 0, [snapshot(1_000_000, {})], { guid: 'Player-1', name: 'Solo' });
    const html = renderPvp(ctxFor(s));
    expect(html).toContain('No player has killed or been killed by you');
    // and no repeat-killer section invented from nothing
    expect(html).not.toContain('killed you more than once');
  });
});

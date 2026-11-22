/**
 * The pages that add sessions up, once there is more than one character.
 *
 * The rule these tests hold: a number that adds two characters together has to say so, and a page
 * scoped to one character must not show the other one's evening anywhere on it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { renderHome } from '../src/ui/pages/home';
import { renderRuns } from '../src/ui/pages/runs';
import { renderRun } from '../src/ui/pages/run';
import { resolveScope, type Ctx } from '../src/ui/context';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-characters-'));
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
    ...over,
  };
}

/** One session in one zone, so two characters can log the same zone and be compared. */
function snapshot(start: number, damage: number, zone = 'Durotar', kind = 'zone'): SessionSnapshot {
  const stats = bag({ damageDone: damage, durationS: 600, engagedS: 300, kills: 5 });
  return {
    startMs: start,
    endMs: start + 600_000,
    startByte: 0,
    offsetMin: -420,
    zoneId: 1,
    zoneName: zone,
    zones: [{ zoneId: 1, name: zone, kind, startMs: start, endMs: start + 600_000, ...stats }],
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

/** A paladin and a mage, both with a run in Durotar. */
function twoCharacters(): Store {
  const s = store();
  s.replaceSessionsFrom('/logs/main.txt', 0, [snapshot(1_000_000, 90_000)], {
    guid: 'Player-1',
    name: 'Dead Sadfatkid',
  });
  s.replaceSessionsFrom('/logs/alt.txt', 0, [snapshot(2_000_000, 4_000)], {
    guid: 'Player-2',
    name: 'Slouch Mage',
  });
  return s;
}

/** The same pair, but named the way the combat log names them (Name-Realm-Faction-Region). */
function logNamedCharacters(): Store {
  const s = store();
  s.replaceSessionsFrom('/logs/main.txt', 0, [snapshot(1_000_000, 90_000)], {
    guid: 'Player-1',
    name: 'Dead-Sadfatkid-PvP-US',
  });
  s.replaceSessionsFrom('/logs/alt.txt', 0, [snapshot(2_000_000, 4_000)], {
    guid: 'Player-2',
    name: 'Slouch-Mage-PvP-US',
  });
  return s;
}

describe('sessions page, two characters', () => {
  it('names the character on every row while the totals add everyone up', () => {
    const html = renderHome(ctxFor(twoCharacters()));
    expect(html).toContain('Slouch Mage');
    expect(html).toContain('Dead Sadfatkid');
    // the column is only there because there is more than one character to tell apart
    expect(html).toContain('<th>character</th>');
    expect(html).toContain('2 characters');
  });

  it('drops the column and the other rows once a character is chosen', () => {
    const html = renderHome(ctxFor(twoCharacters(), 'Slouch Mage'));
    expect(html).toContain('<h1>Sessions · Slouch Mage</h1>');
    expect(html).not.toContain('<th>character</th>');
    // Session 1 is the other character's evening: not a row, not a link, not in the totals. The
    // switcher still names them, because switching to them has to stay possible.
    expect(html).not.toContain('/session?id=1');
    // Links carry the identity key; the name above came in as an old-style bookmark and resolved.
    expect(html).toContain('href="/?char=Player-1"');
  });

  it('offers the switcher only when there is more than one character', () => {
    const one = store();
    one.replaceSessionsFrom('/logs/a.txt', 0, [snapshot(1_000_000, 1000)], { guid: 'Player-1', name: 'Solo' });
    expect(renderHome(ctxFor(one))).not.toContain('all characters');
    expect(renderHome(ctxFor(twoCharacters()))).toContain('all characters');
  });
  it('shows a tracked value only on the page of the character it belongs to', () => {
    const s = logNamedCharacters();
    // Two series on one path, differing only by entity: the alt's level and the main's.
    const path = ['BrotherBags', 'forever', '*', 'level'];
    const paladin = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path,
      label: 'Level',
      unit: 'plain',
      kind: 'number',
      entity: 'Dead Sadfatkid',
    });
    const mage = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path,
      label: 'Level',
      unit: 'plain',
      kind: 'number',
      entity: 'Slouch Mage',
    });
    expect(paladin).not.toBe(mage);
    for (const [metricId, value] of [
      [paladin, 32],
      [mage, 10],
    ] as [number, number][]) {
      s.recordSample({
        metricId,
        tsMs: 1_700_000_000_000,
        value,
        instances: 1,
        minValue: value,
        maxValue: value,
        sourceFile: '/sv/BagBrother.lua',
        sourceMtimeMs: 1_700_000_000_000,
      });
    }

    // The log name is `Slouch-Mage-PvP-US`, the addon key `Slouch Mage`: the page has to join them.
    const alt = renderHome(ctxFor(s, 'Slouch-Mage-PvP-US'));
    expect(alt).toContain('level · Slouch Mage');
    expect(alt).toContain('<div class="v">10');
    // and must not show the main's level on the alt's page
    expect(alt).not.toContain('level · Dead Sadfatkid');

    const main = renderHome(ctxFor(s, 'Dead-Sadfatkid-PvP-US'));
    expect(main).toContain('level · Dead Sadfatkid');

    // Unscoped, both are listed: the label names which character each number is about.
    const all = renderHome(ctxFor(s));
    expect(all).toContain('level · Dead Sadfatkid');
  });

  it('leaves an unpinned sum off a scoped page and says so', () => {
    const s = logNamedCharacters();
    // Gold sums every wallet: on one character's page it is not that character's money.
    s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold',
      unit: 'copper',
      kind: 'number',
    });
    const scoped = renderHome(ctxFor(s, 'Slouch-Mage-PvP-US'));
    expect(scoped).not.toContain('<div class="k">gold</div>');
    expect(scoped).toContain('No tracked value is tied to');
    // unscoped it is a legitimate total
    expect(renderHome(ctxFor(s))).toContain('<div class="k">gold</div>');
  });

});

describe('runs page, two characters', () => {
  it('marks each run with its character, and follows the scope', () => {
    const all = renderRuns(ctxFor(twoCharacters()));
    expect(all).toContain('Slouch Mage');
    expect(all).toContain('Dead Sadfatkid');
    expect(all).toContain('<th>character</th>');

    const alt = renderRuns(ctxFor(twoCharacters(), 'Slouch Mage'));
    expect(alt).toContain('<h1>Runs · Slouch Mage</h1>');
    expect(alt).not.toContain('/run?id=1');
  });
});

describe('run page comparison', () => {
  it('compares against runs of the same character only', () => {
    const s = twoCharacters();
    // The alt's second Durotar visit, so both characters have runs in the zone.
    s.replaceSessionsFrom('/logs/alt.txt', 0, [snapshot(2_000_000, 4_000), snapshot(3_000_000, 8_000)], {
      guid: 'Player-2',
      name: 'Slouch Mage',
    });
    const altRun = s
      .segments(s.listSessions(10, 'Player-2')[0]!.id)
      .find((r) => r.zone_name === 'Durotar')!;

    const html = renderRun(ctxFor(s), altRun.id)!;
    // one other run of this zone, and it is the alt's own — not the paladin's
    expect(html).toContain('1 other run of this zone logged on Slouch Mage');
  });
});

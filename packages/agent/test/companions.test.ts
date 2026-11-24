/**
 * The store side of companions: write a session's roster through the same path a scan uses, then
 * read it back the way the People, session and run pages do — all-time ranking, per-session and
 * per-run presence, and one person's shared-session history, each scoped to a character.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import type { BagSnapshot, CompanionStat } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-companions-'));
const open: Store[] = [];
function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const PARTY = 0x2;
const RAID = 0x4;

function bag(over: Partial<BagSnapshot> = {}): BagSnapshot {
  return {
    damageDone: 0, damageTaken: 0, healingDone: 0, overheal: 0, hits: 0, crits: 0, casts: 0,
    interrupts: 0, kills: 0, fieldKills: 0, deaths: 0, myDeaths: 0, playersDied: 0,
    durationS: 0, engagedS: 0, dps: 0, dpsEngaged: 0, hps: 0,
    topAbilities: [], topHealing: [], topDamageTaken: [], topCasts: [],
    misses: [], castFailures: [], topKills: [], pvpKills: [], pvpDeaths: [], yourDeaths: [],
    companions: [],
    ...over,
  };
}

function comp(guid: string, name: string, affiliation: number, events: number, ms: number): CompanionStat {
  return { guid, name, affiliation, events, firstMs: ms, lastMs: ms + 1000 };
}

/** A one-zone session in `zone` (of `kind`) with the given companions. */
function withCompanions(
  startMs: number,
  zone: string,
  kind: string,
  companions: CompanionStat[],
): SessionSnapshot {
  return {
    startMs,
    endMs: startMs + 600_000,
    startByte: 0,
    offsetMin: 0,
    zoneId: 1,
    zoneName: zone,
    zones: [
      {
        zoneId: 1,
        name: zone,
        kind,
        startMs,
        endMs: startMs + 600_000,
        ...bag({ damageDone: 1000, durationS: 600, engagedS: 300, companions }),
      },
    ],
    open: bag({ damageDone: 1000, durationS: 600, engagedS: 300, companions }),
    encounters: [],
  };
}

const ALLY = 'Player-1-ALLY';
const RARE = 'Player-1-RARE';

describe('store: companion roster', () => {
  it('ranks the people you grouped with by sessions together', () => {
    const s = store();
    // Two dungeon nights with ALLY; one with RARE.
    s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [comp(ALLY, 'Ally', PARTY, 400, 1_000_000)]),
      withCompanions(2_000_000, 'Deadmines', 'dungeon', [
        comp(ALLY, 'Ally', PARTY, 300, 2_000_000),
        comp(RARE, 'Rare', PARTY, 50, 2_000_000),
      ]),
    ], { guid: 'Player-1-SELF', name: 'Main' });

    const people = s.companions();
    expect(people.map((p) => [p.name, p.sessions, p.runs])).toEqual([
      ['Ally', 2, 2],
      ['Rare', 1, 1],
    ]);
    expect(people[0]!.events).toBe(700); // 400 + 300 across the two nights
    expect(people[0]!.in_party).toBeGreaterThan(0);
    expect(people[0]!.in_raid).toBe(0);

    const sum = s.companionSummary();
    expect(sum.people).toBe(2);
    expect(sum.sessions).toBe(2);
  });

  it('scopes the roster to one character, like every other page', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [comp(ALLY, 'Ally', PARTY, 100, 1_000_000)]),
    ], { guid: 'Player-1-MAIN', name: 'Main' });
    s.replaceSessionsFrom('/logs/b.txt', 0, [
      withCompanions(2_000_000, 'Stockade', 'dungeon', [comp(RARE, 'Rare', PARTY, 100, 2_000_000)]),
    ], { guid: 'Player-1-ALT', name: 'Alt' });

    expect(s.companions('Player-1-MAIN').map((p) => p.name)).toEqual(['Ally']);
    expect(s.companions('Player-1-ALT').map((p) => p.name)).toEqual(['Rare']);
    expect(s.companions().map((p) => p.name).sort()).toEqual(['Ally', 'Rare']);
  });

  it('unions party and raid context across sessions for one person', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [comp(ALLY, 'Ally', PARTY, 10, 1_000_000)]),
      withCompanions(2_000_000, 'Warsong Gulch', 'battleground', [comp(ALLY, 'Ally', RAID, 10, 2_000_000)]),
    ], { guid: 'Player-1-SELF', name: 'Main' });

    const ally = s.companion(ALLY)!;
    expect(ally.in_party).toBeGreaterThan(0);
    expect(ally.in_raid).toBeGreaterThan(0);
    expect(ally.sessions).toBe(2);
    // one instanced dungeon + one battleground are both counted as runs
    expect(ally.runs).toBe(2);
    expect(s.companionSessions(ALLY)).toHaveLength(2);
  });

  it('reads the per-session and per-run rosters', () => {
    const s = store();
    const [id] = s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [
        comp(ALLY, 'Ally', PARTY, 400, 1_000_000),
        comp(RARE, 'Rare', PARTY, 20, 1_000_000),
      ]),
    ], { guid: 'Player-1-SELF', name: 'Main' });

    const roster = s.sessionCompanions(id!);
    expect(roster.map((c) => c.name)).toEqual(['Ally', 'Rare']); // most events first
    const run = s.segments(id!)[0]!;
    expect(s.segmentCompanions(run.id).map((c) => c.name)).toEqual(['Ally', 'Rare']);
  });

  it('drops a companion roster when the session is re-ingested', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [comp(ALLY, 'Ally', PARTY, 400, 1_000_000)]),
    ], { guid: 'Player-1-SELF', name: 'Main' });
    // Re-read the same file with a different roster: the old rows must not linger.
    s.replaceSessionsFrom('/logs/a.txt', 0, [
      withCompanions(1_000_000, 'Deadmines', 'dungeon', [comp(RARE, 'Rare', PARTY, 400, 1_000_000)]),
    ], { guid: 'Player-1-SELF', name: 'Main' });

    expect(s.companions().map((p) => p.name)).toEqual(['Rare']);
  });
});

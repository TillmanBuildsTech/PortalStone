/**
 * Companions: who you were grouped with.
 *
 * The signal is the affiliation bit the log stamps on every unit. A party or raid bit means "on
 * your side, grouped with you"; your own units carry MINE, and creatures carry neither. These
 * tests prove that only grouped players are collected — not you, not your enemies, not the mobs —
 * and that a name missing from one event (a heal carries only a guid) is filled from another.
 */
import { describe, expect, it } from 'vitest';
import { Aggregator } from '../src/combatlog/aggregate';
import { FLAG } from '../src/combatlog/fields';
import type { LogEvent } from '../src/combatlog/decode';

const SELF = 'Player-1-SELF';
const ALLY = 'Player-1-ALLY';
const RAIDER = 'Player-1-RAIDER';
const ENEMY = 'Player-1-ENEMY';
const MOB = 'Creature-0-0-0-0-MOB';

function dmg(
  ms: number,
  src: { guid: string; name: string; flags: number },
  dst: { guid: string; name: string; flags: number },
): LogEvent {
  return {
    t: 'damage',
    ms,
    srcGuid: src.guid,
    srcName: src.name,
    srcFlags: src.flags,
    dstGuid: dst.guid,
    dstName: dst.name,
    dstFlags: dst.flags,
    spellId: 133,
    spellName: 'Fireball',
    amount: 50,
    absorbed: 0,
    isCrit: false,
  };
}

const PARTY_PLAYER = FLAG.PARTY | FLAG.PLAYER;
const RAID_PLAYER = FLAG.RAID | FLAG.PLAYER;
const MINE_PLAYER = FLAG.MINE | FLAG.PLAYER;
const OUTSIDER_PLAYER = 0x8 | FLAG.PLAYER;
const MOB_FLAGS = 0x8 | 0x800; // outsider, NPC type — never a player

function session(events: LogEvent[]) {
  const agg = new Aggregator();
  let i = 0;
  for (const ev of events) agg.push(ev, 0, i++);
  agg.finish();
  return agg.sessions[0]!.open.snapshot();
}

describe('companion collection', () => {
  it('records a grouped player, and neither you nor the creatures', () => {
    const snap = session([
      // you hit a mob, a mob hits you: neither is a companion
      dmg(1000, { guid: SELF, name: 'Me', flags: MINE_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }),
      dmg(1500, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }, { guid: SELF, name: 'Me', flags: MINE_PLAYER }),
      // a party member fights the mob, and takes a hit from it
      dmg(2000, { guid: ALLY, name: 'Healbot', flags: PARTY_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }),
      dmg(2500, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }, { guid: ALLY, name: 'Healbot', flags: PARTY_PLAYER }),
    ]);

    expect(snap.companions.map((c) => c.guid)).toEqual([ALLY]);
    const ally = snap.companions[0]!;
    expect(ally.name).toBe('Healbot');
    expect(ally.affiliation).toBe(FLAG.PARTY);
    expect(ally.events).toBe(2); // once as attacker, once as target
  });

  it('leaves an enemy player out: hostile is not grouped', () => {
    const snap = session([
      dmg(1000, { guid: SELF, name: 'Me', flags: MINE_PLAYER }, { guid: ENEMY, name: 'Ganker', flags: OUTSIDER_PLAYER }),
      dmg(1500, { guid: ENEMY, name: 'Ganker', flags: OUTSIDER_PLAYER }, { guid: SELF, name: 'Me', flags: MINE_PLAYER }),
    ]);
    expect(snap.companions).toEqual([]);
  });

  it('unions party and raid affiliation when a player is seen in both', () => {
    const snap = session([
      dmg(1000, { guid: ALLY, name: 'Friend', flags: PARTY_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }),
      dmg(5000, { guid: ALLY, name: 'Friend', flags: RAID_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }),
    ]);
    expect(snap.companions).toHaveLength(1);
    expect(snap.companions[0]!.affiliation).toBe(FLAG.PARTY | FLAG.RAID);
    expect(snap.companions[0]!.firstMs).toBe(1000);
    expect(snap.companions[0]!.lastMs).toBe(5000);
  });

  it('fills a name from a later event when the first sighting had none (a heal)', () => {
    const snap = session([
      // a healer's heal names only guids; they are a raider, but unnamed here
      {
        t: 'heal',
        ms: 1000,
        srcGuid: RAIDER,
        srcFlags: RAID_PLAYER,
        dstGuid: SELF,
        dstFlags: MINE_PLAYER,
        spellId: 2061,
        spellName: 'Flash Heal',
        amount: 300,
        overheal: 0,
      },
      // then the same raider casts, which does carry a name
      {
        t: 'cast',
        ms: 2000,
        srcGuid: RAIDER,
        srcName: 'Priestly',
        srcFlags: RAID_PLAYER,
        spellId: 2061,
        spellName: 'Flash Heal',
      },
    ]);
    expect(snap.companions).toHaveLength(1);
    expect(snap.companions[0]!.guid).toBe(RAIDER);
    expect(snap.companions[0]!.name).toBe('Priestly');
    expect(snap.companions[0]!.affiliation).toBe(FLAG.RAID);
  });

  it('keeps per-zone rosters: a companion appears only in the zone you grouped with them in', () => {
    const agg = new Aggregator();
    let i = 0;
    const push = (ev: LogEvent) => agg.push(ev, 0, i++);
    // zone 1: grouped with ALLY
    push({ t: 'zone', ms: 1000, zoneId: 1, zoneName: 'The Barrens' });
    push(dmg(1100, { guid: ALLY, name: 'Ally', flags: PARTY_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }));
    // zone 2 (a long gap so the zone splits): grouped with RAIDER
    push({ t: 'zone', ms: 2000, zoneId: 2, zoneName: 'Wailing Caverns' });
    push(dmg(2100, { guid: RAIDER, name: 'Raider', flags: RAID_PLAYER }, { guid: MOB, name: 'Boar', flags: MOB_FLAGS }));
    agg.finish();

    const zones = agg.sessions[0]!.zones;
    const barrens = zones.find((z) => z.name === 'The Barrens')!;
    const caverns = zones.find((z) => z.name === 'Wailing Caverns')!;
    expect(barrens.bag.snapshot().companions.map((c) => c.name)).toEqual(['Ally']);
    expect(caverns.bag.snapshot().companions.map((c) => c.name)).toEqual(['Raider']);
    // the session roster is the union of both
    expect(agg.sessions[0]!.open.snapshot().companions.map((c) => c.name).sort()).toEqual(['Ally', 'Raider']);
  });
});

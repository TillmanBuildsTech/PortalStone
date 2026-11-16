/**
 * PvP: who killed whom.
 *
 * The two questions this file holds are "did a player death get attributed to the right side" and
 * "is the name a person, not a spell". A death to a creature must never enter the PvP lists, or
 * every questing session fills "who killed you" with wolves.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-pvp-'));

async function run(name: string, text: string) {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
  return res.sessions[0]!;
}

describe('pvp attribution', () => {
  it('records an enemy player you killed, with the ability that landed it', async () => {
    const s = await run(
      'kill.txt',
      makeLog({ format: 'forever', enemyPlayerKills: 2, playerDamage: [10, 11, 12, 13, 14] }),
    );
    expect(s.open.pvpKills.map((k) => k.name)).toEqual(['Red-Tester-PvP-US', 'Red-Tester-PvP-US']);
    expect(s.open.pvpKills[0]!.guid).toBe('Player-9999-0000ENEMY');
    // the fixture's killing blow is a Fireball, and that is evidence worth keeping
    expect(s.open.pvpKills[0]!.spell).toBe('Fireball');
    // still a kill, still not a field kill: a player is not a creature
    expect(s.open.kills).toBe(2);
    expect(s.open.fieldKills).toBe(0);
  });

  it('names the player who killed you, not the spell that did it', async () => {
    const s = await run(
      'death.txt',
      makeLog({
        format: 'forever',
        killer: { name: 'Tye-Ironbeard-PvP-US', guid: 'Player-9999-0000KILLER' },
        playerDeath: true,
        playerDamage: [10, 11, 12, 13, 14],
      }),
    );
    expect(s.open.myDeaths).toBe(1);
    expect(s.open.pvpDeaths).toHaveLength(1);
    const death = s.open.pvpDeaths[0]!;
    expect(death.name).toBe('Tye-Ironbeard-PvP-US');
    expect(death.guid).toBe('Player-9999-0000KILLER');
    expect(death.spell).toBe('Shadow Bolt');
    // the death log agrees, and its "killer" is the attacker rather than an ability name
    expect(s.open.deaths).toBe(1);
  });

  it('keeps a death with no attacker out of the pvp list but still counts it', async () => {
    const s = await run('unattributed.txt', makeLog({ format: 'forever', playerDeath: true, playerDamage: [10, 11, 12, 13, 14] }));
    expect(s.open.myDeaths).toBe(1);
    expect(s.open.pvpDeaths).toEqual([]);
  });

  it('leaves creature deaths out of pvp entirely', async () => {
    const s = await run('pve.txt', makeLog({ format: 'forever', mobKills: 3, playerDamage: [10, 11, 12, 13, 14] }));
    expect(s.open.pvpKills).toEqual([]);
    expect(s.open.pvpDeaths).toEqual([]);
    expect(s.open.kills).toBe(3);
  });
});

describe('pvp attribution: a pet lands the blow', () => {
  it('names the owner of the pet that finished you', async () => {
    const s = await run(
      'pet.txt',
      makeLog({
        format: 'forever',
        killer: { name: 'Tye-Ironbeard-PvP-US', guid: 'Player-9999-0000KILLER' },
        petBlow: { name: 'Cockadile', guid: 'Pet-0-7066-0-50293-165189-01000B30A8' },
        playerDeath: true,
        playerDamage: [10, 11, 12, 13, 14],
      }),
    );
    // The killing blow is the pet's swing, which carries no player bit; the hunter who hit you
    // moments before is the answer, and inventing "Cockadile" as the killer would not be one.
    expect(s.open.pvpDeaths).toHaveLength(1);
    expect(s.open.pvpDeaths[0]!.name).toBe('Tye-Ironbeard-PvP-US');
    expect(s.open.pvpDeaths[0]!.spell).toBe('Shadow Bolt');
  });
});

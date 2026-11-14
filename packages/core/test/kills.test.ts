import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-kills-'));

async function run(name: string, text: string) {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
  return res.sessions[0]!;
}

/**
 * "Kills" cannot mean "killing blows I landed": a healer in a group dungeon lands almost none, and a
 * 37-minute Scarlet Monastery run then reports one kill while eighty mobs died. Field kills are the
 * mirror of field deaths — what died around you, whoever killed it — and are the basis for a
 * kills-per-hour rate.
 */
describe('kills vs field kills', () => {
  it('counts a mob another player killed as a field kill, not as yours', async () => {
    const s = await run(
      'group.txt',
      makeLog({ format: 'forever', zone: { id: 189, name: 'Scarlet Monastery' }, groupKills: 3, playerDamage: [10, 11, 12, 13, 14] }),
    );
    expect(s.open.fieldKills).toBe(3);
    expect(s.open.kills).toBe(0);
  });

  it('counts your own killing blow as both', async () => {
    const s = await run('mine.txt', makeLog({ format: 'forever', mobKills: 2, playerDamage: [10, 11, 12, 13, 14] }));
    expect(s.open.fieldKills).toBe(2);
    expect(s.open.kills).toBe(2);
  });

  it('does not count a dead player as a field kill', async () => {
    const s = await run(
      'pvp.txt',
      makeLog({ format: 'forever', enemyPlayerKills: 1, playerDamage: [10, 11, 12, 13, 14] }),
    );
    expect(s.open.kills).toBe(1);
    expect(s.open.fieldKills).toBe(0);
    expect(s.open.deaths).toBe(1);
  });

  it('keeps field kills with the zone they happened in', async () => {
    const s = await run(
      'zones.txt',
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        zone1Casts: 1,
        zone2: { id: 189, name: 'Scarlet Monastery' },
        zone2Damage: [100, 100, 100, 100, 100],
        groupKills: 4,
      }),
    );
    const dungeon = s.zones.find((z) => z.name === 'Scarlet Monastery')!;
    expect(dungeon.fieldKills).toBe(4);
    expect(dungeon.kills).toBe(0);
    expect(s.zones[0]!.fieldKills).toBe(0);
  });
});

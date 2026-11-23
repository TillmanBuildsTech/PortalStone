import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-deaths-'));

async function run(name: string, text: string) {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
  return res.sessions[0]!;
}

/**
 * "What killed you" needs more than the death count: it needs the finishing blow. The aggregator
 * keeps a death log; the snapshot must carry your own deaths out of core so the store can persist
 * them — other players' deaths stay field deaths, counted but not named.
 */
describe('your deaths in the snapshot', () => {
  it('names the player and the finishing blow when the log says who killed you', async () => {
    const s = await run(
      'pvp-death.txt',
      makeLog({
        format: 'forever',
        playerDamage: [10, 11, 12, 13, 14],
        playerDeath: true,
        killer: { name: 'Red-Tester', guid: 'Player-9-00000002' },
      }),
    );
    expect(s.open.yourDeaths).toHaveLength(1);
    const d = s.open.yourDeaths[0]!;
    expect(d.killer).toBe('Red-Tester');
    expect(d.killerPlayer).toBe(true);
    expect(d.spell).toBe('Shadow Bolt');
  });

  it('keeps a PvE death whose killer the log never named, rather than dropping it', async () => {
    const s = await run(
      'pve-death.txt',
      makeLog({ format: 'forever', playerDamage: [10, 11, 12, 13, 14], playerDeath: true }),
    );
    expect(s.open.yourDeaths).toHaveLength(1);
    expect(s.open.yourDeaths[0]!.killerPlayer).toBe(false);
    expect(s.open.myDeaths).toBe(1);
  });

  it('records nothing when you did not die', async () => {
    const s = await run('alive.txt', makeLog({ format: 'forever', playerDamage: [10, 11, 12, 13, 14] }));
    expect(s.open.yourDeaths).toHaveLength(0);
  });
});

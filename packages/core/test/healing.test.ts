import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest, type IngestResult } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-heal-'));

async function run(name: string, text: string): Promise<Extract<IngestResult, { ok: true }>> {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`expected ok ingest, got ${res.reason}: ${res.detail}`);
  return res;
}

/**
 * A healer needs the mirror image of "damage by ability". The log carries the spell on every
 * SPELL_HEAL line, so the same aggregation that feeds the damage table feeds the healing one.
 */
describe('healing by ability', () => {
  it('groups healing by spell, largest first', async () => {
    const res = await run(
      'heals.txt',
      makeLog({
        format: 'forever',
        playerDamage: [1000, 1100, 1200, 1300, 1400],
        heals: [
          { amount: 600 },
          { amount: 400 },
          { spell: 'Renew', spellId: 139, amount: 300 },
        ],
      }),
    );

    const bag = res.sessions[0]!.open;
    expect(bag.healingDone).toBe(1300);
    expect(bag.topHealing.map((a) => a.name)).toEqual(['Flash Heal', 'Renew']);
    expect(bag.topHealing[0]!.amount).toBe(1000);
    expect(bag.topHealing[0]!.hits).toBe(2);
    expect(bag.topHealing[1]!.amount).toBe(300);
  });

  it('keeps damage and healing apart', async () => {
    const res = await run(
      'both.txt',
      makeLog({
        format: 'forever',
        playerDamage: [1000, 1100, 1200, 1300, 1400],
        heals: [{ amount: 500 }],
      }),
    );
    const bag = res.sessions[0]!.open;
    expect(bag.damageDone).toBe(6000);
    expect(bag.healingDone).toBe(500);
    // healing spells must never leak into the damage table
    expect(bag.topAbilities.map((a) => a.name)).not.toContain('Flash Heal');
    expect(bag.topHealing.map((a) => a.name)).toEqual(['Flash Heal']);
  });
});

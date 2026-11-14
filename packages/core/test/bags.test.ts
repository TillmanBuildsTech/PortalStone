import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest, type IngestResult } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-bag-'));

async function run(name: string, text: string): Promise<Extract<IngestResult, { ok: true }>> {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`expected ok ingest, got ${res.reason}: ${res.detail}`);
  return res;
}

/**
 * A bag drop is the only sleeping-bag event in the log: the "Unroll Bag" cast. Everything else
 * about a bag — who shared it, who benefited — is inference and is deliberately not modelled.
 */
describe('bag drops', () => {
  it('records the drop with its owner, zone and position', async () => {
    const res = await run(
      'bag-basic.txt',
      makeLog({
        format: 'forever',
        playerDamage: [1000, 1100, 1200, 1300, 1400],
        bag: { zone: 'The Barrens' },
      }),
    );

    expect(res.bagDrops).toHaveLength(1);
    const drop = res.bagDrops[0]!;
    expect(drop.name).toBe('Slouch');
    expect(drop.mine).toBe(true);
    expect(drop.zoneName).toBe('The Barrens');
    expect(drop.x).toBeCloseTo(-1200.5, 1);
    expect(drop.y).toBeCloseTo(250.5, 1);
    expect(drop.map).toBe('1456');
  });

  it('ignores camp buffs: a buff is not a bag', async () => {
    // These lines are all over a real log — ~10,000 in one evening — and none of them is a drop.
    const res = await run(
      'bag-buffs.txt',
      makeLog({
        format: 'forever',
        playerDamage: [1000, 1100, 1200, 1300, 1400],
        bag: { guests: ['Near-Camper-PvP-US', 'Other-Camper-PvP-US'] },
      }),
    );
    expect(res.bagDrops).toHaveLength(1);
    expect(res.bagDrops.map((d) => d.name)).not.toContain('Near-Camper-PvP-US');
    expect(res.unrecognised).toBe(0);
  });

  it('reports no drops for a log with no bags', async () => {
    const res = await run(
      'bag-none.txt',
      makeLog({ format: 'forever', playerDamage: [1000, 1100, 1200, 1300, 1400] }),
    );
    expect(res.bagDrops).toHaveLength(0);
  });
});

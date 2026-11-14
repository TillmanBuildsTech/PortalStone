import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-ranks-'));

/**
 * Spell ranks are invisible by name and real by id: "Holy Light" is 647 (rank 3), 1026 and 1042
 * (rank 5) in this log, with no rank number written anywhere. Counting casts per id is the only
 * way to answer "how often did I cast rank 3".
 */
describe('casts by spell rank', () => {
  it('keeps each rank of one spell as its own cast count', async () => {
    const path = join(DIR, 'ranks.txt');
    writeFileSync(
      path,
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        playerDamage: [100, 110, 120, 130, 140],
        castSpells: [
          { id: 647, name: 'Holy Light', count: 4 },
          { id: 1042, name: 'Holy Light', count: 2 },
          { id: 133, name: 'Fireball', count: 1 },
        ],
      }),
    );
    const res = await ingest({ path });
    if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);

    const casts = res.sessions[0]!.open.topCasts;
    expect(casts.map((c) => [c.name, c.id, c.casts])).toEqual([
      ['Holy Light', 647, 4],
      ['Holy Light', 1042, 2],
      ['Fireball', 133, 1],
    ]);
    // the total still adds up, so rank detail is additive information, not a replacement
    expect(res.sessions[0]!.open.casts).toBe(7);
  });

  it('keeps rank casts with the zone they were cast in', async () => {
    const path = join(DIR, 'rank-zones.txt');
    writeFileSync(
      path,
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        zone1Casts: 1,
        zone2: { id: 47, name: 'Razorfen Kraul' },
        zone2Damage: [100, 100, 100, 100, 100],
        castSpells: [{ id: 647, name: 'Holy Light', count: 3 }],
      }),
    );
    const res = await ingest({ path });
    if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
    const dungeon = res.sessions[0]!.zones.find((z) => z.name === 'Razorfen Kraul')!;
    expect(dungeon.topCasts).toEqual([{ id: 647, name: 'Holy Light', casts: 3 }]);
  });
});

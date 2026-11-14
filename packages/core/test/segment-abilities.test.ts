import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-seg-'));

/**
 * Drilling into one zone visit ("what did I do in Razorfen Kraul?") needs the ability breakdown at
 * segment grain, not just session grain. The aggregator already writes every event into the zone
 * segment bag as a second sink; these tests pin that down, because the store and the UI both rely
 * on it and a regression here would silently show session-wide numbers under a single run.
 */
describe('per-segment ability breakdown', () => {
  it('attributes damage dealt in a zone to that zone, not the session', async () => {
    const path = join(DIR, 'zones.txt');
    writeFileSync(
      path,
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        zone1Casts: 1,
        zone2: { id: 47, name: 'Razorfen Kraul' },
        zone2Damage: [100, 100, 100],
        zone3: { id: 1, name: 'The Barrens' },
        playerDamage: [700, 300],
        ability: { name: 'Judgement of Fury', id: 20183 },
        zone2Ability: { name: 'Consecration', id: 26573 },
      }),
    );

    const res = await ingest({ path });
    if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
    const zones = res.sessions[0]!.zones;
    expect(zones.map((z) => z.name)).toEqual(['The Barrens', 'Razorfen Kraul', 'The Barrens']);

    const dungeon = zones[1]!;
    expect(dungeon.damageDone).toBe(300);
    expect(dungeon.topAbilities.map((a) => a.name)).toEqual(['Consecration']);
    expect(dungeon.topAbilities[0]!.hits).toBe(3);

    // ...and the session total is still the sum of its parts, with both abilities listed.
    const open = res.sessions[0]!.open;
    expect(open.damageDone).toBe(1300);
    expect(open.topAbilities.map((a) => a.name).sort()).toEqual(['Consecration', 'Judgement of Fury']);
  });

  it('keeps healing cast in a zone with that zone', async () => {
    const path = join(DIR, 'heal-zone.txt');
    writeFileSync(
      path,
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        zone1Casts: 1,
        playerDamage: [100, 100, 100, 100, 500],
        heals: [{ amount: 400, spell: 'Flash Heal' }],
      }),
    );

    const res = await ingest({ path });
    if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
    const zone = res.sessions[0]!.zones[0]!;
    expect(zone.healingDone).toBe(400);
    expect(zone.topHealing[0]!.name).toBe('Flash Heal');
  });
});

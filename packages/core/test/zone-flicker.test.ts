import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest, type IngestResult } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-noise-'));

async function run(name: string, text: string): Promise<Extract<IngestResult, { ok: true }>> {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`expected ok ingest, got ${res.reason}: ${res.detail}`);
  return res;
}

/**
 * The client emits ZONE_CHANGE as you cross an instance portal, and will report the outside zone
 * for a minute while nothing at all happens. Left alone, a live dungeon run read as
 * "Barrens -> RFK -> Barrens -> RFK", as if the player kept leaving.
 */
describe('portal flicker', () => {
  const flicker = makeLog({
    format: 'forever',
    zone: { id: 1, name: 'The Barrens' },
    zone1Casts: 5,
    zone2: { id: 1, name: 'Razorfen Kraul' },
    zone3: { id: 1, name: 'The Barrens' },
    playerDamage: [1000, 1100, 1200, 1300, 1400],
  });

  it('drops an empty zone segment that flips straight back', async () => {
    const res = await run('flicker.txt', flicker);
    const zones = res.sessions[0]!.zones;
    // Barrens (casts) -> RFK (nothing) -> Barrens (damage) collapses to one visit.
    expect(zones.map((z) => z.name)).toEqual(['The Barrens']);
    expect(res.sessions[0]!.zones[0]!.damageDone).toBe(6000);
  });

  it('keeps a segment that has activity, however short', async () => {
    // Same flicker, but the middle zone sees damage: that is a real visit and stays.
    const res = await run(
      'flicker-real.txt',
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'The Barrens' },
        zone1Casts: 5,
        zone2: { id: 1, name: 'Razorfen Kraul' },
        zone2Damage: [900],
        zone3: { id: 1, name: 'The Barrens' },
        playerDamage: [1000, 1100, 1200, 1300, 1400],
      }),
    );
    const zones = res.sessions[0]!.zones;
    // Three real visits: out, in with damage of its own, and back out for the last pull.
    expect(zones.map((z) => z.name)).toEqual(['The Barrens', 'Razorfen Kraul', 'The Barrens']);
    expect(zones[1]!.damageDone).toBe(900);
  });
});

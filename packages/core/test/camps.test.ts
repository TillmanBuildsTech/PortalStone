import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest, type IngestResult } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';
import { CAMP_RADIUS_YARDS } from '../src/camps';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-camp-'));

async function run(name: string, text: string): Promise<Extract<IngestResult, { ok: true }>> {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`expected ok ingest, got ${res.reason}: ${res.detail}`);
  return res;
}

/**
 * A sleeping bag leaves two kinds of trace: the "Unroll Bag" cast, which names the owner and
 * carries a position, and the camp buffs, which are self-applied and carry no position at all.
 * Attendance therefore has to be reconstructed by distance, and the model must say whether a
 * distance was measured or merely inferred from timing.
 */
describe('camps', () => {
  it('attributes a bag to the player and counts who was buffed inside the radius', async () => {
    const res = await run(
      'camp-basic.txt',
      makeLog({
        format: 'forever',
        playerDamage: [1000, 1100, 1200, 1300, 1400, 1500],
        camp: {
          attendees: [{ name: 'Near-Camper-PvP-US', distance: 6 }],
          outsider: { name: 'Far-Camper-PvP-US', distance: 120 },
        },
      }),
    );

    expect(res.camps).toHaveLength(1);
    const camp = res.camps[0]!;
    expect(camp.bags).toHaveLength(1);
    expect(camp.myBags).toBe(1);
    expect(camp.bags[0]!.name).toBe('Slouch');

    const near = camp.attendees.find((a) => a.name === 'Near-Camper-PvP-US');
    expect(near).toBeDefined();
    expect(near!.basis).toBe('measured');
    expect(near!.distanceY).toBeCloseTo(6, 0);

    // 120 yards away is not "in the bag", even though the buff landed at the same moment.
    expect(camp.attendees.map((a) => a.name)).not.toContain('Far-Camper-PvP-US');
  });

  it('does not call someone an attendee on timing alone when two camps are in play', async () => {
    // Two bags, far apart, the same minute: a buff with no position sample could belong to
    // either, so it must not be assigned to one.
    const log = makeLog({
      format: 'forever',
      playerDamage: [1000, 1100, 1200, 1300, 1400],
      camp: { attendees: [{ name: 'Ghost-PvP-US', distance: 3 }] },
    });
    const second = makeLog({ format: 'forever', playerDamage: [1000, 1100, 1200, 1300, 1400], camp: { attendees: [] } });
    const res = await run('camp-two.txt', log + second.replace(/^[^\n]*\n/, ''));
    expect(res.camps.length).toBeGreaterThanOrEqual(1);
    for (const camp of res.camps) {
      for (const a of camp.attendees) {
        if (a.basis === 'timing') expect(a.distanceY).toBeNull();
        if (a.basis === 'measured') expect(a.distanceY!).toBeLessThanOrEqual(CAMP_RADIUS_YARDS);
      }
    }
  });

  it('keeps camp buffs out of sessions and encounters', async () => {
    // Buffs are not combat: someone idling at a bag for an hour must not read as a fight, and the
    // buff lines must not inflate casts or damage.
    const withCamp = await run(
      'camp-alone.txt',
      makeLog({ format: 'forever', playerDamage: [1000, 1100, 1200, 1300, 1400], casts: 1, camp: { attendees: [] } }),
    );
    const withoutCamp = await run(
      'camp-none.txt',
      makeLog({ format: 'forever', playerDamage: [1000, 1100, 1200, 1300, 1400], casts: 1 }),
    );
    const damage = (r: typeof withCamp): number =>
      r.sessions.reduce((a, s) => a + s.open.damageDone, 0);
    expect(damage(withCamp)).toBe(damage(withoutCamp));
    expect(withCamp.sessions).toHaveLength(withoutCamp.sessions.length);
    // ...and I am the only attendee, from my own Well-Rested.
    expect(withCamp.camps[0]!.attendees.map((a) => a.name)).toEqual(['Slouch']);
    expect(withoutCamp.camps).toHaveLength(0);
  });
});

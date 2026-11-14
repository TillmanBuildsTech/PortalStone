import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ingest, type IngestResult } from '../src/combatlog/ingest';
import { makeLog, type MakeLogOptions } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-test-'));

function file(name: string, text: string): string {
  const p = join(DIR, name);
  writeFileSync(p, text);
  return p;
}

function totalDamage(res: IngestResult): number {
  if (!res.ok) throw new Error(`expected ok ingest, got ${res.reason}: ${res.detail}`);
  return res.sessions.reduce(
    (a, s) => a + s.open.damageDone + s.encounters.reduce((b, e) => b + e.damageDone, 0),
    0,
  );
}

const ENCOUNTER = { id: 1234, name: 'Ragnaros', difficulty: 4, size: 20, success: true };

const BASE: MakeLogOptions = {
  zone: { id: 1456, name: 'Orgrimmar' },
  encounter: ENCOUNTER,
  playerDamage: [1000, 2000, 3000, 4000, 5000, 6000],
  bossDamage: [500, 700],
  casts: 3,
  interrupts: 2,
  misses: ['DODGE', 'MISS'],
  mobKills: 1,
  playerDeath: true,
};

describe('ingest — the same numbers regardless of field layout', () => {
  const layouts: [string, MakeLogOptions][] = [
    ['infoGUID + 19-field stat block', { infoGuid: true, statBlock: 19 }],
    ['infoGUID + 10-field stat block', { infoGuid: true, statBlock: 10 }],
    ['infoGUID, no stat block', { infoGuid: true, statBlock: 0 }],
    ['no infoGUID, no stat block (classic shape)', { infoGuid: false, statBlock: 0 }],
  ];

  for (const [label, layout] of layouts) {
    it(`parses ${label}`, async () => {
      const path = file(`layout-${label.replace(/\W+/g, '-')}.txt`, makeLog({ ...BASE, ...layout }));
      const res = await ingest({ path });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.infoGuid).toBe(layout.infoGuid ?? true);
      expect(res.selfName).toBe('Slouch');
      expect(res.selfGuid).toBe('Player-4385-0A1B2C3D');
      expect(res.unparsed).toBe(0);
      expect(res.sessions).toHaveLength(1);

      const enc = res.sessions[0]!.encounters[0]!;
      expect(enc.bossName).toBe('Ragnaros');
      expect(enc.bossId).toBe(1234);
      expect(enc.difficulty).toBe(4);
      expect(enc.size).toBe(20);
      expect(enc.success).toBe(true);

      expect(enc.damageDone).toBe(21000);
      // the prototype reported 0 here on every real log; this is the regression guard
      expect(enc.damageTaken).toBe(1200);
      expect(enc.hits).toBe(6);
      expect(enc.casts).toBe(3);
      expect(enc.interrupts).toBe(2);
      expect(enc.kills).toBe(1);
      expect(enc.deaths).toBe(1);
      expect(enc.myDeaths).toBe(1);
      expect(enc.misses).toEqual(
        expect.arrayContaining([
          ['DODGE', 1],
          ['MISS', 1],
        ]),
      );
      expect(enc.topAbilities[0]!.name).toBe('Fireball');
      expect(enc.topAbilities[0]!.amount).toBe(21000);
      expect(enc.durationS).toBeGreaterThan(0);
    });
  }
});

describe('ingest — time handling', () => {
  it('keeps the log offset instead of discarding it', async () => {
    const path = file('offset.txt', makeLog({ ...BASE, offsetMin: -420 }));
    const res = await ingest({ path });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.offsetMin).toBe(-420);
    expect(res.sessions[0]!.offsetMin).toBe(-420);
  });

  it('infers the year from the rotated filename when lines carry none', async () => {
    const text = makeLog({ ...BASE, year: null });
    const path = file('WoWCombatLog-111224_210000.txt', text);
    const res = await ingest({ path });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(new Date(res.firstMs).getUTCFullYear()).toBe(2024);
  });
});

describe('ingest — refuses rather than lying', () => {
  it('fails with a named reason when no layout fits', async () => {
    const path = file('corrupt.txt', makeLog({ ...BASE, corruptFlags: true }));
    const res = await ingest({ path });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('layout_unknown');
    expect(res.candidates).toHaveLength(12); // 2 header shapes x (3 end-anchored + 3 block-anchored)
    expect(Math.max(...res.candidates.map((c) => c.score))).toBe(0);
    expect(res.detail).toMatch(/matched 0% of/);
  });

  it('says so when a log contains no combat at all', async () => {
    const path = file('empty.txt', makeLog({ header: true, zone: null, encounter: null }));
    const res = await ingest({ path });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no_damage_events');
  });
});

describe('ingest — forever shape (payload after a 19-field unit block)', () => {
  const F: MakeLogOptions = { ...BASE, format: 'forever', swingDamage: [500, 700], swingEvents: 'both' };

  it('calibrates to the block layout and reads the same totals', async () => {
    const path = file('forever.txt', makeLog(F));
    const res = await ingest({ path });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.layout.mode).toBe('afterBlock');
    expect(res.layout.midBlock).toBe(19);
    expect(res.infoGuid).toBe(false);
    expect(res.unparsed).toBe(0);

    const enc = res.sessions[0]!.encounters[0]!;
    expect(enc.damageDone).toBe(22200); // 21000 from spells + 1200 from swings, each counted once
    expect(enc.damageTaken).toBe(1200);
    expect(enc.casts).toBe(3);
    expect(enc.interrupts).toBe(2);
    expect(enc.kills).toBe(1);
    expect(enc.myDeaths).toBe(1);
  });

  for (const mode of ['both', 'roll', 'landed'] as const) {
    it(`counts each swing once when swingEvents=${mode}`, async () => {
      const path = file(
        `swings-${mode}.txt`,
        makeLog({
          format: 'forever',
          header: false,
          zone: null,
          encounter: null,
          swingDamage: [100, 200, 300, 400, 500, 600],
          swingEvents: mode,
        }),
      );
      const res = await ingest({ path });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(totalDamage(res)).toBe(2100);
    });
  }
});

describe('ingest — PvP kills and zone attribution', () => {
  it('counts a player killed by me as a kill, and as a death of that player', async () => {
    const path = file(
      'pvp.txt',
      makeLog({
        format: 'forever',
        zone: { id: 489, name: 'Warsong Gulch' },
        encounter: null,
        playerDamage: [1000, 1000, 1000, 1000, 1000],
        enemyPlayerKills: 1,
      }),
    );
    const res = await ingest({ path });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.sessions[0]!;
    expect(s.open.kills).toBe(1); // the enemy player died to us
    expect(s.open.deaths).toBe(1); // a player died
    expect(s.open.playersDied).toBe(1); // one distinct player
    expect(s.open.myDeaths).toBe(0); // but not us
  });

  it('attributes damage to the zone it happened in, not the last zone visited', async () => {
    const path = file(
      'zones.txt',
      makeLog({
        format: 'forever',
        zone: { id: 1, name: 'Undercity' },
        zone2: { id: 489, name: 'Warsong Gulch' },
        zone1Casts: 1,
        encounter: null,
        playerDamage: [1000, 1000, 1000, 1000, 1000],
      }),
    );
    const res = await ingest({ path });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const zones = res.sessions[0]!.zones;
    const wsg = zones.find((z) => z.name === 'Warsong Gulch');
    expect(wsg).toBeDefined();
    expect(wsg!.damage).toBe(5000);
    expect(wsg!.ms).toBeGreaterThan(0);
    expect(zones.some((z) => z.name === 'Undercity')).toBe(true);
  });
});

describe('ingest — incremental tailing', () => {
  it('resumes at a byte offset without re-reading or duplicating', async () => {
    const path = file('resume.txt', makeLog({ ...BASE, playerDamage: [1000, 1000, 1000], bossDamage: [500, 500] }));
    const first = await ingest({ path });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(totalDamage(first)).toBe(3000);

    appendFileSync(path, makeLog({ ...BASE, playerDamage: [2000, 2000, 2000], bossDamage: [500, 500] }));
    const second = await ingest({ path, startOffset: first.endOffset, layout: first.layout });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // 6000, not 9000: the first pass's bytes were not read again
    expect(totalDamage(second)).toBe(6000);
    expect(second.endOffset).toBeGreaterThan(first.endOffset);
    expect(second.lines).toBeLessThan(first.lines * 2);
  });

  it('leaves a partially written final line for the next run', async () => {
    const full = makeLog({
      header: false,
      zone: null,
      encounter: null,
      playerDamage: [1000, 1500, 2500, 3000, 5000, 7000],
    });
    const cut = full.lastIndexOf('\n');
    const path = file('partial.txt', full.slice(0, cut)); // no trailing newline: last line unfinished

    const first = await ingest({ path });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.partialTail).toBe(true);
    expect(totalDamage(first)).toBe(13000); // 7000 is still in the unfinished line

    appendFileSync(path, '\n');
    // the agent persists the layout, so a one-line tail does not have to re-earn it
    const second = await ingest({ path, startOffset: first.endOffset, layout: first.layout });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(totalDamage(second)).toBe(7000);
    expect(second.partialTail).toBe(false);
  });
});

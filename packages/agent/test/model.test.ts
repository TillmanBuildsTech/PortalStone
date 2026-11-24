import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { genderFromSex, genderIsGuess, isRenderableSlot, raceId } from '../src/model';
import { equippedItemIds, parseDisplayId, refreshDisplayIds } from '../src/displayIds';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-model-'));
const open: Store[] = [];
function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}
afterEach(() => {
  while (open.length) open.pop()!.close?.();
});

describe('race and gender mapping', () => {
  it('maps race tokens to the viewer ids, case- and spacing-insensitively', () => {
    expect(raceId('Human')).toBe(1);
    expect(raceId('NightElf')).toBe(4);
    expect(raceId('night elf')).toBe(4);
    // Undead's locale-independent token is "Scourge"; the display word resolves too.
    expect(raceId('Scourge')).toBe(5);
    expect(raceId('Undead')).toBe(5);
    expect(raceId('Dwarf')).toBe(3);
  });

  it('returns null for an unknown race rather than guessing a body', () => {
    expect(raceId('Pandaren')).toBeNull();
    expect(raceId(null)).toBeNull();
    expect(raceId('')).toBeNull();
  });

  it('turns UnitSex into the viewer gender flag, female 0 / male 1', () => {
    expect(genderFromSex(3)).toBe(0); // female
    expect(genderFromSex(2)).toBe(1); // male
  });

  it('falls back to male when sex was never captured, and says it is a guess', () => {
    expect(genderFromSex(null)).toBe(1);
    expect(genderIsGuess(null)).toBe(true);
    expect(genderIsGuess(1)).toBe(true); // 1 is UnitSex "unknown", not a real answer
    expect(genderIsGuess(2)).toBe(false);
    expect(genderIsGuess(3)).toBe(false);
  });

  it('only renders slots the engine actually draws (no shirt, rings, trinkets, neck, bags)', () => {
    expect(isRenderableSlot(1)).toBe(true); // head
    expect(isRenderableSlot(16)).toBe(true); // main hand
    expect(isRenderableSlot(4)).toBe(false); // shirt — item 154 "Primitive Mantle" lives here
    expect(isRenderableSlot(2)).toBe(false); // neck
    expect(isRenderableSlot(11)).toBe(false); // finger
  });
});

describe('parseDisplayId', () => {
  it('pulls the display id out of the item icon, the number a model engine dresses by', () => {
    expect(parseDisplayId('<item><icon displayId="5194">inv_mace</icon></item>')).toBe(5194);
    expect(parseDisplayId("<icon displayId='8740'>x</icon>")).toBe(8740);
  });

  it('treats a missing or zero display id as none (many items have no model)', () => {
    expect(parseDisplayId('<item><name>Quest Thing</name></item>')).toBeNull();
    expect(parseDisplayId('<icon displayId="0">x</icon>')).toBeNull();
  });
});

describe('equippedItemIds', () => {
  it('dedupes and drops empty slots', () => {
    expect(equippedItemIds([{ id: 36 }, { id: 153 }, { id: 36 }, { id: null }, { id: 0 }])).toEqual([36, 153]);
  });
});

describe('refreshDisplayIds', () => {
  it('resolves, caches, and never asks twice for the same id', async () => {
    const s = store();
    let calls = 0;
    const resolve = async (id: number) => {
      calls++;
      return ({ 36: 5194, 153: 8740 } as Record<number, number>)[id] ?? null;
    };
    const first = await refreshDisplayIds(s, [36, 153], { resolve });
    expect(first.added).toBe(2);
    expect(s.itemDisplayIds([36, 153])).toEqual(new Map([[36, 5194], [153, 8740]]));

    // A second refresh of the same ids hits the cache: the resolver is not called again.
    calls = 0;
    const second = await refreshDisplayIds(s, [36, 153], { resolve });
    expect(calls).toBe(0);
    expect(second.added).toBe(0);
    expect(second.missing).toBe(0);
  });

  it('records an unresolved id as a miss and does not retry it next scan', async () => {
    const s = store();
    let asked: number[] = [];
    const resolve = async (id: number) => {
      asked.push(id);
      return null; // the source has no display id for it
    };
    const first = await refreshDisplayIds(s, [999999], { resolve });
    expect(first.unknown).toBe(1);
    expect(first.missing).toBe(0); // a recorded miss is not "still missing"

    asked = [];
    await refreshDisplayIds(s, [999999], { resolve });
    expect(asked).toEqual([]); // skipped for the miss window, not asked again
  });

  it('leaves a transient failure to be retried, recording neither a value nor a miss', async () => {
    const s = store();
    const resolve = async () => {
      throw new Error('network');
    };
    const res = await refreshDisplayIds(s, [36], { resolve });
    expect(res.failed).toBe(1);
    expect(res.missing).toBe(1); // still unknown, will be tried again
    expect(s.itemDisplayMisses([36], 7 * 24 * 60 * 60 * 1000).size).toBe(0);
  });
});

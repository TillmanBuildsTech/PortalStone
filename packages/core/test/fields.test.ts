import { describe, expect, it } from 'vitest';
import { at, flags, isGuid, isHexFlags, splitFields, unquote } from '../src/combatlog/fields';

describe('splitFields', () => {
  it('splits plain fields', () => {
    expect(splitFields('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quoted names', () => {
    const f = splitFields('133,"Ragnaros, Herald of Flame",4,18000');
    expect(f).toEqual(['133', 'Ragnaros, Herald of Flame', '4', '18000']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(splitFields('1,"he said ""hi""",2')).toEqual(['1', 'he said "hi"', '2']);
  });

  it('keeps empty fields (a nil unit name is a real thing)', () => {
    expect(splitFields('abc,,def')).toEqual(['abc', '', 'def']);
  });

  it('tolerates a trailing comma', () => {
    expect(splitFields('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('field primitives', () => {
  it('reads out-of-range positions as empty instead of undefined', () => {
    expect(at(['a'], 5)).toBe('');
    expect(at(['a'], -1)).toBe('');
  });

  it('recognises guids and flag sets', () => {
    expect(isGuid('Player-4385-0A1B2C3D')).toBe(true);
    expect(isGuid('Creature-0-4385-1234-1-1-1')).toBe(true);
    expect(isGuid('Slouch')).toBe(false);
    expect(isHexFlags('0x0000000000000511')).toBe(true);
    expect(isHexFlags('Player-4385-0A1B2C3D')).toBe(false);
  });

  it('parses hex and decimal flags', () => {
    expect(flags('0x511')).toBe(0x511);
    expect(flags('1297')).toBe(1297);
    expect(flags('')).toBe(0);
  });

  it('strips quotes only when they wrap the whole field', () => {
    expect(unquote('"Ragnaros"')).toBe('Ragnaros');
    expect(unquote('"Ragnaros')).toBe('"Ragnaros');
  });
});

import { describe, expect, it } from 'vitest';
import { isInstance, zoneKind } from '../src/zones';

describe('zoneKind', () => {
  it('labels The Stockade a dungeon, both spellings, though it sits inside Stormwind', () => {
    expect(zoneKind('The Stockade')).toBe('dungeon');
    expect(zoneKind('The Stockades')).toBe('dungeon');
    expect(isInstance(zoneKind('The Stockade'))).toBe(true);
  });

  it('matches the capital as the log writes it, with or without the "City" suffix', () => {
    expect(zoneKind('Stormwind City')).toBe('city');
    expect(zoneKind('Stormwind')).toBe('city');
    expect(zoneKind('Ironforge')).toBe('city');
  });

  it('falls back to a plain zone for anything unlisted', () => {
    expect(zoneKind('Elwynn Forest')).toBe('zone');
    expect(zoneKind(null)).toBe('zone');
    expect(isInstance(zoneKind('Elwynn Forest'))).toBe(false);
  });
});

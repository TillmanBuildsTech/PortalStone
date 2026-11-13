import { describe, expect, it } from 'vitest';
import {
  formatOffset,
  parseTimestamp,
  splitTimestamp,
  yearFromFilename,
} from '../src/combatlog/timestamp';

describe('splitTimestamp', () => {
  it('separates the timestamp from the body on the two-space rule', () => {
    const r = splitTimestamp('11/12/2026 21:00:00.000-07:00  SPELL_DAMAGE,a,b');
    expect(r?.ts).toBe('11/12/2026 21:00:00.000-07:00');
    expect(r?.body).toBe('SPELL_DAMAGE,a,b');
  });

  it('rejects lines with no timestamp', () => {
    expect(splitTimestamp('SPELL_DAMAGE,a,b')).toBeNull();
  });
});

describe('parseTimestamp', () => {
  it('applies the UTC offset instead of discarding it', () => {
    const r = parseTimestamp('11/12/2026 17:27:53.835-7', null);
    // 17:27 local at UTC-7 is 00:27 UTC the next day.
    expect(r?.ms).toBe(Date.UTC(2026, 10, 13, 0, 27, 53, 835));
    expect(r?.offsetMin).toBe(-420);
  });

  it('handles a colon-separated offset', () => {
    const r = parseTimestamp('11/12/2026 17:27:53.835+05:30', null);
    expect(r?.ms).toBe(Date.UTC(2026, 10, 12, 11, 57, 53, 835));
    expect(r?.offsetMin).toBe(330);
  });

  it('falls back to the supplied year when the log has none', () => {
    const r = parseTimestamp('11/12 21:00:00.000', 2026);
    expect(r?.ms).toBe(Date.UTC(2026, 10, 12, 21, 0, 0, 0));
    expect(r?.offsetMin).toBe(0);
  });

  it('uses the year embedded in the date when present', () => {
    const r = parseTimestamp('11/12/2025 21:00:00.000', 2026);
    expect(r?.ms).toBe(Date.UTC(2025, 10, 12, 21, 0, 0, 0));
  });

  it('rejects nonsense', () => {
    expect(parseTimestamp('99/99/2026 21:00:00.000', null)).toBeNull();
    expect(parseTimestamp('11/12/2026 25:00:00.000', null)).toBeNull();
  });
});

describe('yearFromFilename', () => {
  it('reads the MMDDYY stamp Blizzard puts in the rotated filename', () => {
    expect(yearFromFilename('C:/x/WoWCombatLog-111226_172753.txt')).toBe(2026);
    expect(yearFromFilename('/logs/WoWCombatLog-122524_090000.txt')).toBe(2024);
    expect(yearFromFilename('WoWCombatLog.txt')).toBeNull();
  });
});

describe('formatOffset', () => {
  it('renders minutes east of UTC', () => {
    expect(formatOffset(-420)).toBe('-07:00');
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(0)).toBe('+00:00');
  });
});

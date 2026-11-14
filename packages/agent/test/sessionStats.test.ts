import { describe, expect, it } from 'vitest';
import { perHour, perHourLabel, throughputFrom } from '../src/ui/pages/sessionStats';

/**
 * Two bases, because they answer different questions: wall clock is the farming rate ("how much do
 * I get per hour of my evening"), combat time is the efficiency ("how fast am I when actually
 * fighting"). A run that is half travel shows a big gap between them and that gap is information.
 */
describe('kills per hour', () => {
  it('uses wall clock for the farming rate', () => {
    // the Scarlet Monastery run: 84 kills in 37m 1s
    expect(perHour(84, 2221)).toBe(136);
  });

  it('uses combat time for the combat rate', () => {
    // same run, 17m 41s actually fighting
    expect(perHour(84, 1061)).toBe(285);
  });

  it('shows a dash rather than zero when there is no basis', () => {
    expect(perHourLabel(84, 0)).toBe('—');
    expect(perHourLabel(0, 0)).toBe('—');
  });

  it('never divides by zero', () => {
    expect(perHour(5, 0)).toBe(0);
  });

  it('formats a real rate with separators', () => {
    expect(perHourLabel(12345, 3600)).toBe('12,345');
  });
});

describe('throughput basis', () => {
  it('prefers combat time, then activity, then wall clock', () => {
    expect(throughputFrom({ damage_done: 1000, healing_done: 0, engaged_s: 10, duration_s: 100 }).rate).toBe(100);
    expect(
      throughputFrom({ damage_done: 1000, healing_done: 0, engaged_s: 0, active_s: 20, duration_s: 100 }).rate,
    ).toBe(50);
    expect(
      throughputFrom({ damage_done: 1000, healing_done: 0, engaged_s: 0, duration_s: 100 }).rate,
    ).toBe(10);
  });

  it('headlines healing when healing dominated', () => {
    const t = throughputFrom({ damage_done: 100, healing_done: 5000, engaged_s: 10, duration_s: 60 });
    expect(t.kind).toBe('healing');
    expect(t.otherKind).toBe('damage');
  });
});

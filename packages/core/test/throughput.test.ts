import { describe, expect, it } from 'vitest';
import { throughput } from '../src/throughput';

describe('throughput', () => {
  it('headlines healing when healing dominates', () => {
    // the Razorfen Kraul run: 70,003 healing against 30,414 damage
    const t = throughput({ damage: 30414, healing: 70003, engagedS: 1699, activeS: 1800, durationS: 5238 });
    expect(t.kind).toBe('healing');
    expect(t.otherKind).toBe('damage');
    expect(t.total).toBe(70003);
    expect(t.rate).toBe(41);
    expect(t.otherRate).toBe(18);
    expect(t.mixed).toBe(false);
  });

  it('headlines damage when damage dominates', () => {
    const t = throughput({ damage: 5795, healing: 800, engagedS: 600, activeS: 900, durationS: 5999 });
    expect(t.kind).toBe('damage');
    expect(t.total).toBe(5795);
    expect(t.rate).toBe(10);
  });

  it('flags a session where neither side dominates', () => {
    const t = throughput({ damage: 5000, healing: 4800, engagedS: 100, activeS: 100, durationS: 100 });
    expect(t.kind).toBe('damage'); // damage wins ties
    expect(t.mixed).toBe(true);
  });

  it('never divides by zero and falls back through the time bases', () => {
    const none = throughput({ damage: 0, healing: 0, engagedS: 0, activeS: 0, durationS: 0 });
    expect(none.rate).toBe(0);
    expect(none.basisS).toBe(0);
    expect(none.mixed).toBe(false);

    // engaged time missing: use active time
    const active = throughput({ damage: 600, healing: 0, engagedS: 0, activeS: 300, durationS: 3000 });
    expect(active.rate).toBe(2);
    expect(active.basisS).toBe(300);

    // both missing: wall clock
    const wall = throughput({ damage: 60, healing: 0, engagedS: 0, activeS: 0, durationS: 60 });
    expect(wall.rate).toBe(1);
  });
});

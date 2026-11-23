import { describe, expect, it } from 'vitest';
import { sessionCompare, MIN_ZONE } from '../src/ui/pages/sessionCompare';
import type { SessionRow } from '../src/store';

/** A session row with everything zeroed, so each test sets only the fields it cares about. */
function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: 0,
    start_ms: 0,
    end_ms: 0,
    offset_min: 0,
    zone_name: 'Scarlet Monastery',
    duration_s: 100,
    active_s: 100,
    engaged_s: 100,
    damage_done: 0,
    damage_taken: 0,
    healing_done: 0,
    overheal: 0,
    kills: 0,
    field_kills: 0,
    deaths: 0,
    my_deaths: 0,
    players_died: 0,
    casts: 0,
    interrupts: 0,
    character_guid: 'P-1',
    character_name: 'Dead',
    zones: null,
    encounters: 0,
    zones_count: 1,
    ...over,
  };
}

/** A damage session whose rate is exactly `rate` (engaged 100s), in `zone`. */
function dmg(id: number, rate: number, zone = 'Scarlet Monastery'): SessionRow {
  return row({ id, zone_name: zone, damage_done: rate * 100, engaged_s: 100, duration_s: 100 });
}

describe('sessionCompare', () => {
  it('computes median, best and percentile over other same-zone sessions', () => {
    const current = dmg(1, 500);
    const history = [current, dmg(2, 300), dmg(3, 400), dmg(4, 600)];
    const c = sessionCompare(current, history)!;

    expect(c.basis).toBe('zone'); // 3 comparable same-zone others >= MIN_ZONE
    const rate = c.metrics.find((m) => m.key === 'rate')!;
    expect(rate.value).toBe(500);
    expect(rate.median).toBe(400); // sorted [300,400,600] -> index 1
    expect(rate.best).toBe(600);
    expect(rate.percentile).toBeCloseTo(2 / 3); // beats 300 and 400 of three
    // Every other session is a dot, plus this one appended last.
    expect(rate.dots).toHaveLength(4);
    expect(c.currentIndex).toBe(3);
    expect(rate.dots[c.currentIndex]!.value).toBe(500);
  });

  it('falls back to all-sessions when the zone has too little history, and reports both counts', () => {
    const current = dmg(1, 500);
    // Only one other same-zone session; two more in a different zone.
    const history = [current, dmg(2, 400), dmg(3, 450, 'Westfall'), dmg(4, 550, 'Westfall')];
    const c = sessionCompare(current, history)!;

    expect(MIN_ZONE).toBeGreaterThan(1);
    expect(c.basis).toBe('all'); // 1 same-zone < MIN_ZONE
    expect(c.zoneCount).toBe(1);
    expect(c.allCount).toBe(3);
    const rate = c.metrics.find((m) => m.key === 'rate')!;
    expect(rate.dots).toHaveLength(4); // 3 others + this
  });

  it('honours an explicit basis request when that basis has data', () => {
    const current = dmg(1, 500);
    const history = [current, dmg(2, 300), dmg(3, 400), dmg(4, 600), dmg(5, 450, 'Westfall')];

    expect(sessionCompare(current, history, 'all')!.basis).toBe('all');
    // Zone has enough history, so the default is already zone; asking for zone keeps it.
    expect(sessionCompare(current, history, 'zone')!.basis).toBe('zone');
  });

  it('does not let a different kind pollute the rate comparison', () => {
    const current = dmg(1, 500);
    // A healing-led session in the same zone: not comparable to a damage rate.
    const heal = row({ id: 2, healing_done: 90_000, engaged_s: 100 });
    const c = sessionCompare(current, [current, heal, dmg(3, 400), dmg(4, 600), dmg(5, 350)])!;
    const rate = c.metrics.find((m) => m.key === 'rate')!;
    // Three damage others are comparable; the healing session is excluded.
    expect(rate.dots).toHaveLength(4);
  });

  it('scopes nothing by itself — the caller passes one character; still, an empty history yields null', () => {
    const current = dmg(1, 500);
    expect(sessionCompare(current, [current])).toBeNull(); // no other comparable sessions
  });

  it('ranks damage-taken so that less is better', () => {
    const current = row({ id: 1, damage_done: 50_000, damage_taken: 1000, engaged_s: 100 });
    const lessHit = row({ id: 2, damage_done: 50_000, damage_taken: 500, engaged_s: 100 });
    const moreHit = row({ id: 3, damage_done: 50_000, damage_taken: 3000, engaged_s: 100 });
    const alsoMore = row({ id: 4, damage_done: 50_000, damage_taken: 4000, engaged_s: 100 });
    const c = sessionCompare(current, [current, lessHit, moreHit, alsoMore])!;
    const dtps = c.metrics.find((m) => m.key === 'dtps')!;
    expect(dtps.value).toBe(10); // 1000 / 100
    expect(dtps.best).toBe(5); // the lowest dtps is the best
    expect(dtps.percentile).toBeCloseTo(2 / 3); // beats the two that took more
  });
});

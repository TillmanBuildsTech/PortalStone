import { describe, expect, it } from 'vitest';
import { runTrend, MIN_TREND, type RunSample } from '../src/ui/pages/runCompare';

/** A run at day `d` (ms) with rate `rate`; ids just count up so links stay distinct. */
function sample(d: number, rate: number, id = d): RunSample {
  return { startMs: d * 86_400_000, rate, id };
}

describe('runTrend: percentile', () => {
  it('ranks this run against the other runs here', () => {
    const current = sample(10, 300);
    const others = [sample(1, 100), sample(2, 200), sample(3, 400), sample(4, 500)];
    // beats 100 and 200 of four → 50%.
    expect(runTrend(current, others).percentile).toBeCloseTo(0.5);
  });

  it('is null when there is nothing to rank against', () => {
    expect(runTrend(sample(1, 300), []).percentile).toBeNull();
  });

  it('ignores other runs with no rate, rather than counting them as beaten', () => {
    const t = runTrend(sample(5, 300), [sample(1, 0), sample(2, 100)]);
    // Only the 100 run is rankable; this run beats it → 100%.
    expect(t.percentile).toBe(1);
  });
});

describe('runTrend: direction over time', () => {
  it('claims no trend below the minimum history', () => {
    const others = Array.from({ length: MIN_TREND - 2 }, (_, i) => sample(i + 1, 100));
    expect(runTrend(sample(99, 100), others).trend).toBeNull();
  });

  it('reads rising rates over time as speeding up', () => {
    // Earlier runs slow, later runs fast; this run (day 99) is the newest and fast.
    const others = [
      sample(1, 100),
      sample(2, 110),
      sample(3, 105),
      sample(4, 300),
      sample(5, 320),
    ];
    const t = runTrend(sample(99, 330), others);
    expect(t.trend?.direction).toBe('up');
    expect(t.trend!.laterMedian).toBeGreaterThan(t.trend!.earlierMedian);
  });

  it('reads falling rates as slowing down', () => {
    const others = [
      sample(1, 320),
      sample(2, 300),
      sample(3, 310),
      sample(4, 110),
      sample(5, 100),
    ];
    const t = runTrend(sample(99, 95), others);
    expect(t.trend?.direction).toBe('down');
  });

  it('calls a small wobble flat rather than inventing a trend', () => {
    const others = [
      sample(1, 200),
      sample(2, 205),
      sample(3, 198),
      sample(4, 202),
      sample(5, 203),
    ];
    const t = runTrend(sample(99, 201), others);
    expect(t.trend?.direction).toBe('flat');
  });

  it('orders the series oldest-first and marks this run as current and last', () => {
    const others = [sample(3, 100), sample(1, 100), sample(2, 100), sample(5, 100), sample(4, 100)];
    const t = runTrend(sample(10, 150), others);
    const times = t.series.map((p) => p.startMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const last = t.series[t.series.length - 1]!;
    expect(last.isCurrent).toBe(true);
    expect(t.series.filter((p) => p.isCurrent)).toHaveLength(1);
  });

  it('does not let one lucky run tip the direction, because each half is a median', () => {
    // A single huge spike among otherwise flat runs must not read as a trend: the median of its
    // half ignores it. Six runs → halves of three; every other run is 100.
    const others = [
      sample(1, 100),
      sample(2, 9999), // the spike, in the earlier half
      sample(3, 100),
      sample(4, 100),
      sample(5, 100),
    ];
    const t = runTrend(sample(6, 100), others);
    expect(t.trend?.direction).toBe('flat');
  });
});

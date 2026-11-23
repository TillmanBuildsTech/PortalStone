/**
 * Where a run sits among your other runs of the same zone, and which way they are trending.
 *
 * The run page already shows this run's rate against your median and best here; this adds the two
 * things that number alone cannot say. First, a percentile — "faster than 80% of them" reads at a
 * glance where "above median" does not. Second, a trend: a farmer's real question is not just "was
 * this a good run" but "am I getting better at this place", which only the clock can answer.
 *
 * Pure and testable: it takes rates paired with their start times and returns numbers, no HTML.
 * `renderRun` turns the result into the section.
 */

export interface RunSample {
  /** segment start, for ordering in time and for the chart's x axis */
  startMs: number;
  /** throughput rate (dps or hps) for the run */
  rate: number;
  /** segment id, so a bar can link back to that run */
  id: number;
}

export interface TrendPoint extends RunSample {
  /** the run being viewed, highlighted in the chart */
  isCurrent: boolean;
}

export interface RunTrend {
  /** fraction of your OTHER runs here this run beats on rate, or null when there are none to rank */
  percentile: number | null;
  /** every comparable run here including this one, oldest first — one bar each */
  series: TrendPoint[];
  /**
   * The direction over time, or null when there is too little history to claim one. Earlier and
   * later are the medians of the first and last halves, so one lucky run does not read as a trend.
   */
  trend: {
    direction: 'up' | 'down' | 'flat';
    earlierMedian: number;
    laterMedian: number;
    /** signed relative change, later vs earlier */
    rel: number;
  } | null;
}

/** Below this many comparable runs (this one included) a trend is noise, not a direction. */
export const MIN_TREND = 6;

/** Within this relative band the two halves are the same: a trend has to actually move to count. */
const FLAT_BAND = 0.08;

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function runTrend(current: RunSample, others: RunSample[]): RunTrend {
  const otherRates = others.map((o) => o.rate).filter((r) => Number.isFinite(r) && r > 0);
  const beats = otherRates.filter((r) => current.rate > r).length;
  const percentile = otherRates.length ? beats / otherRates.length : null;

  const series: TrendPoint[] = [
    ...others.map((o) => ({ ...o, isCurrent: false })),
    { ...current, isCurrent: true },
  ]
    .filter((p) => Number.isFinite(p.rate) && p.rate > 0)
    .sort((a, b) => a.startMs - b.startMs);

  let trend: RunTrend['trend'] = null;
  if (series.length >= MIN_TREND) {
    const rates = series.map((p) => p.rate);
    // Symmetric halves: with an odd count the middle run belongs to neither, so a single run in the
    // middle cannot tip the comparison.
    const half = Math.floor(rates.length / 2);
    const earlierMedian = median([...rates.slice(0, half)].sort((a, b) => a - b));
    const laterMedian = median([...rates.slice(rates.length - half)].sort((a, b) => a - b));
    const rel = earlierMedian > 0 ? (laterMedian - earlierMedian) / earlierMedian : 0;
    const direction = rel > FLAT_BAND ? 'up' : rel < -FLAT_BAND ? 'down' : 'flat';
    trend = { direction, earlierMedian, laterMedian, rel };
  }

  return { percentile, series, trend };
}

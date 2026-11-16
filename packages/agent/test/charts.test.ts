import { describe, expect, it } from 'vitest';
import { columnChart, distribution, meter, pieChart, timelineChart } from '../src/ui/charts';

/**
 * The charts are strings, so their geometry is testable: a bar that does not scale with its value
 * is a bug you can assert on, not something to eyeball in a browser.
 */
describe('columnChart', () => {
  const data = [
    { label: '10/01', value: 100, kind: 'damage', href: '/session?id=1' },
    { label: '10/02', value: 300, kind: 'healing', href: '/session?id=2' },
    { label: '10/03', value: 200, kind: 'damage', href: '/session?id=3' },
  ];

  it('draws one bar per datum, linked to its session', () => {
    const svg = columnChart(data);
    expect(svg.match(/<rect[^>]*fill="#/g)?.length).toBe(3);
    expect(svg).toContain('href="/session?id=1"');
    expect(svg).toContain('href="/session?id=3"');
  });

  it('scales the tallest bar to the plot height and keeps ratios between bars', () => {
    const svg = columnChart(data);
    const heights = [
      ...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)"\s+rx="[^"]*" fill="#/g),
    ].map((m) => Number(m[1]));
    expect(heights).toHaveLength(3);
    expect(heights[1]).toBeCloseTo(heights[0]! * 3, 0);
    expect(heights[2]).toBeCloseTo(heights[1]! * (2 / 3), 0);
  });

  it('survives a value of zero without a NaN in the markup', () => {
    const svg = columnChart([{ label: 'x', value: 0 }]);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });

  it('says so when there is nothing to chart', () => {
    expect(columnChart([])).toContain('Nothing to chart yet');
  });

  it('escapes labels rather than injecting markup', () => {
    const svg = columnChart([{ label: '<script>alert(1)</script>', value: 5 }]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('timelineChart', () => {
  const items = [
    { label: 'The Barrens', start: 0, end: 60_000, kind: 'zone' },
    { label: 'Razorfen Kraul', start: 60_000, end: 240_000, kind: 'dungeon', href: '/run?id=9' },
  ];

  it('positions and sizes bars by clock time', () => {
    const svg = timelineChart(items, { from: 0, to: 300_000, width: 1000 });
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)];
    expect(rects).toHaveLength(2);
    const [first, second] = rects.map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    // the dungeon is 180s of a 300s session: three times the first visit, starting twice as far in
    expect(second!.w).toBeCloseTo(first!.w * 3, 0);
    expect(second!.x - first!.x).toBeCloseTo(first!.w, 0);
    expect(svg).toContain('href="/run?id=9"');
  });

  it('clamps a visit that runs past the window instead of drawing outside it', () => {
    const svg = timelineChart([{ label: 'late', start: 200_000, end: 900_000 }], { from: 0, to: 300_000, width: 1000 });
    expect(svg).not.toContain('NaN');
    expect(svg).not.toMatch(/width="-[0-9]/);
  });

  it('renders nothing but a message for an empty session', () => {
    expect(timelineChart([], { from: 0, to: 1 })).toContain('No activity recorded');
  });
});

describe('distribution', () => {
  it('highlights the current run and keeps every dot inside the track', () => {
    const html = distribution([{ value: 10 }, { value: 20 }, { value: 30 }], { current: 2 });
    const lefts = [...html.matchAll(/left:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(lefts).toHaveLength(3);
    expect(Math.max(...lefts)).toBeLessThanOrEqual(100);
    expect(html).toContain('dot you');
  });

  it('returns an empty string when there is nothing to compare', () => {
    expect(distribution([])).toBe('');
    expect(distribution([{ value: 0 }])).toBe('');
  });
});

describe('meter', () => {
  it('clamps out-of-range shares', () => {
    expect(meter(2)).toContain('width:100.0%');
    expect(meter(-1)).toContain('width:0.0%');
  });
});

describe('pieChart', () => {
  const data = [
    { label: 'Razorfen Kraul', value: 60 },
    { label: 'The Barrens', value: 30 },
    { label: 'Stormwind', value: 10 },
  ];

  it('draws one slice and one legend row per positive datum', () => {
    const svg = pieChart(data);
    expect(svg.match(/class="slice"/g)).toHaveLength(3);
    expect(svg.match(/class="pie-label"/g)).toHaveLength(3);
    expect(svg).toContain('Razorfen Kraul');
  });

  it('labels shares that add up to 100%', () => {
    const svg = pieChart(data);
    const shares = [...svg.matchAll(/· ([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(shares).toHaveLength(3);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
  });

  it('collapses the tail into one "more" slice instead of a spray of wedges', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `z${i}`, value: 9 - i }));
    const svg = pieChart(many, { maxSlices: 4 });
    expect(svg.match(/class="slice"/g)).toHaveLength(4);
    expect(svg).toContain('6 more');
  });

  it('draws a single value as a ring, not an arc from a point back to itself', () => {
    const svg = pieChart([{ label: 'only', value: 5 }]);
    expect(svg.match(/class="slice"/g)).toHaveLength(1);
    expect(svg).toContain('<circle class="slice"');
    expect(svg).not.toContain('NaN');
  });

  it('drops zero and negative values, and says so when nothing is left', () => {
    expect(pieChart([{ label: 'zero', value: 0 }, { label: 'negative', value: -3 }])).toContain(
      'Nothing to chart yet',
    );
    const svg = pieChart([{ label: 'zero', value: 0 }, { label: 'real', value: 4 }]);
    expect(svg.match(/class="slice"/g)).toHaveLength(1);
    expect(svg).not.toContain('zero');
  });

  it('uses the caller formatter for values and the total', () => {
    const svg = pieChart(data, { format: (n) => `${n}g` });
    expect(svg).toContain('100g');
  });

  it('moves the key below the donut on a small card and keeps it inside the height', () => {
    const small = pieChart(data, { width: 300, height: 180 });
    const swatch = small.match(/<rect x="([\d.]+)" y="[\d.]+" width="7" height="7"/);
    expect(swatch).not.toBeNull();
    expect(Number(swatch![1])).toBeLessThan(60); // the below layout starts at the left edge
    const ys = [...small.matchAll(/class="pie-label"[^>]*y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeLessThan(180);

    const wide = pieChart(data, { width: 700, height: 220 });
    const wideSwatch = wide.match(/<rect x="([\d.]+)" y="[\d.]+" width="8" height="8"/);
    expect(Number(wideSwatch![1])).toBeGreaterThan(300); // the key sits beside the donut
    expect(wide).toContain('·');
    expect(small).not.toContain('NaN');
  });

  it('escapes labels rather than injecting markup', () => {
    const svg = pieChart([{ label: '<script>alert(1)</script>', value: 1 }]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

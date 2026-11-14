/**
 * Charts, as strings.
 *
 * The UI has no build step and no JavaScript, so a chart here is inline SVG built from numbers —
 * which means the geometry is testable and nothing can fail at runtime on the client. Two shapes
 * cover everything the app needs:
 *
 *   columnChart    one bar per session, over time        (the headline trend)
 *   timelineChart  one row per zone visit, positioned in the session's wall clock (the drill map)
 *
 * Colour is semantic: damage and healing keep the same two colours everywhere, and zone kinds keep
 * theirs, so a bar reads the same on every page it appears on.
 */
import { compact, esc, share } from './format';

const COLORS: Record<string, string> = {
  damage: '#6ea8fe',
  healing: '#56d364',
  dungeon: '#6ea8fe',
  raid: '#bc8cff',
  battleground: '#ffa657',
  city: '#5b6675',
  zone: '#48525f',
};

export function colorFor(kind: string | undefined): string {
  return (kind && COLORS[kind]) || '#6ea8fe';
}

export interface ColumnDatum {
  label: string;
  value: number;
  /** paints the bar: 'damage', 'healing', or a zone kind */
  kind?: string;
  href?: string;
  /** native tooltip; without it the label and value are shown */
  title?: string;
}

export interface ColumnOptions {
  caption?: string;
  width?: number;
  height?: number;
  /** unit suffix for tooltips, e.g. " dmg" */
  unit?: string;
}

/**
 * Vertical bars, oldest left. Labels thin out rather than overlap, so a hundred sessions still
 * render legibly; the value labels only appear when they fit.
 */
export function columnChart(data: ColumnDatum[], opts: ColumnOptions = {}): string {
  if (data.length === 0) return '<div class="empty">Nothing to chart yet.</div>';
  const W = opts.width ?? 960;
  const H = opts.height ?? 190;
  const top = 18;
  const right = 6;
  const bottom = 22;
  const left = 52;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = plotW / data.length;
  const barW = Math.max(Math.min(slot * 0.72, 44), 1.5);
  const showValues = data.length <= 10;
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));

  const grid = [1, 0.5].map((f) => {
    const y = top + plotH - plotH * f;
    return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" class="grid"/>
      <text x="${left - 8}" y="${(y + 3.5).toFixed(1)}" class="axis-label" text-anchor="end">${esc(compact(max * f))}</text>`;
  });

  const bars = data
    .map((d, i) => {
      const h = Math.max((d.value / max) * plotH, d.value > 0 ? 2 : 0);
      const x = left + i * slot + (slot - barW) / 2;
      const y = top + plotH - h;
      const tip = d.title ?? `${d.label}: ${compact(d.value)}${opts.unit ?? ''}`;
      const fill = colorFor(d.kind);
      const bar = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        rx="${Math.min(2, barW / 2).toFixed(1)}" fill="${fill}" opacity="0.92"><title>${esc(tip)}</title></rect>`;
      const hover = `<rect x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH}"
        fill="transparent"><title>${esc(tip)}</title></rect>`;
      const label =
        i % labelEvery === 0
          ? `<text x="${(left + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" class="axis-label" text-anchor="middle">${esc(d.label)}</text>`
          : '';
      const value =
        showValues && d.value > 0
          ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" class="bar-label" text-anchor="middle">${esc(compact(d.value))}</text>`
          : '';
      const group = `${hover}${bar}${value}${label}`;
      return d.href ? `<a href="${esc(d.href)}">${group}</a>` : `<g>${group}</g>`;
    })
    .join('');

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.caption ?? 'chart')}">
    <title>${esc(opts.caption ?? 'chart')}</title>${grid.join('')}
    <line x1="${left}" y1="${top + plotH}" x2="${W - right}" y2="${top + plotH}" class="baseline"/>
    ${bars}</svg></div>`;
}

export interface TimelineDatum {
  label: string;
  start: number;
  end: number;
  kind?: string;
  href?: string;
  title?: string;
}

export interface TimelineOptions {
  from: number;
  to: number;
  /** log timezone, so the axis reads like the clock in game */
  offsetMin?: number;
  width?: number;
  caption?: string;
}

const TICK_STEPS_MIN = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720];

/**
 * A session as it actually happened: one row per zone visit, positioned and sized by the clock.
 * This is the chart that answers "where did the evening go", and each bar links to that run.
 */
export function timelineChart(items: TimelineDatum[], opts: TimelineOptions): string {
  if (items.length === 0) return '<div class="empty">No activity recorded in this session.</div>';
  const W = opts.width ?? 960;
  const rowH = 24;
  const labelW = Math.min(210, Math.max(120, Math.round(W * 0.22)));
  const top = 22;
  const bottom = 6;
  const right = 8;
  const H = top + items.length * rowH + bottom;
  const plotW = W - labelW - right;
  const from = opts.from;
  const to = Math.max(opts.to, from + 1);
  const span = to - from;
  const pos = (ms: number): number => Math.min(Math.max(share(ms - from, span), 0), 1);

  // Ticks: the smallest step that keeps the axis under eight labels.
  const spanMin = span / 60_000;
  const stepMin = TICK_STEPS_MIN.find((s) => spanMin / s <= 7) ?? TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]!;
  const stepMs = stepMin * 60_000;
  const firstTick = Math.ceil(from / stepMs) * stepMs;
  const ticks: string[] = [];
  for (let t = firstTick; t <= to; t += stepMs) {
    const x = labelW + pos(t) * plotW;
    const d = new Date(t + (opts.offsetMin ?? 0) * 60_000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    ticks.push(
      `<line x1="${x.toFixed(1)}" y1="${top - 4}" x2="${x.toFixed(1)}" y2="${H - bottom}" class="grid"/>
       <text x="${x.toFixed(1)}" y="${top - 8}" class="axis-label" text-anchor="middle">${hh}:${mm}</text>`,
    );
  }

  const rows = items
    .map((it, i) => {
      const y = top + i * rowH;
      const x0 = labelW + pos(it.start) * plotW;
      const x1 = labelW + pos(it.end) * plotW;
      const w = Math.max(x1 - x0, 2.5);
      const tip = it.title ?? `${it.label} · ${compact(Math.max(it.end - it.start, 0) / 1000)}s`;
      const bar = `<rect x="${x0.toFixed(1)}" y="${(y + 5).toFixed(1)}" width="${w.toFixed(1)}" height="${rowH - 10}"
        rx="2.5" fill="${colorFor(it.kind)}" opacity="0.9"><title>${esc(tip)}</title></rect>`;
      const label = `<text x="0" y="${(y + rowH / 2 + 3.5).toFixed(1)}" class="row-label">${esc(truncate(it.label, 26))}</text>`;
      const group = `${label}${bar}`;
      return it.href ? `<a href="${esc(it.href)}">${group}</a>` : `<g>${group}</g>`;
    })
    .join('');

  return `<div class="chart-scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    opts.caption ?? 'session timeline',
  )}" style="min-width:${Math.min(W, 620)}px">
    <title>${esc(opts.caption ?? 'session timeline')}</title>${ticks.join('')}${rows}</svg></div>`;
}

/**
 * One value plotted against its own history: every other run of the same zone is a small dot, this
 * run is the highlighted one. Cheaper to read than a table of rates, and it shows the spread.
 */
export function distribution(
  values: { value: number; title?: string }[],
  opts: { current?: number; format?: (n: number) => string } = {},
): string {
  const finite = values.map((v) => v.value).filter((v) => Number.isFinite(v) && v > 0);
  if (finite.length === 0) return '';
  const max = Math.max(...finite) * 1.04;
  const fmt = opts.format ?? ((n: number) => compact(n));
  const dots = values
    .map((v, i) => {
      const isCurrent = i === (opts.current ?? -1);
      const left = Math.min(share(v.value, max) * 100, 100);
      const tip = v.title ?? fmt(v.value);
      return `<b class="dot${isCurrent ? ' you' : ''}" style="left:${left.toFixed(2)}%" title="${esc(tip)}"></b>`;
    })
    .join('');
  return `<div class="dist"><span class="dist-track"></span>${dots}</div>`;
}

/** Share-of-total bar for a table cell. */
export function meter(fraction: number, kind = 'damage'): string {
  const w = Math.min(Math.max(fraction, 0), 1) * 100;
  return `<span class="meter"><i style="width:${w.toFixed(1)}%;background:${colorFor(kind)}"></i></span>`;
}

export interface LineOptions {
  width?: number;
  height?: number;
  caption?: string;
  /** tooltip formatting, e.g. copper to gold */
  format?: (n: number) => string;
  /** axis label formatting; defaults to `format` but usually wants to be shorter */
  formatAxis?: (n: number) => string;
  /** log timezone for the x labels */
  offsetMin?: number;
  color?: string;
}

/**
 * A tracked property over time.
 *
 * One point per SavedVariables flush, so the line only moves when the game wrote the file. Zero
 * points is an empty state, one point is a value with no trend yet (drawn as a dot, not a flat
 * line that implies history it does not have).
 */
export function lineChart(points: { t: number; value: number }[], opts: LineOptions = {}): string {
  if (points.length === 0) return '<div class="empty">No samples yet. Log out or /reload in game to write the addon\'s SavedVariables.</div>';
  const W = opts.width ?? 960;
  const H = opts.height ?? 170;
  const top = 14;
  const right = 14;
  const bottom = 22;
  const left = 74;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const fmt = opts.format ?? ((n: number) => compact(n));
  const axisFmt = opts.formatAxis ?? fmt;
  const color = opts.color ?? '#56d364';

  const values = points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const spanT = Math.max(t1 - t0, 1);
  const x = (t: number): number => left + (points.length === 1 ? plotW / 2 : ((t - t0) / spanT) * plotW);
  const y = (v: number): number => top + plotH - ((v - min) / span) * plotH;

  const grid = [0, 0.5, 1].map((f) => {
    const v = min + span * f;
    const gy = y(v);
    return `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${W - right}" y2="${gy.toFixed(1)}" class="grid"/>
      <text x="${left - 8}" y="${(gy + 3.5).toFixed(1)}" class="axis-label" text-anchor="end">${esc(axisFmt(v))}</text>`;
  });

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${(top + plotH).toFixed(1)} L${x(t0).toFixed(1)},${(top + plotH).toFixed(1)} Z`;
  const dots = points
    .map(
      (p) =>
        `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${points.length > 60 ? 1.4 : 2.6}"
          fill="${color}"><title>${esc(fmt(p.value))}</title></circle>`,
    )
    .join('');

  const dateLabel = (t: number): string => {
    const d = new Date(t + (opts.offsetMin ?? 0) * 60_000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(
      d.getUTCMinutes(),
    ).padStart(2, '0')}`;
  };
  const xLabels = `<text x="${left}" y="${H - 6}" class="axis-label">${esc(dateLabel(t0))}</text>
    ${points.length > 1 ? `<text x="${W - right}" y="${H - 6}" class="axis-label" text-anchor="end">${esc(dateLabel(t1))}</text>` : ''}`;

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.caption ?? 'tracked value over time')}">
    <title>${esc(opts.caption ?? 'tracked value over time')}</title>
    ${grid.join('')}
    <path d="${area}" fill="${color}" opacity="0.08"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    ${dots}${xLabels}</svg></div>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Formatting for the server-rendered UI.
 *
 * Every page funnels its numbers through here so the same value never reads two ways. Times are
 * rendered in the zone the log was recorded in (offset_min from the timestamp), not the viewer's
 * clock: a session played at 21:00 should say 21:00 even when the machine is in another zone.
 */

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function num(n: number | null | undefined): string {
  return Math.round(n ?? 0).toLocaleString('en-US');
}

/** 1_234 -> "1.2k", 2_345_678 -> "2.3M". For chart labels, where the exact digit is noise. */
export function compact(n: number | null | undefined): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

export function dur(sec: number | null | undefined): string {
  const s = Math.round(sec ?? 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function local(ms: number, offsetMin: number): Date {
  return new Date(ms + offsetMin * 60_000);
}

/** "11/13 21:04" — the session's own wall clock. */
export function when(ms: number | null | undefined, offsetMin = 0): string {
  if (!ms) return '—';
  const d = local(ms, offsetMin);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "21:04" — the axis label for a timeline. */
export function clock(ms: number, offsetMin = 0): string {
  const d = local(ms, offsetMin);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function dayLabel(ms: number, offsetMin = 0): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local(ms, offsetMin).getUTCDay()]!;
}

export function dateLabel(ms: number, offsetMin = 0): string {
  const d = local(ms, offsetMin);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Share of a whole, 0..1, never NaN and never above 1. */
export function share(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.min(Math.max(part / whole, 0), 1);
}

export function pct(part: number, whole: number, digits = 1): string {
  return `${(share(part, whole) * 100).toFixed(digits)}%`;
}

/** "3 hours ago" / "in 2 minutes" — used in page chrome, so it reads as a sentence. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** 241 KB · 1.4 MB — file sizes, where a byte count is noise. */
export function size(bytes: number | null | undefined): string {
  const b = bytes ?? 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/**
 * How a tracked number reads. `copper` is the one that matters today: addons store money in
 * copper, and 152079 means nothing to a player while 15g 20s 79c does.
 */
export function quantity(value: number | null | undefined, unit: string | null | undefined): string {
  const v = value ?? 0;
  if (unit === 'copper') {
    const neg = v < 0;
    const abs = Math.round(Math.abs(v));
    const gold = Math.floor(abs / 10000);
    const silver = Math.floor((abs % 10000) / 100);
    const copper = abs % 100;
    const parts = [gold ? `${gold.toLocaleString('en-US')}g` : '', silver || gold ? `${silver}s` : '', `${copper}c`];
    return `${neg ? '-' : ''}${parts.filter(Boolean).join(' ')}`;
  }
  if (unit === 'seconds') return dur(v);
  return num(v);
}

/** Short form for chart axes: 15.2g reads better than 15g 24s 49c on a tick label. */
export function quantityAxis(value: number | null | undefined, unit: string | null | undefined): string {
  const v = value ?? 0;
  if (unit === 'copper') {
    if (Math.abs(v) >= 10_000_000) return `${Math.round(v / 10_000 / 1000)}kg`;
    const gold = v / 10_000;
    return `${Math.abs(gold) >= 100 ? Math.round(gold) : gold.toFixed(1)}g`;
  }
  if (unit === 'seconds') return dur(v);
  return compact(v);
}

/** A change between two samples, signed, in the metric's own unit. */
export function delta(value: number, unit: string | null | undefined): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  if (value === 0) return '—';
  return `${sign}${quantity(Math.abs(value), unit)}`;
}

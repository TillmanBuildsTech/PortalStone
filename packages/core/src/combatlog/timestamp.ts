/**
 * Combat-log timestamps.
 *
 * Two shapes exist in the wild:
 *   11/12/2026 17:27:53.835-7   (year present, UTC offset present)
 *   11/12 17:27:53.835          (classic-era style: no year, no offset)
 *
 * We keep epoch milliseconds in UTC plus the log's offset, so a session boundary never moves
 * because the log was recorded in a different timezone than the one viewing it. Year inference
 * prefers the filename (`WoWCombatLog-111226_172753.txt` carries MMDDYY) over any constant.
 */

export interface LogTimestamp {
  /** epoch milliseconds, UTC */
  ms: number;
  /** minutes east of UTC that the wall clock in the file represents (e.g. -420 for UTC-7) */
  offsetMin: number;
}

export function yearFromFilename(path: string): number | null {
  const m = /WoWCombatLog-(\d{2})(\d{2})(\d{2})[_-]\d{6}/i.exec(path);
  if (!m) return null;
  const yy = Number(m[3]);
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}

/** Split the timestamp off the front of a line. Returns null for anything that isn't one. */
export function splitTimestamp(line: string): { ts: string; body: string } | null {
  const i = line.indexOf('  ');
  if (i < 8) return null;
  return { ts: line.slice(0, i), body: line.slice(i + 2) };
}

export function parseTimestamp(ts: string, fallbackYear: number | null): LogTimestamp | null {
  const sp = ts.indexOf(' ');
  if (sp < 3) return null;
  const datePart = ts.slice(0, sp);
  const timePart = ts.slice(sp + 1);

  const dp = datePart.split('/');
  if (dp.length < 2 || dp.length > 3) return null;
  const month = Number(dp[0]);
  const day = Number(dp[1]);
  let year: number | null = null;
  if (dp.length === 3) {
    const y = Number(dp[2]);
    year = y < 100 ? 2000 + y : y;
  }
  if (year === null) year = fallbackYear ?? new Date().getUTCFullYear();
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;

  // HH:MM:SS.mmm[offset]
  const dot = timePart.indexOf('.');
  if (dot < 5) return null;
  const hms = timePart.slice(0, dot).split(':');
  if (hms.length !== 3) return null;
  const h = Number(hms[0]);
  const mi = Number(hms[1]);
  const s = Number(hms[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59) || !(s >= 0 && s <= 60)) return null;

  let rest = timePart.slice(dot + 1);
  let ms = 0;
  let frac = '';
  let k = 0;
  while (k < rest.length && rest.charCodeAt(k) >= 48 && rest.charCodeAt(k) <= 57) {
    frac += rest[k];
    k++;
  }
  if (frac.length === 0) return null;
  ms = Math.round(Number(frac.length > 3 ? frac.slice(0, 3) + '.' + frac.slice(3) : frac));
  rest = rest.slice(k);

  let offsetMin = 0;
  if (rest.length > 0) {
    const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(rest);
    if (m) {
      offsetMin = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1);
    } else {
      // unsigned offset, e.g. "17:27:53.8352" per the historical format
      const u = /^(\d{1,2})$/.exec(rest);
      if (!u) return null;
      offsetMin = Number(u[1]) * 60;
    }
  }

  const utc = Date.UTC(year, month - 1, day, h, mi, s, ms) - offsetMin * 60_000;
  if (!Number.isFinite(utc)) return null;
  return { ms: utc, offsetMin };
}

export function formatOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

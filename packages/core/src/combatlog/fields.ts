/**
 * Field-level primitives for combat-log lines.
 *
 * A combat log line is `<timestamp><two spaces><event>,<field>,<field>...` where string fields
 * are double-quoted and internal quotes are doubled ("") — the same convention fight-log
 * parsers have used for years. We split once, by hand, because this runs on ~6M lines per
 * raid night and a generic CSV parser costs more than the parse.
 */

const GUID_RE =
  /^(?:[0-9A-Fa-f]{16}|(?:Player|Creature|Pet|Vehicle|GameObject|Vignette|Cast|Item|Unknown|Corpse)-[0-9A-Za-z\-:]+)$/;

const ZERO_GUID = '0000000000000000';

export function splitFields(body: string): string[] {
  const out: string[] = [];
  const n = body.length;
  let i = 0;
  while (i <= n) {
    let value = '';
    if (body.charCodeAt(i) === 34 /* " */) {
      i++;
      while (i < n) {
        const c = body.charCodeAt(i);
        if (c === 34) {
          if (body.charCodeAt(i + 1) === 34) {
            value += '"';
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        value += body[i];
        i++;
      }
      // tolerate anything between the closing quote and the separator
      while (i < n && body.charCodeAt(i) !== 44) i++;
    } else {
      const start = i;
      while (i < n && body.charCodeAt(i) !== 44) i++;
      value = body.slice(start, i);
    }
    out.push(value);
    if (i >= n) break;
    i++; // skip the separator
    if (i === n) {
      out.push(''); // trailing separator means a trailing empty field
      break;
    }
  }
  return out;
}

/** Trim surrounding whitespace; strip a quoted field's quotes. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.charCodeAt(0) === 34 && t.charCodeAt(t.length - 1) === 34) {
    return t.slice(1, -1);
  }
  return t;
}

export function isGuid(s: string): boolean {
  return GUID_RE.test(s);
}

export function isZeroGuid(s: string): boolean {
  return s === ZERO_GUID || s === '';
}

export function isHexFlags(s: string): boolean {
  return s.length > 2 && (s[0] === '0') && (s[1] === 'x' || s[1] === 'X') && /^0[xX][0-9A-Fa-f]+$/.test(s);
}

/** Numeric parse that returns null instead of 0 for garbage — callers must decide. */
export function num(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Flags are hex in modern logs and decimal in some older ones. */
export function flags(s: string | undefined): number {
  if (s === undefined || s === '') return 0;
  const v = s.trim();
  if (v.startsWith('0x') || v.startsWith('0X')) {
    const n = parseInt(v.slice(2), 16);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Combat-log object affiliation/type bit flags we actually use. */
export const FLAG = {
  MINE: 0x00000001,
  /** a member of your party (5-man grouping) — set on them, never on you (you are MINE) */
  PARTY: 0x00000002,
  /** a member of your raid (the whole battleground team, a 40-man, etc.) — likewise never you */
  RAID: 0x00000004,
  PLAYER: 0x00000400,
  PET: 0x00002000,
} as const;

/**
 * Affiliation that means "grouped with me": a party member or a raid member. The log sets exactly
 * one affiliation bit per unit, and yours is always MINE — so a unit carrying PARTY or RAID is
 * someone you were grouped with, which is the whole basis for knowing who you played with.
 */
export const GROUP_AFFILIATION = FLAG.PARTY | FLAG.RAID;

/** Safe positional read: missing fields read as '' rather than undefined. */
export function at(arr: string[], i: number): string {
  return i >= 0 && i < arr.length ? (arr[i] as string) : '';
}

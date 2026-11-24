import type { InstallInfo } from '../discover';
import type { Store } from '../store';
import type { UpdateState } from '../update';

/** Everything a page needs to render. Passed by reference so scan status is always live. */
export interface LastScan {
  at: number;
  entries: number;
  errors: number;
}

export interface Ctx {
  store: Store;
  installs: InstallInfo[];
  lastScan: LastScan;
  dbPath: string;
  /**
   * The character every page on this request is scoped to, or null for "all of them".
   *
   * Set from `?char=` and validated against the roster, because a stale bookmark must not turn a
   * typo into an empty page: an unknown name falls back to all characters. Pages that add sessions
   * up pass this to the store; a page about one session or one run ignores it, since that already
   * belongs to exactly one character.
   *
   * This is the character's identity key (its guid, or its name when the log never gave one), not
   * its display name: two characters can share a name across realms. Show `characterName`.
   */
  character: string | null;
  /** the scoped character's name as the log writes it, for display */
  characterName: string | null;
  /** the scoped character's guid, which is how addon data that records one is joined to it */
  characterGuid: string | null;
  /** the same character, ready to paste into a query string (`?char=…` or `&char=…`) */
  charQuery: string;
  /**
   * The current request's path and query with `char` stripped, so the header switcher can rebuild
   * a link to this same page under a different character. Absent in unit tests that build a Ctx by
   * hand; the switcher then falls back to the active nav link's href.
   */
  path?: string;
  /**
   * The cached update state, for the "a newer version is available" banner and the diagnostics
   * version line. Absent in unit tests that build a Ctx by hand; the banner is then simply omitted.
   */
  update?: UpdateState;
}

/** The scope fields of a Ctx, from a raw `?char=` value. */
export type CharacterScope = Pick<Ctx, 'character' | 'characterName' | 'characterGuid' | 'charQuery'>;

/**
 * `?char=` resolved against the roster.
 *
 * An unknown name is not an error page: it is a stale link, and showing every character is the
 * honest answer to "show me someone who is not in this database". The value is used in SQL as a
 * bound parameter everywhere, so a hostile query string cannot do more than fail to match.
 *
 * Links carry the identity key; a bookmark from before that carries a name, which still resolves
 * as long as exactly one character has it.
 */
export function resolveScope(store: Store, raw: string | null | undefined): CharacterScope {
  const roster = raw ? store.characters() : [];
  const byName = roster.filter((c) => c.name === raw);
  const row = roster.find((c) => c.key === raw) ?? (byName.length === 1 ? byName[0]! : null);
  return {
    character: row?.key ?? null,
    characterName: row?.name ?? null,
    characterGuid: row?.guid ?? null,
    charQuery: row ? `char=${encodeURIComponent(row.key)}` : '',
  };
}

import type { InstallInfo } from '../discover';
import type { Store } from '../store';

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
   */
  character: string | null;
  /** the same character, ready to paste into a query string (`?char=…` or `&char=…`) */
  charQuery: string;
}

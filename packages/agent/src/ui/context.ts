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
}

/**
 * Read-only discovery of World of Warcraft installs.
 *
 * Never writes to the game directory. Everything here is exists/readdir/stat, and the only paths
 * we ever open for writing live under the app's own data directory.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface SavedVarFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}

export interface AccountInfo {
  name: string;
  dir: string;
  savedVariables: SavedVarFile[];
}

export interface LogInfo {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface FlavorInfo {
  name: string;
  dir: string;
  logs: LogInfo[];
  accounts: AccountInfo[];
}

export interface InstallInfo {
  root: string;
  flavors: FlavorInfo[];
}

/**
 * Where WoW actually lives, as opposed to where the launcher says it does. The `Blizzard/`
 * parent is what this machine uses; the rest are the layouts seen on other people's PCs.
 */
const ROOT_HINTS = [
  'Blizzard/World of Warcraft',
  'World of Warcraft',
  'Games/World of Warcraft',
  'Program Files/World of Warcraft',
  'Program Files (x86)/World of Warcraft',
  'XboxGames/World of Warcraft',
];

function isFlavorDir(entry: string): boolean {
  return /^_.+_$/.test(entry);
}

export function isWowRoot(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && isFlavorDir(e.name));
  } catch {
    return false;
  }
}

export function candidateRoots(extra: string[] = []): string[] {
  const roots = new Set<string>();
  for (const p of extra) roots.add(p);
  const env = process.env.PORTALSTONE_WOW_DIR;
  if (env) roots.add(env);
  // An explicit --install (or env var) means "this install", not "this plus every drive".
  if (roots.size > 0) return [...roots];
  for (let c = 65; c <= 90; c++) {
    const drive = String.fromCharCode(c);
    for (const hint of ROOT_HINTS) roots.add(`${drive}:/${hint}`);
  }
  return [...roots];
}

function listLogs(flavorDir: string): LogInfo[] {
  const dir = join(flavorDir, 'Logs');
  if (!existsSync(dir)) return [];
  const out: LogInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^WoWCombatLog.*\.txt$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      out.push({ path, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch {
      /* file vanished mid-scan; ignore */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listAccounts(flavorDir: string): AccountInfo[] {
  const dir = join(flavorDir, 'WTF', 'Account');
  if (!existsSync(dir)) return [];
  const out: AccountInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const svDir = join(dir, entry.name, 'SavedVariables');
    const files: SavedVarFile[] = [];
    if (existsSync(svDir)) {
      for (const name of readdirSync(svDir)) {
        if (!/\.lua$/i.test(name)) continue;
        try {
          const st = statSync(join(svDir, name));
          if (st.size === 0) continue;
          files.push({ name, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {
          /* ignore */
        }
      }
    }
    files.sort((a, b) => b.bytes - a.bytes);
    out.push({ name: entry.name, dir: join(dir, entry.name), savedVariables: files });
  }
  return out;
}

export function scanFlavor(dir: string): FlavorInfo {
  return {
    name: basename(dir),
    dir,
    logs: listLogs(dir),
    accounts: listAccounts(dir),
  };
}

export function discover(extraRoots: string[] = []): InstallInfo[] {
  const seen = new Set<string>();
  const installs: InstallInfo[] = [];
  for (const root of candidateRoots(extraRoots)) {
    if (!existsSync(root) || seen.has(root.toLowerCase())) continue;
    if (!isWowRoot(root)) continue;
    seen.add(root.toLowerCase());
    const flavors: FlavorInfo[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && isFlavorDir(entry.name)) flavors.push(scanFlavor(join(root, entry.name)));
    }
    installs.push({ root, flavors });
  }
  return installs;
}

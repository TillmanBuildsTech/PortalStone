/**
 * The base SavedVariables adapter.
 *
 * Every addon that persists anything writes one of these files on logout, in Lua source. Rather
 * than hand-writing an adapter per addon before knowing whether its data is any good, this reads
 * *any* of them, reports what properties they expose, and scores which numbers look trackable.
 * A specific adapter (money, levels, quests) becomes a projection over what this page proves.
 *
 * Reads are local, read-only, and cached by (path, size, mtime): a scan every 60s must not re-parse
 * half a megabyte of Lua per request.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSavedVariables, type ParsedGlobal } from '../../core/src/savedvars/lua';
import {
  flatten,
  introspect,
  numericCandidates,
  textCandidates,
  type Introspection,
  type MetricCandidate,
  type ShapeNode,
} from '../../core/src/savedvars/shape';
import type { InstallInfo } from './discover';
import { providerFor, type ProviderNote } from './providers';

/** The addons page reads one flavor only for now: Forever is what this app targets. */
export const ADDONS_FLAVOR = '_forever_';
/** Saved data older than this counts as configured-but-idle rather than in use. */
const IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Beyond this, parse but do not introspect: a 50 MB retail file should not stall a page. */
const INTROSPECT_LIMIT = 12 * 1024 * 1024;
/** Hard stop: nothing sane is 64 MB of Lua table literals. */
const READ_LIMIT = 64 * 1024 * 1024;

export interface AddonFile {
  /** stable id derived from the absolute path: the UI never takes a path from the client */
  id: string;
  path: string;
  file: string;
  flavor: string;
  account: string;
  bytes: number;
  mtimeMs: number;
  known?: ProviderNote;
}

export interface GlobalSummary {
  name: string;
  type: string;
  /** how many distinct paths were found under this global */
  paths: number;
  truncated: boolean;
  numeric: MetricCandidate[];
  texts: ShapeNode[];
}

export type AddonState = 'ok' | 'empty' | 'unparseable' | 'too_large' | 'unreadable';

export interface AddonRead {
  file: AddonFile;
  state: AddonState;
  reason?: string;
  globals: ParsedGlobal[];
  summaries: GlobalSummary[];
  warnings: string[];
  elapsedMs: number;
}

const cache = new Map<string, AddonRead>();

export function fileId(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12);
}

/** Every SavedVariables file on disk, newest first. */
export function listAddons(installs: InstallInfo[]): AddonFile[] {
  const out: AddonFile[] = [];
  for (const install of installs) {
    for (const flavor of install.flavors) {
      for (const account of flavor.accounts) {
        for (const sv of account.savedVariables) {
          const path = join(account.dir, 'SavedVariables', sv.name);
          out.push({
            id: fileId(path),
            path,
            file: sv.name,
            flavor: flavor.name,
            account: account.name,
            bytes: sv.bytes,
            mtimeMs: sv.mtimeMs,
            known: providerFor(sv.name),
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findAddon(installs: InstallInfo[], id: string): AddonFile | undefined {
  return listAddons(installs).find((f) => f.id === id);
}

export type AddonStatus = 'in-use' | 'idle' | 'empty' | 'unreadable' | 'no-data';

export interface AddonEntry {
  /** addon folder name, or the SavedVariables file name without `.lua` */
  name: string;
  file?: AddonFile;
  /** Blizzard's own UI saved-variables: not a user addon, listed separately */
  builtIn: boolean;
  /** a folder with a .toc exists in Interface/AddOns */
  installed: boolean;
  status: AddonStatus;
  lastSavedMs: number | null;
  globals: number;
  trackable: number;
  /** tracked metric labels that read this addon */
  tracked: string[];
  /**
   * Configured in the app: at least one tracked metric reads this addon. Deliberately independent
   * of whether the addon has written anything lately — data freshness is `status`.
   */
  configured: boolean;
}

/**
 * Everything installed or configured in one flavor, with the question "is this actually in use?"
 * answered rather than implied.
 *
 *  - in-use     saved data, flushed within the last week
 *  - idle       saved data, but nothing written for a week: configured, not being played
 *  - empty      the file exists and holds nothing (`X = nil`), so never configured
 *  - unreadable exists and could not be parsed
 *  - no-data    a folder with a .toc but no SavedVariables: installed, never run
 *
 * `configured` is a separate axis: an addon is configured when at least one tracked metric reads
 * from it, whatever the freshness of its file.
 *
 * Sub-addons (`AtlasLootContinued_Data` next to `AtlasLootContinued`) and libraries are folded out
 * of the "no-data" list, because "not configured" would be misleading for a module.
 */
export function listAddonEntries(
  installs: InstallInfo[],
  opts: { flavor?: string; tracked?: { addonFile: string; label: string }[] } = {},
): AddonEntry[] {
  const flavorName = opts.flavor ?? ADDONS_FLAVOR;
  const flavors = installs.flatMap((i) => i.flavors).filter((f) => f.name === flavorName);
  if (flavors.length === 0) return [];

  // Newest SavedVariables file per addon, across every account in the flavor.
  const files = new Map<string, AddonFile>();
  const folders = new Set<string>();
  for (const flavor of flavors) {
    for (const name of flavor.addons) folders.add(name);
    for (const account of flavor.accounts) {
      for (const sv of account.savedVariables) {
        const base = sv.name.toLowerCase().endsWith('.lua') ? sv.name.slice(0, -4) : sv.name;
        const current = files.get(base);
        if (current && current.mtimeMs >= sv.mtimeMs) continue;
        const path = join(account.dir, 'SavedVariables', sv.name);
        files.set(base, {
          id: fileId(path),
          path,
          file: sv.name,
          flavor: flavor.name,
          account: account.name,
          bytes: sv.bytes,
          mtimeMs: sv.mtimeMs,
          // known provider tags are looked up per file name
          ...(providerFor(sv.name) ? { known: providerFor(sv.name)! } : {}),
        });
      }
    }
  }

  // Modules are named after their parent (`AtlasLootContinued_Data`) or share its family prefix
  // (`DBM-GUI` next to `DBM-Core`). Both are installed addons that legitimately have no
  // SavedVariables of their own, so listing them as "not configured" would be wrong.
  const names = [...new Set([...files.keys(), ...folders])];
  const family = (name: string): string => name.split(/[-_.]/)[0]!.toLowerCase();
  const configuredFamilies = new Set([...files.keys()].map(family));
  const isModule = (name: string): boolean =>
    names.some((other) => other !== name && (name.startsWith(`${other}_`) || name.startsWith(`${other}-`))) ||
    configuredFamilies.has(family(name));

  const now = Date.now();
  const entries: AddonEntry[] = [];
  for (const name of names) {
    const file = files.get(name);
    const builtIn = /^Blizzard_/.test(name);
    const installed = folders.has(name);
    let status: AddonStatus = 'no-data';
    let lastSavedMs: number | null = null;
    let globals = 0;
    let trackable = 0;
    if (file) {
      const read = readAddon(file);
      globals = read.summaries.length;
      trackable = read.summaries.reduce((a, s) => a + s.numeric.filter((n) => !n.constant).length, 0);
      if (read.state === 'ok') {
        lastSavedMs = file.mtimeMs;
        status = now - file.mtimeMs <= IDLE_AFTER_MS ? 'in-use' : 'idle';
      } else if (read.state === 'empty') status = 'empty';
      else status = 'unreadable';
    } else if (isModule(name) || /^Lib/i.test(name)) {
      continue; // modules and libraries are installed, but "not configured" says nothing useful
    }
    const trackedLabels = (opts.tracked ?? []).filter((t) => t.addonFile === file?.file).map((t) => t.label);
    entries.push({
      name,
      ...(file ? { file } : {}),
      builtIn,
      installed,
      status,
      lastSavedMs,
      globals,
      trackable,
      tracked: trackedLabels,
      configured: trackedLabels.length > 0,
    });
  }

  const order: Record<AddonStatus, number> = { 'in-use': 0, idle: 1, empty: 2, unreadable: 3, 'no-data': 4 };
  return entries.sort(
    (a, b) =>
      Number(a.builtIn) - Number(b.builtIn) ||
      order[a.status] - order[b.status] ||
      (b.lastSavedMs ?? 0) - (a.lastSavedMs ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Read and introspect one file. Never throws: a broken addon is a page state, not a crash, and the
 * reason is shown with the addon's name so the user knows which addon to blame.
 */
export function readAddon(file: AddonFile): AddonRead {
  const key = `${file.path}\u0000${file.bytes}\u0000${file.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const base: AddonRead = {
    file,
    state: 'ok',
    globals: [],
    summaries: [],
    warnings: [],
    elapsedMs: 0,
  };

  if (file.bytes > READ_LIMIT) {
    return remember(key, { ...base, state: 'too_large', reason: `${(file.bytes / 1e6).toFixed(0)} MB is too large to read` });
  }
  if (file.bytes === 0) {
    return remember(key, { ...base, state: 'empty', reason: 'the file is empty: the addon has not saved anything yet' });
  }

  let text: string;
  try {
    text = readFileSync(file.path, 'utf8');
  } catch (err) {
    return remember(key, { ...base, state: 'unreadable', reason: (err as Error).message });
  }

  const t0 = Date.now();
  const parsed = parseSavedVariables(text);
  const elapsedMs = Date.now() - t0;
  const read: AddonRead = {
    ...base,
    globals: parsed.globals,
    warnings: parsed.warnings,
    elapsedMs,
  };

  if (parsed.globals.length === 0) {
    // `X = nil` is a real thing addons write: valid file, no data kept.
    const nilOnly = parsed.assignments > 0 && parsed.warnings.length === 0;
    read.state = nilOnly ? 'empty' : 'unparseable';
    read.reason = nilOnly
      ? 'the addon saved nothing: its globals are set to nil'
      : (parsed.warnings[0] ?? 'no global assignments found');
    return remember(key, read);
  }

  if (file.bytes > INTROSPECT_LIMIT) {
    read.warnings = [...parsed.warnings, 'file is large: properties were not indexed'];
    return remember(key, read);
  }

  read.summaries = parsed.globals.map((g) => summarise(g));
  return remember(key, read);
}

function summarise(g: ParsedGlobal): GlobalSummary {
  const shape: Introspection = introspect(g.value, { rootName: g.name });
  return {
    name: g.name,
    type: typeof g.value === 'number' ? 'number' : typeof g.value === 'string' ? 'string' : 'table',
    paths: flatten(shape.root).length,
    truncated: shape.truncated,
    numeric: numericCandidates(shape.root, 200),
    texts: textCandidates(shape.root, 60),
  };
}

function remember(key: string, read: AddonRead): AddonRead {
  cache.set(key, read);
  if (cache.size > 24) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return read;
}

/** Test seam: the cache is keyed by mtime, but a test may rewrite a file inside one millisecond. */
export function clearAddonCache(): void {
  cache.clear();
}

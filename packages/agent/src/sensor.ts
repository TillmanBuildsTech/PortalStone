/**
 * Reading what our own addon writes.
 *
 * `addons/PortalstoneSense` exists because the combat log cannot answer four questions the app
 * keeps being asked: what spec is this character, what gear were they wearing, what are their
 * professions, and which lockouts are spent. Everything here is a projection of that one
 * SavedVariables file — `PortalstoneDB` — onto those four answers.
 *
 * The reader is deliberately forgiving. The addon runs on era clients, retail clients and at least
 * one custom server, so a field can be missing because that client does not have the API, not
 * because anything is wrong: absent stays absent, and the page says "not recorded" rather than 0.
 */
import { isTable, type LuaTable, type LuaValue } from '../../core/src/savedvars/lua';
import { resolvePath } from '../../core/src/savedvars/shape';
import { listAddons, readAddon, type AddonFile } from './addons';
import type { InstallInfo } from './discover';
import type { Store } from './store';

export const SENSOR_FILE = 'PortalstoneSense.lua';
export const SENSOR_GLOBAL = 'PortalstoneDB';

export interface SensorTab {
  name: string;
  points: number;
}

export interface SensorSpec {
  /** named specialization when the client has one, otherwise the tree with the most points */
  name: string | null;
  /** `0/31/20` from the talent tabs: the whole answer on a client with no named specs */
  build: string | null;
  points: number | null;
  role: string | null;
  group: number | null;
  updatedMs: number | null;
  tabs: SensorTab[];
}

export interface SensorMeta {
  name: string;
  realm: string | null;
  guid: string | null;
  class: string | null;
  race: string | null;
  faction: string | null;
  guild: string | null;
  level: number | null;
  zone: string | null;
  updatedMs: number | null;
}

export interface SensorGearSlot {
  slot: number;
  id: number | null;
  name: string | null;
  ilvl: number | null;
  quality: number | null;
}

export interface SensorGear {
  ilvl: number | null;
  equipped: number | null;
  slots: SensorGearSlot[];
}

export interface SensorProfession {
  name: string;
  skill: number | null;
  max: number | null;
}

export interface SensorLockout {
  name: string;
  id: number | null;
  difficulty: number | null;
  reset: number | null;
  locked: boolean;
  extended: boolean;
}

export interface SensorGroupMember {
  name: string;
  class: string | null;
  level: number | null;
  role: string | null;
}

export interface SensorHistoryEntry {
  spec: string | null;
  build: string | null;
  points: number | null;
  atMs: number | null;
}

export interface SensorCharacter {
  /** the key the addon used: the character's display name, no realm */
  key: string;
  /** the WTF account folder this character's file came from */
  account: string;
  meta: SensorMeta;
  spec: SensorSpec | null;
  /** paper-doll numbers, only the ones this client could answer */
  stats: Record<string, number>;
  gear: SensorGear | null;
  professions: SensorProfession[];
  lockouts: SensorLockout[];
  played: { total: number | null; atLevel: number | null } | null;
  xp: { level: number | null; current: number | null; max: number | null; rested: number | null } | null;
  money: number | null;
  group: SensorGroupMember[];
  history: SensorHistoryEntry[];
}

export interface SensorRead {
  /** the most recently flushed copy; null when the addon has never been installed */
  file: AddonFile | null;
  /** every account's copy, newest first */
  files: AddonFile[];
  /** accounts whose copy could not be read while another account's could, with the reason */
  skipped: string[];
  state: 'ok' | 'missing' | 'empty' | 'unreadable';
  reason?: string;
  chars: SensorCharacter[];
  warnings: string[];
}

// ------------------------------------------------------------------ reading ---

function get(value: LuaValue | undefined, ...segments: string[]): LuaValue | undefined {
  if (value === undefined) return undefined;
  return resolvePath(value, segments);
}

function str(v: LuaValue | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: LuaValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: LuaValue | undefined): boolean {
  return v === true;
}

/** Epoch seconds in the file, epoch milliseconds everywhere in the app. */
function ms(v: LuaValue | undefined): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 1000);
}

function entries(v: LuaValue | undefined): LuaTable['entries'] {
  return isTable(v) ? v.entries : [];
}

function tableOf(value: LuaValue | undefined, ...segments: string[]): LuaTable | null {
  const v = get(value, ...segments);
  return isTable(v) ? v : null;
}

/** The numbers under one table, for the paper-doll block: names are data, not schema. */
function numericLeaves(value: LuaValue | undefined, ...segments: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of entries(get(value, ...segments))) {
    if (typeof v === 'number' && Number.isFinite(v)) out[String(k)] = v;
  }
  return out;
}

function readSpec(char: LuaValue): SensorSpec | null {
  const spec = tableOf(char, 'spec');
  if (!spec) return null;
  const tabs: SensorTab[] = [];
  for (const [, t] of entries(get(spec, 'tabs'))) {
    if (!isTable(t)) continue;
    const name = str(get(t, 'name'));
    if (!name) continue;
    tabs.push({ name, points: num(get(t, 'points')) ?? 0 });
  }
  return {
    name: str(get(spec, 'name')),
    build: str(get(spec, 'build')),
    points: num(get(spec, 'points')),
    role: str(get(spec, 'role')),
    group: num(get(spec, 'group')),
    updatedMs: ms(get(spec, 'updated')),
    tabs,
  };
}

function readMeta(char: LuaValue, key: string): SensorMeta {
  return {
    // Schema 2 keys characters by name and realm; the display name is the one the addon recorded.
    name: str(get(char, 'meta', 'name')) ?? key,
    realm: str(get(char, 'meta', 'realm')),
    guid: str(get(char, 'meta', 'guid')),
    class: str(get(char, 'meta', 'class')),
    race: str(get(char, 'meta', 'race')),
    faction: str(get(char, 'meta', 'faction')),
    guild: str(get(char, 'meta', 'guild')),
    level: num(get(char, 'meta', 'level')),
    zone: str(get(char, 'meta', 'zone')),
    updatedMs: ms(get(char, 'meta', 'updated')),
  };
}

function readGear(char: LuaValue): SensorGear | null {
  const gear = tableOf(char, 'gear');
  if (!gear) return null;
  const slots: SensorGearSlot[] = [];
  for (const [k, s] of entries(get(gear, 'slots'))) {
    if (!isTable(s)) continue;
    slots.push({
      slot: Number(k),
      id: num(get(s, 'id')),
      name: str(get(s, 'name')),
      ilvl: num(get(s, 'ilvl')),
      quality: num(get(s, 'quality')),
    });
  }
  slots.sort((a, b) => a.slot - b.slot);
  return { ilvl: num(get(gear, 'ilvl')), equipped: num(get(gear, 'equipped')), slots };
}

function readCharacter(key: string, char: LuaValue, account: string): SensorCharacter {
  const professions: SensorProfession[] = [];
  for (const [, p] of entries(get(char, 'professions'))) {
    if (!isTable(p)) continue;
    const name = str(get(p, 'name'));
    if (!name) continue;
    professions.push({ name, skill: num(get(p, 'skill')), max: num(get(p, 'max')) });
  }

  const lockouts: SensorLockout[] = [];
  for (const [, l] of entries(get(char, 'lockouts'))) {
    if (!isTable(l)) continue;
    const name = str(get(l, 'name'));
    if (!name) continue;
    lockouts.push({
      name,
      id: num(get(l, 'id')),
      difficulty: num(get(l, 'difficulty')),
      reset: num(get(l, 'reset')),
      locked: bool(get(l, 'locked')),
      extended: bool(get(l, 'extended')),
    });
  }

  const group: SensorGroupMember[] = [];
  for (const [, g] of entries(get(char, 'group'))) {
    if (!isTable(g)) continue;
    const name = str(get(g, 'name'));
    if (!name) continue;
    group.push({ name, class: str(get(g, 'class')), level: num(get(g, 'level')), role: str(get(g, 'role')) });
  }

  const history: SensorHistoryEntry[] = [];
  for (const [, h] of entries(get(char, 'history'))) {
    if (!isTable(h)) continue;
    history.push({
      spec: str(get(h, 'spec')),
      build: str(get(h, 'build')),
      points: num(get(h, 'points')),
      atMs: ms(get(h, 'at')),
    });
  }

  const played = tableOf(char, 'played');
  const xp = tableOf(char, 'xp');

  return {
    key,
    account,
    meta: readMeta(char, key),
    spec: readSpec(char),
    stats: numericLeaves(char, 'stats'),
    gear: readGear(char),
    professions,
    lockouts,
    played: played ? { total: num(get(played, 'total')), atLevel: num(get(played, 'level')) } : null,
    xp: xp
      ? {
          level: num(get(xp, 'level')),
          current: num(get(xp, 'current')),
          max: num(get(xp, 'max')),
          rested: num(get(xp, 'rested')),
        }
      : null,
    money: num(get(char, 'money')),
    group,
    history: history.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0)),
  };
}

/**
 * Every character the sensor has written, across every account, newest flush first.
 *
 * The addon's SavedVariables are per account, so alts on two Battle.net accounts live in two
 * files. Reading only the newest one made the other account's characters vanish from the page
 * whenever you switched, so each file is read and its characters tagged with the account.
 */
export function readSensor(installs: InstallInfo[]): SensorRead {
  const files = listAddons(installs).filter((f) => f.file.toLowerCase() === SENSOR_FILE.toLowerCase());
  if (files.length === 0) return { file: null, files: [], skipped: [], state: 'missing', chars: [], warnings: [] };

  const chars: SensorCharacter[] = [];
  const warnings: string[] = [];
  const failures: { state: 'empty' | 'unreadable'; reason: string }[] = [];
  for (const file of files) {
    const read = readAddon(file);
    warnings.push(...read.warnings);
    if (read.state === 'empty') {
      failures.push({ state: 'empty', reason: read.reason ?? 'empty' });
      continue;
    }
    if (read.state !== 'ok') {
      failures.push({ state: 'unreadable', reason: `account ${file.account}: ${read.reason ?? read.state}` });
      continue;
    }
    const global = read.globals.find((g) => g.name === SENSOR_GLOBAL);
    if (!global || !isTable(global.value)) {
      failures.push({ state: 'unreadable', reason: `account ${file.account}: the file has no ${SENSOR_GLOBAL} table` });
      continue;
    }
    for (const [key, value] of entries(get(global.value, 'chars'))) {
      if (!isTable(value)) continue;
      chars.push(readCharacter(String(key), value, file.account));
    }
  }

  // listAddons is newest first, so this is the most recent flush of any account.
  const file = files[0]!;
  chars.sort((a, b) => (b.meta.updatedMs ?? 0) - (a.meta.updatedMs ?? 0));
  if (chars.length === 0 && failures.length === files.length) {
    // Nothing usable anywhere: report the worst state, so a broken file is not shown as "empty".
    const bad = failures.find((f) => f.state === 'unreadable') ?? failures[0]!;
    return { file, files, skipped: [], state: bad.state, reason: bad.reason, chars, warnings };
  }
  // One account readable and another broken still shows what can be shown, with the reason kept.
  const skipped = failures.filter((f) => f.state === 'unreadable').map((f) => f.reason);
  return { file, files, skipped, state: 'ok', chars, warnings };
}

// ------------------------------------------------------------- tracked data ---

/**
 * The numbers worth a time series, seeded so a fresh install has a baseline without the user
 * having to hand-pick paths in the browser first.
 *
 * Only three, deliberately: item level and played time are the two axes every benchmark needs and
 * the log cannot supply, and XP is the one that moves while levelling. Everything else the addon
 * writes is a snapshot of the current state, which belongs on the sensor page, not in a chart that
 * would only ever show one point per change.
 */
const SEEDED: { path: string[]; label: (name: string) => string; unit: string }[] = [
  // Labels use the character's name, not the storage key: `Played · Dead`, not the realm too.
  { path: ['chars', '*', 'gear', 'ilvl'], label: (n) => `Item level · ${n}`, unit: 'plain' },
  { path: ['chars', '*', 'played', 'total'], label: (n) => `Played · ${n}`, unit: 'seconds' },
  { path: ['chars', '*', 'xp', 'current'], label: (n) => `XP · ${n}`, unit: 'plain' },
];

/**
 * Seed (or re-enable) the tracked metrics for every character the sensor knows.
 *
 * Returns the labels it added, so a scan can print what appeared instead of doing it silently.
 * `addTrackedMetric` is idempotent, so this is safe to call after every scan: a character added
 * later gets their series the first scan after their first flush.
 */
export function ensureSensorMetrics(store: Store, read: SensorRead): string[] {
  if (read.state !== 'ok') return [];
  const added: string[] = [];
  const keys = new Set(read.chars.map((c) => c.key));
  for (const char of read.chars) {
    for (const seed of SEEDED) {
      const seriesFor = (entity: string) =>
        store.trackedMetrics().find(
          (m) =>
            m.addon_file === SENSOR_FILE &&
            m.entity === entity &&
            m.global_name === SENSOR_GLOBAL &&
            m.path === JSON.stringify(seed.path),
        );
      const label = seed.label(char.meta.name);
      let existing = seriesFor(char.key);
      // Schema 1 keyed a character by name alone; schema 2 adds the realm. When the addon moves a
      // character to its new key, the series seeded under the old one is that character's history,
      // so it follows the character — unless something still answers to the old key, or two
      // characters now carry that name and the old series cannot say which one it was.
      const movable =
        char.key !== char.meta.name &&
        !keys.has(char.meta.name) &&
        read.chars.filter((c) => c.meta.name === char.meta.name).length === 1;
      const legacy = movable ? seriesFor(char.meta.name) : undefined;
      if (!existing && legacy) {
        store.repinTrackedMetric(legacy.id, char.key, label);
        existing = legacy;
      }
      store.addTrackedMetric({
        addonFile: SENSOR_FILE,
        globalName: SENSOR_GLOBAL,
        path: seed.path,
        label,
        unit: seed.unit,
        entity: char.key,
      });
      if (!existing) added.push(label);
    }
  }
  return added;
}

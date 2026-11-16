#!/usr/bin/env node
/**
 * Copy the sensor addon into a World of Warcraft install.
 *
 *   npm run addon:install                     # every install found, every flavor
 *   npm run addon:install -- --install "D:/Blizzard/World of Warcraft"
 *   npm run addon:install -- --dry            # say what it would do, touch nothing
 *
 * The agent itself is strictly read-only towards the game directory: it never writes a log, a
 * SavedVariables file, or a config. This script is the one deliberate exception, it is run by hand,
 * and it writes nothing but the addon's own two files. SavedVariables are the game's to write.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON_DIR = resolve(HERE, '..', 'addons', 'PortalstoneSense');
const ADDON_NAME = 'PortalstoneSense';

/** The same layout hints the agent uses, so both find the same install. */
const ROOT_HINTS = [
  'Blizzard/World of Warcraft',
  'World of Warcraft',
  'Games/World of Warcraft',
  'Program Files/World of Warcraft',
  'Program Files (x86)/World of Warcraft',
  'XboxGames/World of Warcraft',
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const dry = process.argv.includes('--dry');

function isFlavorDir(name) {
  return /^_.+_$/.test(name);
}

function isWowRoot(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && isFlavorDir(e.name));
  } catch {
    return false;
  }
}

/** Flavor folders in one install (`_forever_`, `_retail_`, …). */
function flavorsOf(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isFlavorDir(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Newest mtime under one flavor's Logs and SavedVariables: when this copy was last played. */
function lastActivity(root, flavor) {
  let newest = 0;
  const bump = (path) => {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      /* gone or unreadable: not evidence either way */
    }
  };
  try {
    for (const f of readdirSync(join(root, flavor, 'Logs'))) if (/\.txt$/i.test(f)) bump(join(root, flavor, 'Logs', f));
  } catch {
    /* no Logs */
  }
  return newest;
}

function candidateRoots() {
  const explicit = arg('install');
  if (explicit) return [resolve(explicit)];
  if (process.env.PORTALSTONE_WOW_DIR) return [resolve(process.env.PORTALSTONE_WOW_DIR)];
  const roots = [];
  for (let c = 65; c <= 90; c++) {
    for (const hint of ROOT_HINTS) roots.push(`${String.fromCharCode(c)}:/${hint}`);
  }
  return roots;
}

function addonFiles() {
  return readdirSync(ADDON_DIR).filter((f) => f.endsWith('.lua') || f.endsWith('.toc') || f.endsWith('.md'));
}

function main() {
  if (!existsSync(ADDON_DIR)) {
    console.error(`addon source missing: ${ADDON_DIR}`);
    process.exit(1);
  }
  const files = addonFiles();
  if (!files.some((f) => f.endsWith('.toc'))) {
    console.error('the addon has no .toc: the game will not load it');
    process.exit(1);
  }
  // A .toc that does not load its .lua is the classic silent failure; check before copying.
  const toc = readFileSync(join(ADDON_DIR, `${ADDON_NAME}.toc`), 'utf8');
  if (!toc.includes(`${ADDON_NAME}.lua`)) {
    console.error(`.toc does not reference ${ADDON_NAME}.lua`);
    process.exit(1);
  }

  const roots = candidateRoots().filter((root) => existsSync(root) && isWowRoot(root));
  if (roots.length === 0) {
    console.error('No World of Warcraft install found. Pass --install "<path>" or set PORTALSTONE_WOW_DIR.');
    process.exit(1);
  }

  // A machine can hold an old install (an unplayed copy on another drive) next to the one you play.
  // The addon belongs where the game was actually run recently, which a recent combat log proves;
  // --all overrides that for two live installs.
  const all = process.argv.includes('--all');
  const recent = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const live = [];
  for (const root of roots) {
    for (const flavor of flavorsOf(root)) {
      const activity = lastActivity(root, flavor);
      if (!all && (activity === 0 || now - activity > recent)) {
        console.log(`skipping ${flavor} in ${root}: no log written in 90 days (--all overrides)`);
        continue;
      }
      live.push({ root, flavor });
    }
  }
  const targets = live.length > 0 ? live : roots.flatMap((root) => flavorsOf(root).map((flavor) => ({ root, flavor })));

  let copied = 0;
  for (const { root, flavor } of targets) {
    const addons = join(root, flavor, 'Interface', 'AddOns');
    const target = join(addons, ADDON_NAME);
    console.log(`${dry ? 'would install' : 'installing'} ${flavor} → ${target}`);
    if (!dry) {
      mkdirSync(target, { recursive: true });
      for (const f of files) copyFileSync(join(ADDON_DIR, f), join(target, f));
    }
    copied++;
    // Files, not the folder: an existing copy must be overwritten, or a stale .lua keeps running.
    for (const f of files) {
      if (!dry) {
        const size = statSync(join(target, f)).size;
        console.log(`  ${f} (${size} bytes)`);
      }
    }
  }
  console.log(`\n${dry ? 'would install' : 'installed'} into ${copied} flavor(s).`);
  console.log('In game: /reload (or log out) to flush SavedVariables, then open the sensor page.');
  console.log(`Addon folder: ${ADDON_DIR}`);
}

main();

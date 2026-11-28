#!/usr/bin/env node
/**
 * Package the sensor addon as a standalone download, separate from the app bundle.
 *
 *   npm run addon:package
 *
 * The app and the addon are two different artifacts that live in two different places — the app runs
 * as a Windows service out of Program Files, the addon lives in the game's Interface\AddOns — so a
 * release ships them as two downloads. This builds the addon one:
 *
 *   dist/PortalStoneSense-<version>.zip         a single PortalStoneSense/ folder, the WoW layout a
 *                                               player drops straight into Interface\AddOns
 *   dist/PortalStoneSense-<version>.zip.sha256  checksum, same as the app bundle carries
 *
 * The release version is stamped into the .toc's `## Version:` line so the in-game addon list shows
 * the same number as the download. Source stays untouched; only the copy in the zip is stamped. The
 * zip is written by scripts/lib/zip.mjs (no external `zip`/Compress-Archive), so it builds the same
 * on every platform and the archive is byte-for-byte reproducible.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './lib/version.mjs';
import { writeZip } from './lib/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonName = 'PortalStoneSense';
const srcDir = join(root, 'addons', addonName);
const distDir = join(root, 'dist');

const version = await resolveVersion(root);

// The addon's shippable files — the same set the by-hand installer copies into the game.
const files = (await readdir(srcDir)).filter((f) => /\.(lua|toc|md)$/i.test(f));
const tocName = `${addonName}.toc`;
if (!files.includes(tocName)) {
  console.error(`addon source has no ${tocName} in ${srcDir}`);
  process.exit(1);
}

// Build the zip entries in memory: a top-level PortalStoneSense/ folder, then each file under it.
// The .toc is version-stamped on the way in; the file on disk is left as its placeholder.
const entries = [{ name: `${addonName}/` }];
for (const f of files) {
  let data = await readFile(join(srcDir, f));
  if (f === tocName) {
    const text = data.toString('utf8');
    if (!/^## Version:.*$/m.test(text)) {
      console.error(`${tocName} has no "## Version:" line to stamp`);
      process.exit(1);
    }
    data = Buffer.from(text.replace(/^## Version:.*$/m, `## Version: ${version}`), 'utf8');
  }
  entries.push({ name: `${addonName}/${f}`, data });
}

await mkdir(distDir, { recursive: true });
const zipName = `${addonName}-${version}.zip`;
const zipPath = join(distDir, zipName);
await rm(zipPath, { force: true });
writeZip(zipPath, entries);

// Checksum beside it, matching the app bundle's convention.
const bytes = await readFile(zipPath);
const sha = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${zipPath}.sha256`, `${sha}\n`);

console.log(`portalstone: addon package v${version} → ${zipPath}`);
console.log(`  ${zipName}  (${(bytes.length / 1024).toFixed(1)} KB)`);
console.log(`  ${zipName}.sha256  ${sha}`);
console.log(`  contents: ${addonName}/{ ${files.join(', ')} }`);
console.log('\nInstall by hand: unzip into World of Warcraft\\_<flavor>_\\Interface\\AddOns, then /reload.');

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
 * the same number as the download. Source stays untouched; only the copy in the zip is stamped.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './lib/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonName = 'PortalStoneSense';
const srcDir = join(root, 'addons', addonName);
const distDir = join(root, 'dist');
const stageRoot = join(distDir, 'addon'); // dist/addon/PortalStoneSense/ — zip the folder, not its contents
const stageDir = join(stageRoot, addonName);

const version = await resolveVersion(root);

// Fresh staging folder so a rebuild never ships a file a previous version left behind.
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

// The addon's shippable files — the same set the by-hand installer copies into the game.
const files = (await readdir(srcDir)).filter((f) => /\.(lua|toc|md)$/i.test(f));
if (!files.some((f) => f.toLowerCase().endsWith('.toc'))) {
  console.error(`addon source has no .toc in ${srcDir}`);
  process.exit(1);
}
for (const f of files) await cp(join(srcDir, f), join(stageDir, f));

// Stamp the release version into the staged .toc. The source keeps its own placeholder; only this
// download is pinned, so the in-game list matches what was published.
const tocPath = join(stageDir, `${addonName}.toc`);
const toc = await readFile(tocPath, 'utf8');
if (!/^## Version:.*$/m.test(toc)) {
  console.error(`${addonName}.toc has no "## Version:" line to stamp`);
  process.exit(1);
}
await writeFile(tocPath, toc.replace(/^## Version:.*$/m, `## Version: ${version}`));

// Zip the folder itself (zip root = PortalStoneSense/). Windows ships Compress-Archive; CI (ubuntu)
// and other platforms use the `zip` CLI, the same one the app-bundle step uses.
const zipName = `${addonName}-${version}.zip`;
const zipPath = join(distDir, zipName);
await rm(zipPath, { force: true });
if (process.platform === 'win32') {
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force`],
    { stdio: 'inherit' },
  );
} else {
  // Run from the staging root so the folder lands at the zip root. The archive path is relative to
  // that cwd (../<zip>, i.e. back up into dist/) — some `zip` builds mis-handle an absolute archive
  // argument, and this mirrors the app-bundle step's proven `cd … && zip -r ../../$ZIP .` form.
  execFileSync('zip', ['-r', join('..', zipName), addonName], { cwd: stageRoot, stdio: 'inherit' });
}

// Checksum beside it, matching the app bundle's convention.
const bytes = await readFile(zipPath);
const sha = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${zipPath}.sha256`, `${sha}\n`);

console.log(`portalstone: addon package v${version} → ${zipPath}`);
console.log(`  ${zipName}  (${(bytes.length / 1024).toFixed(1)} KB)`);
console.log(`  ${zipName}.sha256  ${sha}`);
console.log(`  contents: ${addonName}/{ ${files.join(', ')} }`);
console.log('\nInstall by hand: unzip into World of Warcraft\\_<flavor>_\\Interface\\AddOns, then /reload.');

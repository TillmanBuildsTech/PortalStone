/**
 * The release version, resolved the same way for every artifact a release ships (the app bundle and
 * the addon download), so they can never disagree.
 *
 * The git tag is the source of truth: CI sets PORTALSTONE_VERSION from the tag it is building. A
 * local build without that env falls back to the nearest tag, then to package.json, then to a dev
 * marker (which the updater treats as "running from source, never offer an update").
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function resolveVersion(root) {
  if (process.env.PORTALSTONE_VERSION) return process.env.PORTALSTONE_VERSION.replace(/^v/, '');
  try {
    const described = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' });
    if (described.trim()) return described.trim().replace(/^v/, '');
  } catch {
    /* no tags yet, or not a git checkout */
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.version && pkg.version !== '0.0.0') return pkg.version;
  } catch {
    /* fall through to the dev marker */
  }
  return '0.0.0-dev';
}

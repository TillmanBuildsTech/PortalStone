#!/usr/bin/env node
/**
 * Cut a release: bump the version in package.json, commit, tag, and push. CI (.github/workflows/
 * release.yml) does the rest — it builds, zips, and publishes the GitHub Release from the tag.
 *
 *   npm run release -- 0.1.0-beta.1     # a beta (prerelease; tag v0.1.0-beta.1)
 *   npm run release -- 0.1.0            # a stable release
 *   npm run release -- 0.1.0 --dry-run  # show what it would do, change nothing
 *
 * The tag is the source of truth for the version a build stamps in; this script keeps package.json
 * in step for humans and sets the tag CI reads. It refuses to run on a dirty tree (other than
 * package.json) so a release is always a clean, reproducible commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((a) => !a.startsWith('--'));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function die(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

if (!version) die('usage: npm run release -- <version>   e.g. 0.1.0-beta.1');
if (!SEMVER.test(version)) die(`"${version}" is not a semver version (want 0.1.0 or 0.1.0-beta.1)`);

const tag = `v${version}`;
const git = (cmdArgs) => execFileSync('git', cmdArgs, { cwd: root, encoding: 'utf8' }).trim();

// A clean tree (apart from package.json, which we are about to write) keeps the release commit honest.
const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter((l) => l.trim() && !l.endsWith('package.json'));
if (dirty.length > 0) die(`working tree is dirty:\n${dirty.join('\n')}\nCommit or stash first.`);

try {
  const existing = git(['tag', '--list', tag]);
  if (existing) die(`tag ${tag} already exists`);
} catch {
  /* `git tag --list` on a fresh repo is fine */
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const prerelease = version.includes('-');

process.stdout.write(`release: ${pkg.version ?? '0.0.0'} → ${version} (${prerelease ? 'prerelease' : 'stable'}), tag ${tag}\n`);
if (dryRun) {
  process.stdout.write('  --dry-run: would update package.json, commit, tag, and push --follow-tags\n');
  process.exit(0);
}

// Only bump+commit when the version actually changes; otherwise there is nothing to commit and we
// simply tag the current HEAD. This keeps `release` idempotent — re-running after a manual bump, or
// after a half-finished run, tags rather than failing on an empty commit.
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  git(['add', 'package.json']);
  git(['commit', '-m', `release: ${tag}`]);
} else {
  process.stdout.write(`  package.json already at ${version}; tagging the current commit\n`);
}
// An annotated tag (-a), and push it by name: `--follow-tags` pushes only annotated tags, and even
// then a lightweight tag would be skipped — so push the branch and the tag itself, explicitly.
git(['tag', '-a', tag, '-m', `PortalStone ${version}`]);
git(['push', 'origin', 'HEAD']);
git(['push', 'origin', tag]);

process.stdout.write(`\nPushed ${tag}. CI will build and publish the release:\n`);
process.stdout.write('  https://github.com/TillmanBuildsTech/PortalStone/actions\n');

/**
 * The build's version, and the semver arithmetic the updater needs.
 *
 * The single source of truth is the git tag: the release build (scripts/build-release.mjs) resolves
 * it and stamps it into the bundle through an esbuild `define`, so a shipped `portalstone.mjs` knows
 * what it is. A `tsx` dev run has no define — the constant is undefined and we fall back to
 * `PORTALSTONE_VERSION` (set by hand or by CI) and finally to `0.0.0-dev`, which also marks "not a
 * real release, do not offer to update".
 *
 * `compareSemver` follows semver precedence closely enough for this app's own tags: numeric
 * major/minor/patch, then a prerelease ranks below its release (`0.1.0-beta.2` < `0.1.0`), with
 * prerelease identifiers compared numerically when both are numeric and lexically otherwise. Build
 * metadata (`+sha`) is ignored, as semver requires.
 */

// Replaced at build time by esbuild `define`; absent (hence the typeof guard) under tsx/vitest.
declare const __PORTALSTONE_VERSION__: string | undefined;

export const VERSION: string =
  (typeof __PORTALSTONE_VERSION__ !== 'undefined' && __PORTALSTONE_VERSION__) ||
  process.env.PORTALSTONE_VERSION ||
  '0.0.0-dev';

/** `0.0.0-dev` (and anything not shaped like a release) means "running from source, never update". */
export function isReleaseVersion(v: string = VERSION): boolean {
  const p = parseSemver(v);
  return p !== null && !(p.prerelease.length === 1 && p.prerelease[0] === 'dev');
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** the dot-separated identifiers after `-`, each a string or a number; empty for a release */
  prerelease: (string | number)[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.2.3`, `v1.2.3`, `0.1.0-beta.2`, `1.0.0-rc.1+build`; returns null if it is not semver. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  const prerelease = m[4]
    ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/**
 * Semver precedence. Returns <0 if a<b, 0 if equal, >0 if a>b. Unparseable inputs sort below any
 * real version (and equal to each other), so a malformed tag can never be chosen as an update.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // A version with a prerelease has lower precedence than the associated release.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i]!;
    const y = pb.prerelease[i]!;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) {
      if (x !== y) return (x as number) - (y as number);
    } else if (xn !== yn) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return (x as string) < (y as string) ? -1 : 1;
    }
  }
  // All shared identifiers equal: the longer prerelease has higher precedence.
  return pa.prerelease.length - pb.prerelease.length;
}

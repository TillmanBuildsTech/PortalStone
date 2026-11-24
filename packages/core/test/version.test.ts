import { describe, expect, it } from 'vitest';
import { compareSemver, isReleaseVersion, parseSemver } from '../src/version';

describe('parseSemver', () => {
  it('parses plain, v-prefixed, prerelease and build-metadata forms', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [] });
    expect(parseSemver('0.1.0-beta.2')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ['beta', 2] });
    expect(parseSemver('1.0.0-rc.1+build.9')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['rc', 1] });
  });

  it('rejects things that are not semver', () => {
    for (const v of ['', 'latest', '1.2', '1.2.x', 'v1', 'nightly']) {
      expect(parseSemver(v)).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  const lt = (a: string, b: string) => expect(Math.sign(compareSemver(a, b))).toBe(-1);
  const eq = (a: string, b: string) => expect(compareSemver(a, b)).toBe(0);

  it('orders by major, minor, then patch', () => {
    lt('1.0.0', '2.0.0');
    lt('1.1.0', '1.2.0');
    lt('1.1.1', '1.1.2');
    eq('1.2.3', 'v1.2.3');
  });

  it('ranks a prerelease below its release', () => {
    lt('0.1.0-beta.1', '0.1.0');
    lt('1.0.0-rc.1', '1.0.0');
  });

  it('orders prerelease identifiers per semver precedence', () => {
    lt('0.1.0-beta.1', '0.1.0-beta.2');
    lt('0.1.0-alpha.1', '0.1.0-beta.1');
    // numeric identifiers rank below alphanumeric ones
    lt('1.0.0-1', '1.0.0-alpha');
    // a longer prerelease with an identical prefix has higher precedence
    lt('1.0.0-beta', '1.0.0-beta.1');
  });

  it('sorts a full releases list and ignores build metadata', () => {
    const sorted = ['0.1.0-alpha.1', '0.1.0-beta.1', '0.1.0-beta.2', '0.1.0', '0.2.0', '1.0.0'];
    const shuffled = [...sorted].reverse();
    shuffled.sort(compareSemver);
    expect(shuffled).toEqual(sorted);
    eq('1.0.0+a', '1.0.0+b');
  });

  it('sorts an unparseable version below any real one', () => {
    lt('not-a-version', '0.0.1');
    eq('garbage', 'also-garbage');
  });
});

describe('isReleaseVersion', () => {
  it('treats the dev fallback (and junk) as not a release', () => {
    expect(isReleaseVersion('0.0.0-dev')).toBe(false);
    expect(isReleaseVersion('nightly')).toBe(false);
  });

  it('treats real tags, including betas, as releases', () => {
    expect(isReleaseVersion('0.1.0-beta.1')).toBe(true);
    expect(isReleaseVersion('1.0.0')).toBe(true);
  });
});

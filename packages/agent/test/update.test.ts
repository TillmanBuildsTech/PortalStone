import { describe, expect, it } from 'vitest';
import { normalizeChannel, pickLatest } from '../src/update';

/** A minimal GitHub release object with a zip asset, as the real API returns. */
function release(tag: string, opts: { prerelease?: boolean; draft?: boolean; zip?: boolean } = {}) {
  const version = tag.replace(/^v/, '');
  return {
    tag_name: tag,
    name: tag,
    body: `notes for ${tag}`,
    html_url: `https://github.com/TillmanBuildsTech/PortalStone/releases/tag/${tag}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: '2026-01-01T00:00:00Z',
    assets:
      opts.zip === false
        ? []
        : [
            {
              name: `portalstone-${version}.zip`,
              browser_download_url: `https://example.test/portalstone-${version}.zip`,
            },
            {
              name: `portalstone-${version}.zip.sha256`,
              browser_download_url: `https://example.test/portalstone-${version}.zip.sha256`,
            },
          ],
  };
}

const feed = [
  release('v0.1.0-beta.1', { prerelease: true }),
  release('v0.1.0-beta.2', { prerelease: true }),
  release('v0.1.0'),
  release('v0.2.0-beta.1', { prerelease: true }),
];

describe('pickLatest', () => {
  it('on the beta channel offers the newest of all releases, prereleases included', () => {
    const r = pickLatest(feed, '0.1.0-beta.1', 'beta');
    expect(r?.version).toBe('0.2.0-beta.1');
    expect(r?.prerelease).toBe(true);
    expect(r?.zipUrl).toContain('portalstone-0.2.0-beta.1.zip');
    expect(r?.sha256Url).toContain('.sha256');
    expect(r?.notes).toBe('notes for v0.2.0-beta.1');
  });

  it('on the stable channel ignores prereleases', () => {
    expect(pickLatest(feed, '0.0.9', 'stable')?.version).toBe('0.1.0');
    // nothing stable is newer than the one stable release
    expect(pickLatest(feed, '0.1.0', 'stable')).toBeNull();
  });

  it('a beta tester still sees a newer stable', () => {
    expect(pickLatest([release('v0.1.0')], '0.1.0-beta.2', 'beta')?.version).toBe('0.1.0');
  });

  it('returns null when nothing is strictly newer than current', () => {
    expect(pickLatest(feed, '0.2.0-beta.1', 'beta')).toBeNull();
    expect(pickLatest(feed, '9.9.9', 'beta')).toBeNull();
  });

  it('skips drafts and releases without a build asset', () => {
    const r = [
      release('v0.3.0', { draft: true }),
      release('v0.2.5', { zip: false }),
      release('v0.2.0'),
    ];
    expect(pickLatest(r, '0.1.0', 'stable')?.version).toBe('0.2.0');
  });
});

describe('normalizeChannel', () => {
  it('defaults to beta and only accepts the two known channels', () => {
    expect(normalizeChannel(null)).toBe('beta');
    expect(normalizeChannel(undefined)).toBe('beta');
    expect(normalizeChannel('nonsense')).toBe('beta');
    expect(normalizeChannel('beta')).toBe('beta');
    expect(normalizeChannel('stable')).toBe('stable');
  });
});

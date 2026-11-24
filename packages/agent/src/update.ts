/**
 * Update checking and one-click self-update.
 *
 * The running service asks GitHub for the project's releases, compares them to its own baked-in
 * VERSION, and — when the user clicks "Update & restart" — downloads the new build, verifies it, and
 * hands off to a tiny detached updater that swaps the install folder and restarts the service.
 *
 * Privacy: the only network call here is anonymous, to the public GitHub API. It never carries the
 * user's identity — a fixed `User-Agent: portalstone`, no token, no email — because nothing about
 * this machine's owner is any of GitHub's business.
 *
 * Platform: the apply path drives `serv` and swaps a Program Files folder, so it is Windows-only and
 * only when running as the installed service (an `install.json` sits beside the bundle). A dev run,
 * or any other platform, still gets the check and the banner, but "apply" is refused — you update it
 * the way you installed it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { VERSION, compareSemver, isReleaseVersion } from '../../core/src/version';

const execFileP = promisify(execFile);

const REPO = 'TillmanBuildsTech/PortalStone';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases`;

export type Channel = 'beta' | 'stable';

export interface ReleaseInfo {
  version: string;
  tag: string;
  notes: string;
  url: string;
  prerelease: boolean;
  publishedAt: string | null;
  /** browser_download_url of the `portalstone-<version>.zip` asset */
  zipUrl: string | null;
  /** browser_download_url of the `.sha256` sidecar, when present */
  sha256Url: string | null;
}

export type ApplyPhase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'restarting' | 'error';

export interface UpdateState {
  current: string;
  channel: Channel;
  /** true when running as the installed service — only then can "Update & restart" work */
  installed: boolean;
  /** epoch ms of the last completed check, 0 before the first one */
  checkedAt: number;
  /** the newest release strictly greater than `current` on this channel, else null */
  latest: ReleaseInfo | null;
  /** last check's error, when the check itself failed (offline, rate limit); the banner stays quiet */
  checkError: string | null;
  apply: { phase: ApplyPhase; message?: string };
}

/** Where this build is installed, written by scripts/install-service.mjs. Null for a dev run. */
export interface InstallContext {
  name: string;
  target: string;
  port: number;
  db: string;
}

export function initialState(channel: Channel, installed = false): UpdateState {
  return { current: VERSION, channel, installed, checkedAt: 0, latest: null, checkError: null, apply: { phase: 'idle' } };
}

export function normalizeChannel(raw: string | null | undefined): Channel {
  return raw === 'stable' ? 'stable' : 'beta';
}

/** Read the install context from `install.json` beside the running bundle, or null if absent. */
export async function readInstallContext(dir: string): Promise<InstallContext | null> {
  try {
    const raw = await readFile(join(dir, 'install.json'), 'utf8');
    const j = JSON.parse(raw) as Partial<InstallContext>;
    if (!j.name || !j.target) return null;
    return { name: j.name, target: j.target, port: Number(j.port) || 0, db: j.db ?? '' };
  } catch {
    return null;
  }
}

// GitHub's release JSON, only the fields we read.
interface GhAsset {
  name: string;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GhAsset[];
}

function toReleaseInfo(r: GhRelease): ReleaseInfo {
  const zip = r.assets.find((a) => /^portalstone-.*\.zip$/.test(a.name));
  const sha = r.assets.find((a) => /^portalstone-.*\.zip\.sha256$/.test(a.name));
  return {
    version: r.tag_name.replace(/^v/, ''),
    tag: r.tag_name,
    notes: r.body ?? '',
    url: r.html_url,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    zipUrl: zip?.browser_download_url ?? null,
    sha256Url: sha?.browser_download_url ?? null,
  };
}

/**
 * Choose the newest release greater than `current` for a channel from a GitHub releases array.
 * `stable` ignores prereleases; `beta` considers everything (so a beta tester also sees a newer
 * stable). Drafts are always ignored. Exported for tests — it is pure.
 */
export function pickLatest(releases: GhRelease[], current: string, channel: Channel): ReleaseInfo | null {
  const candidates = releases
    .filter((r) => !r.draft && (channel === 'beta' || !r.prerelease))
    .map(toReleaseInfo)
    .filter((r) => r.zipUrl !== null && compareSemver(r.version, current) > 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareSemver(b.version, a.version));
  return candidates[0]!;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'portalstone', accept: 'application/vnd.github+json' },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

/**
 * Check GitHub for a newer release on this channel. Never throws: on any failure (offline, rate
 * limit, unparseable) it returns a state whose `latest` is unchanged from `prev` and records
 * `checkError`, so a transient outage never clears a banner or crashes the scan loop.
 */
export async function checkForUpdate(channel: Channel, prev?: UpdateState): Promise<UpdateState> {
  const base: UpdateState = prev ?? initialState(channel);
  // A build running from source has no meaningful version to compare; don't offer phantom updates.
  if (!isReleaseVersion(VERSION)) {
    return { ...base, channel, checkedAt: Date.now(), latest: null, checkError: null };
  }
  try {
    const data = await getJson(RELEASES_URL, AbortSignal.timeout(10_000));
    if (!Array.isArray(data)) throw new Error('unexpected releases payload');
    const latest = pickLatest(data as GhRelease[], VERSION, channel);
    return { ...base, channel, checkedAt: Date.now(), latest, checkError: null };
  } catch (err) {
    return { ...base, channel, checkedAt: Date.now(), checkError: (err as Error).message };
  }
}

async function download(url: string, to: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'portalstone' }, redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Download, verify and stage the release, then hand off to the detached updater and return. The
 * caller must already have sent its HTTP response: the updater stops this very service seconds from
 * now. `onPhase` lets the shared UpdateState reflect progress for the banner.
 *
 * Returns once the updater is launched; it does not wait for the restart (this process is about to
 * be killed by `serv stop`).
 */
export async function applyUpdate(
  install: InstallContext,
  latest: ReleaseInfo,
  onPhase: (phase: ApplyPhase, message?: string) => void,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('self-update is only supported for the Windows service');
  if (!latest.zipUrl) throw new Error('release has no downloadable build');

  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const staging = join(programData, 'Portalstone', 'staging', latest.version);
  const extracted = join(staging, 'build');
  const zipPath = join(staging, `portalstone-${latest.version}.zip`);

  await rm(staging, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });

  onPhase('downloading', `downloading ${latest.version}`);
  await download(latest.zipUrl, zipPath, AbortSignal.timeout(120_000));

  onPhase('verifying');
  if (latest.sha256Url) {
    const expected = (await (await fetch(latest.sha256Url, { headers: { 'user-agent': 'portalstone' } })).text())
      .trim()
      .split(/\s+/)[0]!
      .toLowerCase();
    const actual = sha256(await readFile(zipPath));
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
    }
  }

  onPhase('extracting');
  // Windows 10+ ships bsdtar as tar.exe, which reads .zip. Extract to a dir the updater copies from.
  await execFileP('tar', ['-xf', zipPath, '-C', extracted], { windowsHide: true });

  onPhase('restarting', 'stopping the service to swap files');
  // The updater runs from staging (never from the folder being replaced) and outlives this process.
  const updater = join(extracted, 'updater.mjs');
  const child = spawn(
    process.execPath,
    [updater, '--name', install.name, '--target', install.target, '--from', extracted],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountOf, Store } from '../src/store';
import { clearAddonCache } from '../src/addons';
import { sampleTracked } from '../src/tracking';
import { ensureSensorMetrics, readSensor } from '../src/sensor';
import { isCharacter } from '../src/characters';
import { renderSensor } from '../src/ui/pages/sensor';
import { resolveScope, type Ctx } from '../src/ui/context';
import { refuseRequest } from '../src/server';
import type { InstallInfo } from '../src/discover';

/**
 * Alts on two Battle.net accounts: one install, one combat log, but two WTF/Account folders, each
 * with its own copy of every addon's SavedVariables. Each copy only knows its own account's
 * characters, and whichever account logged out last has the newest file.
 */
const DIR = mkdtempSync(join(tmpdir(), 'portalstone-accounts-'));
const T = 1_700_000_000_000;

const open: Store[] = [];
function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}

beforeEach(() => clearAddonCache());
afterEach(() => {
  while (open.length) open.pop()!.close();
});

interface AccountFiles {
  name: string;
  files: Record<string, { body: string; mtimeMs: number }>;
}

function install(accounts: AccountFiles[]): InstallInfo[] {
  clearAddonCache();
  return [
    {
      root: DIR,
      flavors: [
        {
          name: '_forever_',
          dir: join(DIR, '_forever_'),
          logs: [],
          addons: [],
          accounts: accounts.map((a) => {
            const dir = join(DIR, '_forever_', 'WTF', 'Account', a.name);
            const sv = join(dir, 'SavedVariables');
            mkdirSync(sv, { recursive: true });
            const savedVariables = Object.entries(a.files).map(([name, f]) => {
              const path = join(sv, name);
              writeFileSync(path, f.body);
              utimesSync(path, new Date(f.mtimeMs), new Date(f.mtimeMs));
              return { name, bytes: Buffer.byteLength(f.body), mtimeMs: f.mtimeMs };
            });
            return { name: a.name, dir, savedVariables };
          }),
        },
      ],
    },
  ];
}

const bags = (chars: Record<string, number>): string =>
  `BrotherBags = {\n["forever"] = {\n${Object.entries(chars)
    .map(([n, m]) => `["${n}"] = { ["money"] = ${m}, ["level"] = 20 },`)
    .join('\n')}\n},\n}\n`;

const sense = (name: string, updated: number): string =>
  `PortalStoneDB = {\n["chars"] = {\n["${name}"] = { ["meta"] = { ["updated"] = ${updated} }, ["played"] = { ["total"] = 600 } },\n},\n}\n`;

describe('tracked series across accounts', () => {
  it('sums every account, so switching alts does not move the total', () => {
    const s = store();
    const id = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold',
      unit: 'copper',
    });
    // Play A, then B, then A, then B. Nobody's gold changes.
    for (const [a, b] of [
      [T + 1000, T],
      [T + 1000, T + 2000],
      [T + 3000, T + 2000],
      [T + 3000, T + 4000],
    ] as const) {
      sampleTracked(
        s,
        install([
          { name: 'ACC_A', files: { 'BagBrother.lua': { body: bags({ Alpha: 1000 }), mtimeMs: a } } },
          { name: 'ACC_B', files: { 'BagBrother.lua': { body: bags({ Bravo: 50 }), mtimeMs: b } } },
        ]),
      );
    }
    const series = s.samples(id, 10);
    expect(series.map((x) => x.value)).toEqual([1050, 1050, 1050, 1050]);
    expect(series.every((x) => x.instances === 2)).toBe(true);
  });

  it('follows a pinned character into its own account even when the other flushed last', () => {
    const s = store();
    const id = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold · Alpha',
      unit: 'copper',
      entity: 'Alpha',
    });
    const res = sampleTracked(
      s,
      install([
        { name: 'ACC_A', files: { 'BagBrother.lua': { body: bags({ Alpha: 1000 }), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'BagBrother.lua': { body: bags({ Bravo: 50 }), mtimeMs: T + 5000 } } },
      ]),
    )[0]!;
    expect(res.recorded).toBe(true);
    expect(s.samples(id, 10).map((x) => [x.ts_ms, x.value])).toEqual([[T, 1000]]);
  });

  it('a character-specific path is stamped by its own account, not the newest one', () => {
    const s = store();
    const id = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', 'Alpha', 'level'],
      label: 'Level',
      unit: 'plain',
    });
    sampleTracked(
      s,
      install([
        { name: 'ACC_A', files: { 'BagBrother.lua': { body: bags({ Alpha: 1000 }), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'BagBrother.lua': { body: bags({ Bravo: 50 }), mtimeMs: T + 5000 } } },
      ]),
    );
    expect(s.samples(id, 10).map((x) => [x.ts_ms, x.value])).toEqual([[T, 20]]);
  });

  it('records nothing when one account cannot be read, rather than a total missing it', () => {
    const s = store();
    const id = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold',
      unit: 'copper',
    });
    const res = sampleTracked(
      s,
      install([
        { name: 'ACC_A', files: { 'BagBrother.lua': { body: bags({ Alpha: 1000 }), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'BagBrother.lua': { body: 'BrotherBags = { ["forever"] = {', mtimeMs: T + 5000 } } },
      ]),
    )[0]!;
    expect(res.recorded).toBe(false);
    expect(res.reason).toContain('ACC_B');
    expect(s.samples(id, 10)).toEqual([]);
  });
});

describe('the sensor across accounts', () => {
  it('reads every account, tagging each character with where it came from', () => {
    const read = readSensor(
      install([
        { name: 'ACC_A', files: { 'PortalStoneSense.lua': { body: sense('Alpha', 1_700_000_000), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'PortalStoneSense.lua': { body: sense('Bravo', 1_700_000_100), mtimeMs: T + 100_000 } } },
      ]),
    );
    expect(read.state).toBe('ok');
    expect(read.files).toHaveLength(2);
    expect(read.chars.map((c) => [c.key, c.account])).toEqual([
      ['Bravo', 'ACC_B'],
      ['Alpha', 'ACC_A'],
    ]);
  });

  it('still shows the readable account when the other is broken, and says which was skipped', () => {
    const read = readSensor(
      install([
        { name: 'ACC_A', files: { 'PortalStoneSense.lua': { body: sense('Alpha', 1_700_000_000), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'PortalStoneSense.lua': { body: 'PortalStoneDB = {', mtimeMs: T + 100_000 } } },
      ]),
    );
    expect(read.state).toBe('ok');
    expect(read.chars.map((c) => c.key)).toEqual(['Alpha']);
    expect(read.skipped.join()).toContain('ACC_B');
  });
});

describe('repairing series recorded one account at a time', () => {
  it('rebuilds the sawtooth into totals and keeps the originals', () => {
    const path = join(DIR, `repair-${Math.random().toString(36).slice(2)}.sqlite`);
    const a = join(DIR, '_forever_', 'WTF', 'Account', 'ACC_A', 'SavedVariables', 'BagBrother.lua');
    const b = join(DIR, '_forever_', 'WTF', 'Account', 'ACC_B', 'SavedVariables', 'BagBrother.lua');

    // What the old sampler wrote: each point is one account's total.
    const before = new Store(path);
    const gold = before.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold',
      unit: 'copper',
    });
    const level = before.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'level'],
      label: 'Level · Alpha',
      unit: 'plain',
      entity: 'Alpha',
    });
    const points: [number, number, string][] = [
      [T, 1000, a],
      [T + 1000, 50, b],
      [T + 2000, 1200, a],
      [T + 3000, 80, b],
    ];
    for (const [ts, value, file] of points) {
      before.recordSample({ metricId: gold, tsMs: ts, value, instances: 1, minValue: value, maxValue: value, sourceFile: file, sourceMtimeMs: ts });
    }
    before.recordSample({ metricId: level, tsMs: T, value: 20, instances: 1, minValue: 20, maxValue: 20, sourceFile: a, sourceMtimeMs: T });
    // Simulate a database from before the repair existed.
    before.db.prepare("DELETE FROM meta WHERE key = 'samples_cross_account'").run();
    before.close();

    const s = new Store(path);
    open.push(s);
    // The first point predates B's first observation: B's first value stands in for it.
    expect(s.samples(gold, 10).map((x) => [x.ts_ms, x.value])).toEqual([
      [T, 1050],
      [T + 1000, 1050],
      [T + 2000, 1250],
      [T + 3000, 1280],
    ]);
    // A pinned series was never mixed and is left alone.
    expect(s.samples(level, 10).map((x) => x.value)).toEqual([20]);
    const kept = s.db.prepare('SELECT COUNT(*) AS n FROM tracked_sample_premerge').get() as { n: number };
    expect(kept.n).toBe(4);

    // It runs once: reopening does not merge the already-merged totals again.
    s.close();
    open.pop();
    const again = new Store(path);
    open.push(again);
    expect(again.samples(gold, 10).map((x) => x.value)).toEqual([1050, 1050, 1250, 1280]);
  });

  it('keys accounts by flavor and account folder, not the whole path', () => {
    expect(accountOf('D:\\Blizzard\\World of Warcraft\\_forever_\\WTF\\Account\\LANC3RR1\\SavedVariables\\BagBrother.lua')).toBe(
      '_forever_/LANC3RR1',
    );
    expect(accountOf('E:/Games/World of Warcraft/_forever_/WTF/Account/LANC3RR1/SavedVariables/BagBrother.lua')).toBe(
      '_forever_/LANC3RR1',
    );
  });
});

/** A schema-2 sensor entry: keyed by name and realm, with the name and guid in meta. */
const sense2 = (name: string, realm: string, guid: string, updated: number): string =>
  `PortalStoneDB = {\n["schema"] = 2,\n["chars"] = {\n["${name}-${realm}"] = { ["meta"] = { ["name"] = "${name}", ["realm"] = "${realm}", ["guid"] = "${guid}", ["updated"] = ${updated} }, ["played"] = { ["total"] = 900 } },\n},\n}\n`;

describe('sensor keys with the realm in them', () => {
  it('shows the character by name, and keeps its series when the addon re-keys it', () => {
    const s = store();
    const legacy = install([
      { name: 'ACC_A', files: { 'PortalStoneSense.lua': { body: sense('Dead', 1_700_000_000), mtimeMs: T } } },
    ]);
    ensureSensorMetrics(s, readSensor(legacy));
    const played = s.trackedMetrics().find((m) => m.label === 'Played · Dead')!;
    sampleTracked(s, legacy);
    expect(s.samples(played.id, 10)).toHaveLength(1);

    // The addon, updated, moves the character to `Dead-<realm>` on its next flush.
    const rekeyed = install([
      {
        name: 'ACC_A',
        files: {
          'PortalStoneSense.lua': {
            body: sense2('Dead', 'CAMWOW US2 Realm 8 PvP', 'Player-6934-0194514D', 1_700_000_100),
            mtimeMs: T + 100_000,
          },
        },
      },
    ]);
    const read = readSensor(rekeyed);
    expect(read.chars[0]!.meta.name).toBe('Dead');
    expect(ensureSensorMetrics(s, read)).toEqual([]);
    const after = s.trackedMetrics().find((m) => m.id === played.id)!;
    expect(after.entity).toBe('Dead-CAMWOW US2 Realm 8 PvP');
    expect(after.label).toBe('Played · Dead');
    sampleTracked(s, rekeyed);
    expect(s.samples(played.id, 10).map((x) => x.value)).toEqual([600, 900]);
  });

  it('does not guess when two re-keyed characters share the old name', () => {
    const s = store();
    ensureSensorMetrics(
      s,
      readSensor(install([{ name: 'ACC_A', files: { 'PortalStoneSense.lua': { body: sense('Dead', 1), mtimeMs: T } } }])),
    );
    const read = readSensor(
      install([
        { name: 'ACC_A', files: { 'PortalStoneSense.lua': { body: sense2('Dead', 'Realm A', 'Player-1-A', 2), mtimeMs: T + 1 } } },
        { name: 'ACC_B', files: { 'PortalStoneSense.lua': { body: sense2('Dead', 'Realm B', 'Player-2-B', 3), mtimeMs: T + 2 } } },
      ]),
    );
    ensureSensorMetrics(s, read);
    // The old series stays on the old key; each realm's character gets its own fresh series.
    const entities = s.trackedMetrics().filter((m) => m.label === 'Played · Dead').map((m) => m.entity).sort();
    expect(entities).toEqual(['Dead', 'Dead-Realm A', 'Dead-Realm B']);
  });
});

describe('joining the sensor to the log by guid', () => {
  it('matches the guid even when the names disagree outright', () => {
    // This server's log says `Dead-Sadfatkid-PvP-US`; the client's UnitName says `Dead`.
    const scoped = { name: 'Dead-Sadfatkid-PvP-US', guid: 'Player-6934-0194514D' };
    expect(isCharacter(scoped, { name: 'Dead', guid: 'Player-6934-0194514D' })).toBe(true);
    expect(isCharacter(scoped, { name: 'Dead Sadfatkid', guid: 'Player-6798-0000' })).toBe(false);
    // BagBrother records no guid: the name is all there is.
    expect(isCharacter(scoped, { name: 'Dead Sadfatkid', guid: null })).toBe(true);
  });

  it('scopes the sensor page to the log character it belongs to', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/a.txt', 0, [], { guid: 'Player-6934-0194514D', name: 'Dead-Sadfatkid-PvP-US' });
    const installs = install([
      {
        name: 'ACC_A',
        files: {
          'PortalStoneSense.lua': {
            body: sense2('Dead', 'CAMWOW US2 Realm 8 PvP', 'Player-6934-0194514D', 1_700_000_100),
            mtimeMs: T,
          },
        },
      },
      {
        name: 'ACC_B',
        files: { 'PortalStoneSense.lua': { body: sense2('Blister', 'Realm 2', 'Player-6798-0490B5DD', 1_700_000_000), mtimeMs: T } },
      },
    ]);
    const ctx: Ctx = {
      store: s,
      installs,
      lastScan: { at: 0, entries: 0, errors: 0 },
      dbPath: ':memory:',
      ...resolveScope(s, null),
      character: 'Player-6934-0194514D',
      characterName: 'Dead-Sadfatkid-PvP-US',
      characterGuid: 'Player-6934-0194514D',
    };
    const html = renderSensor(ctx);
    expect(html).toContain('<h2>Dead · CAMWOW US2 Realm 8 PvP');
    expect(html).not.toContain('Blister');
  });
});

describe('sharing the database with a second process', () => {
  it('waits on a lock instead of failing at once', () => {
    const s = store();
    // The service and a dev run can both hold the file; a write must wait out the other's lock.
    const row = s.db.prepare('PRAGMA busy_timeout').get() as Record<string, number>;
    expect(Object.values(row)[0]).toBe(5000);
  });
});

describe('requests from other websites', () => {
  const P = 48120;
  const req = (method: string, headers: Record<string, string>) => ({ method, headers });

  it('serves its own pages, by either local name', () => {
    expect(refuseRequest(req('GET', { host: '127.0.0.1:48120' }), P)).toBeNull();
    expect(refuseRequest(req('GET', { host: 'localhost:48120' }), P)).toBeNull();
  });

  it('refuses a rebound hostname, even on a GET', () => {
    expect(refuseRequest(req('GET', { host: 'attacker.example:48120' }), P)).toContain('Host');
    expect(refuseRequest(req('GET', {}), P)).toContain('Host');
  });

  it('accepts writes from its own pages and from non-browser clients', () => {
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', origin: 'http://127.0.0.1:48120' }), P)).toBeNull();
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', 'sec-fetch-site': 'same-origin' }), P)).toBeNull();
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120' }), P)).toBeNull();
  });

  it('refuses a form posted from another site', () => {
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', origin: 'https://evil.example' }), P)).toContain('cross-origin');
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', origin: 'null' }), P)).toContain('cross-origin');
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', 'sec-fetch-site': 'cross-site' }), P)).toContain('cross-site');
    // Another local port is another origin: some other app's page must not drive this one either.
    expect(refuseRequest(req('POST', { host: '127.0.0.1:48120', origin: 'http://127.0.0.1:3000' }), P)).toContain('cross-origin');
  });
});

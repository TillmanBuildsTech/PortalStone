import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountOf, Store } from '../src/store';
import { clearAddonCache } from '../src/addons';
import { sampleTracked } from '../src/tracking';
import { readSensor } from '../src/sensor';
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
  `PortalstoneDB = {\n["chars"] = {\n["${name}"] = { ["meta"] = { ["updated"] = ${updated} }, ["played"] = { ["total"] = 600 } },\n},\n}\n`;

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
        { name: 'ACC_A', files: { 'PortalstoneSense.lua': { body: sense('Alpha', 1_700_000_000), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'PortalstoneSense.lua': { body: sense('Bravo', 1_700_000_100), mtimeMs: T + 100_000 } } },
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
        { name: 'ACC_A', files: { 'PortalstoneSense.lua': { body: sense('Alpha', 1_700_000_000), mtimeMs: T } } },
        { name: 'ACC_B', files: { 'PortalstoneSense.lua': { body: 'PortalstoneDB = {', mtimeMs: T + 100_000 } } },
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

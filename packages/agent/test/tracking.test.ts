import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { clearAddonCache } from '../src/addons';
import {
  changesAcrossSessions,
  diffMembers,
  parseMembers,
  sampleTracked,
  toNumber,
  type SessionDetail,
} from '../src/tracking';
import type { InstallInfo } from '../src/discover';
import { delta, quantity } from '../src/ui/format';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-track-'));
const SV = join(DIR, 'SavedVariables');
mkdirSync(SV, { recursive: true });

let store: Store;

beforeEach(() => {
  clearAddonCache();
  store = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
});

function writeBagBrother(money: [number, number], mtimeMs: number): InstallInfo[] {
  const body = `BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = { ["money"] = ${money[0]}, ["class"] = "PALADIN" },
["Slouch Mage"] = { ["money"] = ${money[1]}, ["class"] = "MAGE" },
},
}
`;
  const path = join(SV, 'BagBrother.lua');
  writeFileSync(path, body);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return [
    {
      root: DIR,
      flavors: [
        {
          name: '_forever_',
          dir: DIR,
          logs: [],
          addons: [],
          accounts: [
            {
              name: 'ACC',
              dir: DIR,
              savedVariables: [{ name: 'BagBrother.lua', bytes: Buffer.byteLength(body), mtimeMs }],
            },
          ],
        },
      ],
    },
  ];
}

const MONEY = ['BrotherBags', 'forever', '*', 'money'];

/**
 * The whole point of the base adapter: pick a property, and it becomes a saved series. Gold is the
 * proof — money is copper per character, so the tracked number is the sum and the instances say
 * how many wallets it came from.
 */
describe('tracking a property', () => {
  it('saves a sample for the current flush and sums every instance', () => {
    const installs = writeBagBrother([152079, 370], 1_700_000_000_000);
    const id = store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: MONEY,
      label: 'money',
      unit: 'copper',
    });

    const [result] = sampleTracked(store, installs);
    expect(result!.metric.id).toBe(id);
    expect(result!.recorded).toBe(true);
    expect(result!.value).toBe(152449);
    expect(result!.instances).toBe(2);

    const [sample] = store.samples(id);
    expect(sample!.value).toBe(152449);
    expect(sample!.ts_ms).toBe(1_700_000_000_000);
    expect(sample!.min_value).toBe(370);
    expect(sample!.max_value).toBe(152079);
    expect(store.latestSample(id)!.instances).toBe(2);
  });

  it('does not invent a point when the file has not been flushed again', () => {
    const installs = writeBagBrother([1000, 0], 1_700_000_000_000);
    const id = store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: MONEY,
      label: 'money',
      unit: 'copper',
    });
    sampleTracked(store, installs);
    const [again] = sampleTracked(store, installs);
    expect(again!.recorded).toBe(false);
    expect(again!.reason).toMatch(/already stored/);
    expect(store.samples(id)).toHaveLength(1);
  });

  it('adds a point per flush and keeps the previous ones', () => {
    let installs = writeBagBrother([1000, 0], 1_700_000_000_000);
    const id = store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: MONEY,
      label: 'money',
      unit: 'copper',
    });
    sampleTracked(store, installs);
    installs = writeBagBrother([45000, 500], 1_700_003_600_000);
    sampleTracked(store, installs);
    installs = writeBagBrother([90000, 500], 1_700_007_200_000);
    sampleTracked(store, installs);

    const samples = store.samples(id);
    expect(samples.map((s) => s.value)).toEqual([1000, 45500, 90500]);
    // oldest first, so a chart can draw it without reversing
    expect(samples[0]!.ts_ms).toBeLessThan(samples[2]!.ts_ms);
    expect(store.latestSample(id)!.value).toBe(90500);
  });

  it('reports a property that the addon has not written yet instead of storing zero', () => {
    const installs = writeBagBrother([1000, 0], 1_700_000_000_000);
    const id = store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'vendor_value'],
      label: 'vendor_value',
      unit: 'plain',
    });
    const [result] = sampleTracked(store, installs);
    expect(result!.recorded).toBe(false);
    expect(result!.value).toBeNull();
    expect(result!.reason).toMatch(/not in this flush/);
    expect(store.samples(id)).toHaveLength(0);
  });

  it('reports an addon that is no longer installed', () => {
    store.addTrackedMetric({
      addonFile: 'Removed.lua',
      globalName: 'RemovedDB',
      path: ['RemovedDB', 'gold'],
      label: 'gold',
      unit: 'copper',
    });
    const [result] = sampleTracked(store, writeBagBrother([1, 1], 1_700_000_000_000));
    expect(result!.reason).toMatch(/not installed/);
  });

  it('tracks the same property once, and re-enables instead of duplicating', () => {
    const metric = {
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: MONEY,
      label: 'money',
      unit: 'copper',
    };
    const first = store.addTrackedMetric(metric);
    const second = store.addTrackedMetric({ ...metric, label: 'gold' });
    expect(second).toBe(first);
    expect(store.trackedMetrics()).toHaveLength(1);
    expect(store.trackedMetrics()[0]!.label).toBe('gold');
  });

  it('stops tracking without leaving orphan samples', () => {
    const installs = writeBagBrother([1000, 0], 1_700_000_000_000);
    const id = store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: MONEY,
      label: 'money',
      unit: 'copper',
    });
    sampleTracked(store, installs);
    store.removeTrackedMetric(id);
    expect(store.trackedMetrics()).toEqual([]);
    expect(store.samples(id)).toEqual([]);
    const left = store.db.prepare('SELECT COUNT(*) c FROM tracked_sample').get() as { c: number };
    expect(left.c).toBe(0);
  });
});

describe('money formatting', () => {
  it('reads copper as gold, silver and copper', () => {
    expect(quantity(152079, 'copper')).toBe('15g 20s 79c');
    expect(quantity(370, 'copper')).toBe('3s 70c');
    expect(quantity(0, 'copper')).toBe('0c');
    expect(quantity(1_250_000, 'copper')).toBe('125g 0s 0c');
    expect(quantity(-10503, 'copper')).toBe('-1g 5s 3c');
  });

  it('signs a change', () => {
    expect(delta(1200, 'copper')).toBe('+12s 0c');
    expect(delta(-1200, 'copper')).toBe('-12s 0c');
    expect(delta(0, 'copper')).toBe('—');
  });

  it('leaves other units alone', () => {
    expect(quantity(3625, 'seconds')).toBe('1h 0m');
    expect(quantity(1234, 'plain')).toBe('1,234');
  });
});

/**
 * Gold at a session boundary. SavedVariables are balances, so the only honest attribution is a
 * bracket pair of flushes — and an unbracketed session must read as unknown, not as zero.
 */
describe('session attribution', () => {
  const metric = {
    id: 1,
    addon_file: 'BagBrother.lua',
    global_name: 'BrotherBags',
    path: JSON.stringify(['BrotherBags', 'forever', '*', 'money']),
    label: 'Gold',
    unit: 'copper',
    kind: 'number',
    enabled: 1,
    created_ms: 0,
  };
  const sample = (ts: number, value: number) => ({
    metric_id: 1,
    ts_ms: ts,
    value,
    instances: 1,
    min_value: value,
    max_value: value,
    members: null,
    source_file: null,
    source_mtime_ms: ts,
  });
  const session = (id: number, start: number, end: number | null): SessionDetail => ({ id, start_ms: start, end_ms: end });

  it('brackets a session with the flush before it and the flush after it', () => {
    const changes = changesAcrossSessions(
      [metric],
      new Map([[1, [sample(500, 100_000), sample(9000, 400_000)]]]),
      [session(1, 1000, 5000)],
    ).get(1)!;
    expect(changes[0]!.before!.value).toBe(100_000);
    expect(changes[0]!.after!.value).toBe(400_000);
    expect(changes[0]!.change).toBe(300_000);
    expect(changes[0]!.shared).toBe(1);
  });

  it('uses the nearest flush on each side, not just any two', () => {
    const changes = changesAcrossSessions(
      [metric],
      new Map([[1, [sample(500, 1), sample(800, 2), sample(9000, 5), sample(20_000, 9)]]]),
      [session(1, 1000, 5000)],
    ).get(1)!;
    expect(changes[0]!.before!.value).toBe(2);
    expect(changes[0]!.after!.value).toBe(5);
    expect(changes[0]!.change).toBe(3);
  });

  it('says unknown when no flush has happened since the session ended', () => {
    const changes = changesAcrossSessions([metric], new Map([[1, [sample(500, 1)]]]), [session(1, 1000, 5000)]).get(1)!;
    expect(changes[0]!.change).toBeNull();
    expect(changes[0]!.after).toBeNull();
  });

  it('says unknown when tracking started after the session did', () => {
    const changes = changesAcrossSessions([metric], new Map([[1, [sample(9000, 5)]]]), [session(1, 1000, 5000)]).get(1)!;
    expect(changes[0]!.change).toBeNull();
    expect(changes[0]!.before).toBeNull();
  });

  it('flags a delta that spans more than one session instead of claiming it', () => {
    const changes = changesAcrossSessions(
      [metric],
      new Map([[1, [sample(500, 1), sample(30_000, 8)]]]),
      [session(1, 1000, 5000), session(2, 10_000, 20_000)],
    );
    expect(changes.get(1)![0]!.change).toBe(7);
    expect(changes.get(1)![0]!.shared).toBe(2);
    expect(changes.get(2)![0]!.shared).toBe(2);
  });

  it('returns one row per tracked metric, so gold and level arrive together', () => {
    const level = { ...metric, id: 2, label: 'Level', unit: 'plain' };
    const changes = changesAcrossSessions(
      [metric, level],
      new Map([
        [1, [sample(500, 1), sample(9000, 2)]],
        [2, [sample(500, 29), sample(9000, 30)]],
      ]),
      [session(1, 1000, 5000)],
    ).get(1)!;
    expect(changes.map((c) => c.metric.label)).toEqual(['Gold', 'Level']);
    expect(changes[1]!.change).toBe(1);
  });
});

describe('numeric coercion', () => {
  it('accepts a number stored as a string, because addons do that', () => {
    expect(toNumber('31')).toBe(31);
    expect(toNumber(' 31 ')).toBe(31);
    expect(toNumber('-2.5')).toBe(-2.5);
    expect(toNumber(12)).toBe(12);
  });

  it('refuses anything that is not a clean number', () => {
    expect(toNumber('1,234')).toBeNull();
    expect(toNumber('31g')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(true)).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });
});

function writeGear(equip: (string | null)[], mtimeMs: number): InstallInfo[] {
  const list = equip.map((e) => (e === null ? 'nil' : `"${e}"`)).join(', ');
  const body = `BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = { ["class"] = "PALADIN", ["equip"] = { ${list} } },
},
}
`;
  const path = join(SV, 'BagBrother.lua');
  writeFileSync(path, body);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return [
    {
      root: DIR,
      flavors: [
        {
          name: '_forever_',
          dir: DIR,
          logs: [],
          addons: [],
          accounts: [{ name: 'ACC', dir: DIR, savedVariables: [{ name: 'BagBrother.lua', bytes: Buffer.byteLength(body), mtimeMs }] }],
        },
      ],
    },
  ];
}

// the members are the entries of `equip`, so the tracked path ends in [*]
const GEAR = ['BrotherBags', 'forever', 'Dead Sadfatkid', 'equip', '*'];

/**
 * Equipment is a set of slot → item, not a number. A slot keeps its identity, so a swap reads as
 * "slot 16 changed", which is the only form of gear history a flush-based source can support.
 */
describe('tracking equipment', () => {
  it('saves the equipped items with their slot numbers', () => {
    const installs = writeGear(['1001', null, '1003', '1004'], 1_700_000_000_000);
    store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: GEAR,
      label: 'Equipped',
      unit: 'plain',
      kind: 'set',
    });
    const [result] = sampleTracked(store, installs);
    expect(result!.recorded).toBe(true);
    expect(result!.value).toBe(3);

    const metric = store.trackedMetrics()[0]!;
    const [sample] = store.samples(metric.id);
    const members = parseMembers(sample!.members);
    expect(members).toEqual([
      { k: '1', v: '1001' },
      { k: '3', v: '1003' },
      { k: '4', v: '1004' },
    ]);
    // the count is what a chart would plot: 3 equipped items
    expect(sample!.value).toBe(3);
  });

  it('records a swap as a change to one slot, not a new set', () => {
    let installs = writeGear(['1001', null, '1003'], 1_700_000_000_000);
    store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: GEAR,
      label: 'Equipped',
      unit: 'plain',
      kind: 'set',
    });
    sampleTracked(store, installs);
    installs = writeGear(['1001', null, '2002'], 1_700_003_600_000);
    sampleTracked(store, installs);

    const metric = store.trackedMetrics()[0]!;
    const [before, after] = store.samples(metric.id);
    const diff = diffMembers(parseMembers(before!.members), parseMembers(after!.members));
    expect(diff.changed).toEqual([{ k: '3', from: '1003', to: '2002' }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it('reports an empty set rather than storing nothing silently', () => {
    const installs = writeGear([null, null, null], 1_700_000_000_000);
    store.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: GEAR,
      label: 'Equipped',
      unit: 'plain',
      kind: 'set',
    });
    const [result] = sampleTracked(store, installs);
    expect(result!.recorded).toBe(false);
    expect(result!.reason).toMatch(/empty/);
  });

  it('surfaces equipment changes across a session', () => {
    const metric = {
      id: 7,
      addon_file: 'BagBrother.lua',
      global_name: 'BrotherBags',
      path: JSON.stringify(GEAR),
      label: 'Equipped',
      unit: 'plain',
      kind: 'set',
      enabled: 1,
      created_ms: 0,
    };
    const sample = (ts: number, members: { k: string; v: string }[]) => ({
      metric_id: 7,
      ts_ms: ts,
      value: members.length,
      instances: members.length,
      min_value: null,
      max_value: null,
      members: JSON.stringify(members),
      source_file: null,
      source_mtime_ms: ts,
    });
    const changes = changesAcrossSessions(
      [metric],
      new Map([
        [
          7,
          [
            sample(500, [{ k: '1', v: '1001' }, { k: '16', v: '5000' }]),
            sample(9000, [{ k: '1', v: '1001' }, { k: '16', v: '6000' }, { k: '17', v: '7000' }]),
          ],
        ],
      ]),
      [{ id: 1, start_ms: 1000, end_ms: 5000 }],
    ).get(1)!;
    const diff = changes[0]!.setChange!;
    expect(diff.changed).toEqual([{ k: '16', from: '5000', to: '6000' }]);
    expect(diff.added).toEqual([{ k: '17', v: '7000' }]);
    expect(changes[0]!.change).toBeNull(); // a set has no arithmetic delta
  });
});

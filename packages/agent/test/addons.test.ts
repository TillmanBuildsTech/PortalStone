import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearAddonCache,
  fileId,
  findAddon,
  listAddonEntries,
  listAddons,
  readAddon,
  type AddonFile,
} from '../src/addons';
import type { InstallInfo } from '../src/discover';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-sv-'));
const SV = join(DIR, 'SavedVariables');
mkdirSync(SV, { recursive: true });

function install(files: { name: string; bytes: number; mtimeMs: number }[]): InstallInfo[] {
  return [{
    root: DIR,
    flavors: [
      {
        name: '_forever_',
        dir: DIR,
        logs: [],
        addons: [],
        accounts: [{ name: 'ACCOUNT1', dir: DIR, savedVariables: files }],
      },
    ],
  }];
}

function write(file: string, body: string): AddonFile {
  const path = join(SV, file);
  writeFileSync(path, body);
  const info: InstallInfo[] = install([{ name: file, bytes: Buffer.byteLength(body), mtimeMs: 1_700_000_000_000 }]);
  const listed = listAddons(info);
  expect(listed).toHaveLength(1);
  return listed[0]!;
}

/**
 * The base adapter's contract: every file resolves to a named state with a reason, never to a
 * crash or a silent empty table. These are the states the addons page renders.
 */
describe('savedvars base adapter', () => {
  it('reads an addon file and exposes its trackable properties', () => {
    clearAddonCache();
    const file = write(
      'BagBrother.lua',
      `BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = { ["money"] = 152079, ["class"] = "PALADIN" },
["Slouch Mage"] = { ["money"] = 370, ["class"] = "MAGE" },
},
}
`,
    );
    const read = readAddon(file);
    expect(read.state).toBe('ok');
    expect(read.summaries).toHaveLength(1);
    const money = read.summaries[0]!.numeric.find((c) => c.label === 'money')!;
    expect(money.numeric.max).toBe(152079);
    expect(money.numeric.min).toBe(370);
    expect(money.constant).toBe(false);
    expect(read.summaries[0]!.texts.map((t) => t.segment)).toContain('class');
    // the provider registry recognises the file even though nothing is adapter-specific yet
    expect(file.known?.caps).toContain('character.money');
  });

  it('treats `X = nil` as an empty file, not a broken one', () => {
    clearAddonCache();
    const read = readAddon(write('NilOnly.lua', '\r\nSmartNavigation_Mod_Options = nil\r\n'));
    expect(read.state).toBe('empty');
    expect(read.reason).toMatch(/nil/);
  });

  it('names the failure when an addon writes something it cannot read', () => {
    clearAddonCache();
    const read = readAddon(write('Broken.lua', 'Broken = { a = , b = }'));
    expect(read.state).toBe('unparseable');
    expect(read.reason).toMatch(/line/);
    expect(read.warnings.length).toBeGreaterThan(0);
  });

  it('reports a zero-byte file without trying to parse it', () => {
    clearAddonCache();
    const read = readAddon(write('Empty.lua', ''));
    expect(read.state).toBe('empty');
  });

  it('caches by path, size and mtime so a 60s scan does not re-parse the file', () => {
    clearAddonCache();
    const file = write('Cached.lua', 'X = { a = 1 }');
    const first = readAddon(file);
    const second = readAddon(file);
    expect(second).toBe(first);
    // a rewrite with a new mtime is a different file and must be re-read
    const path = join(SV, 'Cached.lua');
    writeFileSync(path, 'X = { a = 2 }');
    utimesSync(path, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    const changed = readAddon({ ...file, bytes: 12, mtimeMs: 1_700_000_100_000 });
    expect(changed).not.toBe(first);
    expect(changed.summaries[0]!.numeric[0]!.numeric.max).toBe(2);
  });

  it('only ever resolves ids to files it discovered itself', () => {
    clearAddonCache();
    const info = install([{ name: 'A.lua', bytes: 8, mtimeMs: 1 }]);
    const found = findAddon(info, fileId(join(DIR, 'SavedVariables', 'A.lua')));
    expect(found?.file).toBe('A.lua');
    expect(findAddon(info, '../../etc/passwd')).toBeUndefined();
    expect(findAddon(info, 'not-an-id')).toBeUndefined();
  });

  it('lists newest first and keeps flavor and account attached', () => {
    const info: InstallInfo[] = [{
      root: DIR,
      flavors: [
        {
          name: '_forever_',
          dir: DIR,
          logs: [],
          addons: [],
          accounts: [
            {
              name: 'A',
              dir: DIR,
              savedVariables: [
                { name: 'old.lua', bytes: 1, mtimeMs: 100 },
                { name: 'new.lua', bytes: 1, mtimeMs: 200 },
              ],
            },
          ],
        },
      ],
    }];
    expect(listAddons(info).map((f) => f.file)).toEqual(['new.lua', 'old.lua']);
    expect(listAddons(info)[0]!.flavor).toBe('_forever_');
    expect(listAddons(info)[0]!.account).toBe('A');
  });
});

/**
 * "Is this addon actually in use?" is answered from two facts: a SavedVariables file exists (it ran
 * at least once) and how old it is (whether it is still being played). A folder with a .toc and no
 * file is installed-but-never-configured, which is a different answer from missing.
 */
describe('addon entries', () => {
  const NOW = Date.now();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  function installWith(files: { name: string; body: string; ageMs: number }[], folders: string[]): InstallInfo[] {
    // files live in <account>/SavedVariables, as discovery reports them
    const accountDir = join(DIR, `acc-${Math.random().toString(36).slice(2)}`);
    const svDir = join(accountDir, 'SavedVariables');
    mkdirSync(svDir, { recursive: true });
    const savedVariables = files.map((f) => {
      const path = join(svDir, f.name);
      writeFileSync(path, f.body);
      const at = new Date(NOW - f.ageMs);
      utimesSync(path, at, at);
      return { name: f.name, bytes: Buffer.byteLength(f.body), mtimeMs: NOW - f.ageMs };
    });
    return [
      {
        root: DIR,
        flavors: [
          { name: '_forever_', dir: DIR, logs: [], addons: folders, accounts: [{ name: 'ACC', dir: accountDir, savedVariables }] },
        ],
      },
    ];
  }

  it('separates in use, idle, empty, unreadable and never-saved', () => {
    clearAddonCache();
    const installs = installWith(
      [
        { name: 'BagBrother.lua', body: 'BrotherBags = { forever = { gold = 1 } }', ageMs: 2 * HOUR },
        { name: 'Questie.lua', body: 'QuestieConfig = { a = 1 }', ageMs: 30 * DAY },
        { name: 'AtlasLootContinued.lua', body: 'AtlasLootDB = nil', ageMs: HOUR },
        { name: 'Broken.lua', body: 'Broken = { a = , }', ageMs: HOUR },
      ],
      ['BagBrother', 'Questie', 'AtlasLootContinued', 'Broken', 'DBM-Core'],
    );
    const entries = listAddonEntries(installs);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('BagBrother')!.status).toBe('in-use');
    expect(byName.get('Questie')!.status).toBe('idle');
    expect(byName.get('AtlasLootContinued')!.status).toBe('empty');
    expect(byName.get('Broken')!.status).toBe('unreadable');
    expect(byName.get('DBM-Core')!.status).toBe('no-data');
    expect(byName.get('DBM-Core')!.file).toBeUndefined();
    expect(byName.get('DBM-Core')!.installed).toBe(true);
  });

  it('folds modules and libraries out of the never-saved list', () => {
    clearAddonCache();
    const installs = installWith(
      [{ name: 'AtlasLootContinued.lua', body: 'AtlasLootDB = { x = 1 }', ageMs: HOUR }],
      ['AtlasLootContinued', 'AtlasLootContinued_Data', 'LibStub', 'LibSharedMedia-3.0', 'Standalone'],
    );
    const names = listAddonEntries(installs).map((e) => e.name);
    expect(names).toContain('AtlasLootContinued');
    expect(names).toContain('Standalone');
    expect(names).not.toContain('AtlasLootContinued_Data');
    expect(names).not.toContain('LibStub');
    expect(names).not.toContain('LibSharedMedia-3.0');
  });

  it('folds family modules that do not share the parent name exactly', () => {
    clearAddonCache();
    const installs = installWith(
      [{ name: 'DBM-Core.lua', body: 'DBM_AllSavedOptions = { a = 1 }', ageMs: HOUR }],
      ['DBM-Core', 'DBM-GUI', 'DBM-Midnight', 'DBM-Raids-Midnight'],
    );
    const names = listAddonEntries(installs).map((e) => e.name);
    expect(names).toEqual(['DBM-Core']);
  });

  it('lists Blizzard files separately from user addons', () => {
    clearAddonCache();
    const installs = installWith(
      [
        { name: 'BagBrother.lua', body: 'BrotherBags = { a = 1 }', ageMs: HOUR },
        { name: 'Blizzard_AuctionHouseUI.lua', body: 'g_auctionHouseSortsBySearchContext = { a = 1 }', ageMs: HOUR },
      ],
      ['BagBrother'],
    );
    const entries = listAddonEntries(installs);
    expect(entries.filter((e) => e.builtIn).map((e) => e.name)).toEqual(['Blizzard_AuctionHouseUI']);
    expect(entries.filter((e) => !e.builtIn).map((e) => e.name)).toEqual(['BagBrother']);
  });

  it('is configured only when a tracked value reads the addon', () => {
    clearAddonCache();
    const installs = installWith([{ name: 'BagBrother.lua', body: 'BrotherBags = { a = 1 }', ageMs: HOUR }], ['BagBrother']);

    // readable and in use, but nothing tracked from it: available, not configured
    const [idle] = listAddonEntries(installs);
    expect(idle!.status).toBe('in-use');
    expect(idle!.configured).toBe(false);
    expect(idle!.tracked).toEqual([]);

    const [configured] = listAddonEntries(installs, { tracked: [{ addonFile: 'BagBrother.lua', label: 'Gold' }] });
    expect(configured!.configured).toBe(true);
    expect(configured!.tracked).toEqual(['Gold']);
  });

  it('ignores flavors other than _forever_ for now', () => {
    clearAddonCache();
    const installs = installWith([{ name: 'BagBrother.lua', body: 'BrotherBags = { a = 1 }', ageMs: HOUR }], ['BagBrother']);
    expect(listAddonEntries(installs, { flavor: '_classic_era_' })).toEqual([]);
    expect(listAddonEntries(installs)).toHaveLength(1);
  });
});

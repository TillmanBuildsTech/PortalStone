import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { clearAddonCache } from '../src/addons';
import { ensureSensorMetrics, readSensor, SENSOR_FILE } from '../src/sensor';
import type { InstallInfo } from '../src/discover';

const open: Store[] = [];
const DIR = mkdtempSync(join(tmpdir(), 'portalstone-sensor-'));

function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

/**
 * A SavedVariables file as the addon writes it, and an install tree around it. Discovery is not
 * involved: the reader takes the install list the agent already has, so a fixture can hand it one.
 */
function installWith(name: string, body: string): InstallInfo {
  const accountDir = mkdtempSync(join(DIR, 'acct-'));
  const svDir = join(accountDir, 'SavedVariables');
  mkdirSync(svDir, { recursive: true });
  const path = join(svDir, name);
  writeFileSync(path, body);
  const st = statSync(path);
  clearAddonCache();
  return {
    root: accountDir,
    flavors: [
      {
        name: '_forever_',
        dir: accountDir,
        logs: [],
        accounts: [
          {
            name: 'LANC3RR1',
            dir: accountDir,
            savedVariables: [{ name, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) }],
          },
        ],
        addons: ['PortalstoneSense'],
      },
    ],
  };
}

const SENSOR = `PortalstoneDB = {
["schema"] = 1,
["updated"] = 1794790000,
["chars"] = {
["Dead Sadfatkid"] = {
["schema"] = 1,
["meta"] = {
["name"] = "Dead Sadfatkid",
["realm"] = "PvP-US",
["guid"] = "Player-6934-0194514D",
["class"] = "PALADIN",
["race"] = "Scourge",
["sex"] = 2,
["faction"] = "Horde",
["guild"] = "Origins",
["level"] = 32,
["zone"] = "Scarlet Monastery",
["updated"] = 1794790000,
},
["spec"] = {
["name"] = "Retribution",
["build"] = "0/31/20",
["points"] = 51,
["tab"] = "Retribution",
["role"] = "DAMAGER",
["group"] = 1,
["updated"] = 1794789990,
["tabs"] = {
{ ["name"] = "Holy", ["points"] = 0 },
{ ["name"] = "Protection", ["points"] = 20 },
{ ["name"] = "Retribution", ["points"] = 31 },
},
},
["stats"] = {
["str"] = 88,
["agi"] = 50,
["sta"] = 123,
["int"] = 111,
["armor"] = 1795,
["critMelee"] = 7.25,
},
["gear"] = {
["ilvl"] = 41,
["equipped"] = 16,
["slots"] = {
[1] = { ["id"] = 105626, ["name"] = "Bloodsoaked Helm", ["ilvl"] = 45, ["quality"] = 3 },
[16] = { ["id"] = 113630, ["name"] = "Arcanite Reaper", ["ilvl"] = 38, ["quality"] = 2 },
},
},
["professions"] = {
{ ["name"] = "Herbalism", ["skill"] = 225, ["max"] = 225 },
{ ["name"] = "Alchemy", ["skill"] = 180, ["max"] = 225 },
},
["lockouts"] = {
{ ["name"] = "Molten Core", ["id"] = 409, ["difficulty"] = 9, ["reset"] = 1794800000, ["locked"] = true },
},
["played"] = { ["total"] = 98233, ["level"] = 5120 },
["xp"] = { ["level"] = 32, ["current"] = 14000, ["max"] = 21000, ["rested"] = 8400 },
["money"] = 191101,
["group"] = {
{ ["name"] = "Royhunter-Holywarrior", ["class"] = "PALADIN", ["level"] = 34, ["role"] = "HEALER" },
},
["history"] = {
{ ["key"] = "Holy|31/20/0", ["spec"] = "Holy", ["build"] = "31/20/0", ["points"] = 51, ["at"] = 1794700000 },
{ ["key"] = "Retribution|0/31/20", ["spec"] = "Retribution", ["build"] = "0/31/20", ["points"] = 51, ["at"] = 1794789990 },
},
},
},
}
`;

/** A client that had no talents API and no gear API: the sections are simply absent. */
const SPARSE = `PortalstoneDB = {
["schema"] = 1,
["chars"] = {
["Slouch Mage"] = {
["meta"] = { ["name"] = "Slouch Mage", ["class"] = "MAGE", ["level"] = 15, ["updated"] = 1794790000 },
["spec"] = { ["name"] = "Frost", ["updated"] = 1794790000 },
},
},
}
`;

describe('readSensor', () => {
  it('reports missing when the addon was never installed', () => {
    const read = readSensor([]);
    expect(read.state).toBe('missing');
    expect(read.chars).toEqual([]);
  });

  it('projects the schema onto typed characters', () => {
    const read = readSensor([installWith(SENSOR_FILE, SENSOR)]);
    expect(read.state).toBe('ok');
    expect(read.chars).toHaveLength(1);
    const c = read.chars[0]!;
    expect(c.key).toBe('Dead Sadfatkid');
    expect(c.meta).toMatchObject({ class: 'PALADIN', race: 'Scourge', sex: 2, level: 32, guild: 'Origins', zone: 'Scarlet Monastery' });
    expect(c.spec).toMatchObject({ name: 'Retribution', build: '0/31/20', points: 51, role: 'DAMAGER', group: 1 });
    expect(c.spec!.tabs.map((t) => [t.name, t.points])).toEqual([
      ['Holy', 0],
      ['Protection', 20],
      ['Retribution', 31],
    ]);
    expect(c.gear).toMatchObject({ ilvl: 41, equipped: 16 });
    expect(c.gear!.slots.map((s) => [s.slot, s.id, s.name])).toEqual([
      [1, 105626, 'Bloodsoaked Helm'],
      [16, 113630, 'Arcanite Reaper'],
    ]);
    expect(c.professions).toEqual([
      { name: 'Herbalism', skill: 225, max: 225 },
      { name: 'Alchemy', skill: 180, max: 225 },
    ]);
    expect(c.lockouts[0]).toMatchObject({ name: 'Molten Core', locked: true, extended: false });
    expect(c.played).toEqual({ total: 98233, atLevel: 5120 });
    expect(c.xp).toEqual({ level: 32, current: 14000, max: 21000, rested: 8400 });
    expect(c.money).toBe(191101);
    expect(c.group[0]).toMatchObject({ name: 'Royhunter-Holywarrior', role: 'HEALER', level: 34 });
    // Newest last: the page reverses it for display.
    expect(c.history.map((h) => h.build)).toEqual(['31/20/0', '0/31/20']);
    expect(c.stats.critMelee).toBe(7.25);
  });

  it('keeps an absent API absent instead of inventing a zero', () => {
    const c = readSensor([installWith(SENSOR_FILE, SPARSE)]).chars[0]!;
    expect(c.spec!.build).toBeNull();
    expect(c.gear).toBeNull();
    expect(c.played).toBeNull();
    expect(c.xp).toBeNull();
    expect(c.lockouts).toEqual([]);
    expect(c.stats).toEqual({});
  });

  it('does not mistake an unrelated file for the sensor', () => {
    const read = readSensor([installWith('BagBrother.lua', 'BrotherBags = { ["forever"] = {} }')]);
    expect(read.state).toBe('missing');
    expect(read.file).toBeNull();
  });
});

describe('ensureSensorMetrics', () => {
  it('seeds one series per character for the numbers worth charting', () => {
    const s = store();
    const seeded = ensureSensorMetrics(s, readSensor([installWith(SENSOR_FILE, SENSOR)]));
    expect(seeded).toEqual([
      'Item level · Dead Sadfatkid',
      'Played · Dead Sadfatkid',
      'XP · Dead Sadfatkid',
      'Gold · Dead Sadfatkid',
    ]);
    const metrics = s.trackedMetrics();
    expect(metrics.map((m) => m.label)).toEqual(seeded);
    // Pinned to the character: two characters' item level must never be summed into one line.
    expect(metrics.every((m) => m.entity === 'Dead Sadfatkid')).toBe(true);
    expect(metrics.every((m) => m.addon_file === SENSOR_FILE)).toBe(true);
  });

  it('is idempotent, so a 60s rescan does not duplicate anything', () => {
    const s = store();
    const install = [installWith(SENSOR_FILE, SENSOR)];
    ensureSensorMetrics(s, readSensor(install));
    const again = ensureSensorMetrics(s, readSensor(install));
    expect(again).toEqual([]);
    expect(s.trackedMetrics()).toHaveLength(4);
  });

  it('seeds nothing when the addon is not there', () => {
    const s = store();
    expect(ensureSensorMetrics(s, readSensor([]))).toEqual([]);
    expect(s.trackedMetrics()).toHaveLength(0);
  });
});

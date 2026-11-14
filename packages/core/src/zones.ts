/**
 * What kind of place is this?
 *
 * Keyed by name, not id: Forever reuses zone ids across different zones (Durotar, Orgrimmar and
 * The Barrens all report id 1; Undercity and Tirisfal Glades both report 0), so the id is a
 * continent/world hint at best. Names are the only stable key in the log.
 *
 * Anything not listed is a plain 'zone', which is the safe default: the entry still appears as
 * its own segment, it just isn't labelled as an instance.
 */
export type ZoneKind = 'battleground' | 'dungeon' | 'raid' | 'city' | 'zone';

const KIND_BY_NAME: Record<string, ZoneKind> = {
  // battlegrounds
  'Warsong Gulch': 'battleground',
  'Arathi Basin': 'battleground',
  'Alterac Valley': 'battleground',

  // capitals
  Undercity: 'city',
  Orgrimmar: 'city',
  'Thunder Bluff': 'city',
  Darnassus: 'city',
  Stormwind: 'city',
  Ironforge: 'city',

  // classic dungeons
  'The Deadmines': 'dungeon',
  'Wailing Caverns': 'dungeon',
  'Ragefire Chasm': 'dungeon',
  'Shadowfang Keep': 'dungeon',
  'Blackfathom Deeps': 'dungeon',
  Gnomeregan: 'dungeon',
  'Razorfen Kraul': 'dungeon',
  'Razorfen Downs': 'dungeon',
  'Scarlet Monastery': 'dungeon',
  Uldaman: 'dungeon',
  "Zul'Farrak": 'dungeon',
  Maraudon: 'dungeon',
  'The Temple of Atal\'Hakkar': 'dungeon',
  'Blackrock Depths': 'dungeon',
  'Lower Blackrock Spire': 'dungeon',
  'Dire Maul': 'dungeon',
  Stratholme: 'dungeon',
  Scholomance: 'dungeon',

  // classic raids
  'Molten Core': 'raid',
  "Onyxia's Lair": 'raid',
  'Blackwing Lair': 'raid',
  "Zul'Gurub": 'raid',
  "Ruins of Ahn'Qiraj": 'raid',
  "Temple of Ahn'Qiraj": 'raid',
  Naxxramas: 'raid',
};

export function zoneKind(name: string | null | undefined): ZoneKind {
  if (!name) return 'zone';
  return KIND_BY_NAME[name] ?? 'zone';
}

/** Instances are the runs worth listing on their own; open-world zones roll up into a session. */
export function isInstance(kind: ZoneKind): boolean {
  return kind === 'dungeon' || kind === 'raid' || kind === 'battleground';
}

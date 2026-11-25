/**
 * The capability registry, as far as it is known today.
 *
 * `SPEC-providers-and-capabilities.md` names the capabilities; this table is the short list of
 * SavedVariables files the project expects to read them from. It is deliberately data, not code:
 * a file listed here is a *candidate* provider, and the SavedVariables browser shows what it
 * really exposes rather than trusting this table.
 */
export interface ProviderNote {
  /** stable provider id, independent of the file it came from */
  id: string;
  /** capabilities this provider is expected to satisfy */
  caps: string[];
}

export const PROVIDERS: Record<string, ProviderNote> = {
  'Attune.lua': { id: 'sv.attune', caps: ['progression.attunement', 'roster.levels'] },
  'RareScanner.lua': { id: 'sv.rarescan', caps: ['rare.spawns'] },
  'Questie.lua': { id: 'sv.questie', caps: ['quest.completion'] },
  'QuestieTrace.lua': { id: 'sv.questietrace', caps: ['world.mapdata'] },
  'BagBrother.lua': { id: 'sv.bagbrother', caps: ['character.money', 'character.inventory'] },
  'BagSync.lua': { id: 'sv.bagsync', caps: ['character.money', 'character.inventory'] },
  'Bagnon.lua': { id: 'sv.bagnon', caps: ['character.inventory'] },
  'AtlasLootContinued.lua': { id: 'sv.atlasloot', caps: ['world.loottables'] },
  'Blizzard_AuctionHouseUI.lua': { id: 'blizzard.auctionhouse', caps: ['auction.prices'] },
  'TradeSkillMaster.lua': { id: 'sv.tsm', caps: ['auction.prices', 'profession.skills', 'character.money'] },
  'DBM-Core.lua': { id: 'sv.dbm', caps: [] },
  'Plater.lua': { id: 'sv.plater', caps: [] },
  'HealBot.lua': { id: 'sv.healbot', caps: [] },
  // Our own addon. It exists for the capabilities no other file can supply: the combat log has no
  // talent event, no gear, no professions and no lockouts, and third-party rosters only know their
  // own members. See docs/SENSOR.md.
  'PortalStoneSense.lua': {
    id: 'addon.ours',
    caps: ['character.spec', 'character.gear', 'character.played', 'profession.skills', 'instance.lockouts', 'roster.group'],
  },
};

export function providerFor(fileName: string): ProviderNote | undefined {
  return PROVIDERS[fileName];
}

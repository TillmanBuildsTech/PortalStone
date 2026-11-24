/**
 * The small bits of character identity a 3D model engine needs that the rest of the app does not.
 *
 * Wowhead's model viewer (and its `wow-model-viewer` wrapper) picks a body from a numeric race id
 * and a gender flag. The addon records the race as the client's locale-independent token
 * ("NightElf", "Scourge") and the sex as UnitSex (1 unknown / 2 male / 3 female). This module is
 * the whole translation, kept in one place and tested, because a wrong number here is a wrong body.
 */

/** Race token (as `UnitRace`'s second return gives it) → the viewer's race id. */
const RACE_ID: Record<string, number> = {
  human: 1,
  orc: 2,
  dwarf: 3,
  nightelf: 4,
  // Undead's token is "Scourge"; accept the display word too, for data recorded by other means.
  scourge: 5,
  undead: 5,
  tauren: 6,
  gnome: 7,
  troll: 8,
  goblin: 9,
  bloodelf: 10,
  draenei: 11,
};

/** Normalize a race token to the map's key: lowercase, no spaces or punctuation. */
function raceKey(token: string): string {
  return token.toLowerCase().replace(/[^a-z]/g, '');
}

/** The viewer race id for a race token, or null when the token is unknown. */
export function raceId(token: string | null | undefined): number | null {
  if (!token) return null;
  return RACE_ID[raceKey(token)] ?? null;
}

/**
 * The viewer's gender flag from UnitSex: `0` female, `1` male.
 *
 * UnitSex is 3 for female and 2 for male. When it was never captured (null — a character last seen
 * before the addon recorded it) the body still has to be *something*; male is the fallback, and the
 * caller is expected to say the value is a guess.
 */
export function genderFromSex(sex: number | null | undefined): 0 | 1 {
  return sex === 3 ? 0 : 1;
}

/** True when the gender shown is the male fallback rather than a captured value. */
export function genderIsGuess(sex: number | null | undefined): boolean {
  return sex !== 2 && sex !== 3;
}

/**
 * The equipment slots the model engine actually draws. The addon captures all of inventory (rings,
 * trinkets, neck, shirt, tabard, bags), but the viewer only renders armor and weapons, so passing
 * the rest is wasted work and, for the shirt, visibly wrong — a shirt has no body geometry.
 *
 * Numbers are the client's inventory slot ids, which is what the addon keys gear by.
 */
export const RENDERABLE_SLOTS = new Set([1, 3, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19]);

export function isRenderableSlot(slot: number): boolean {
  return RENDERABLE_SLOTS.has(slot);
}

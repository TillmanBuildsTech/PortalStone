/**
 * Joining the two name spaces a player's data lives in.
 *
 * The combat log names a character `Slouch-Mage-PvP-US`: name, realm, faction, region, all one
 * string. The addon (BagBrother and friends) keys the same character `Slouch Mage`: a display
 * name with spaces, because that is what the game shows. Nothing in either file says these are the
 * same person, so the app has to decide — and a decision made silently is how a page ends up
 * showing one character's level under another's name.
 *
 * The rule here is deliberately narrow and is only ever used to *decide what to display*:
 *
 *   - drop a trailing `-<faction>-<region>` (`-PvP-US`), which the log adds and the addon does not
 *   - lowercase, and treat `-` and `_` as spaces
 *
 * It never rewrites stored data. A character's identity in the store stays the exact log name, and
 * a tracked series keeps the exact addon key; this only answers "is this the same person, near
 * enough to put their number on this page".
 */

const FACTION_REGION = /-(?:PvP|PvE|RP|RPPvP)-[A-Za-z]{2}$/;

/**
 * A comparable form of a character name.
 *
 * `Slouch-Mage-PvP-US` and `Slouch Mage` both become `slouch mage`. It is a heuristic: a name with
 * a trailing `-PvP-US` of its own would lose it, and two characters with the same display name on
 * different realms collapse together. Callers show the concrete name beside the number so a wrong
 * match is visible rather than hidden.
 */
export function normalizedCharacter(name: string): string {
  return name
    .trim()
    .replace(FACTION_REGION, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this addon key the same character as this combat-log name? */
export function sameCharacter(entity: string, character: string | null | undefined): boolean {
  if (!character) return false;
  const a = normalizedCharacter(entity);
  if (!a) return false;
  return a === normalizedCharacter(character);
}

/**
 * Is this addon character the scoped one?
 *
 * The guid decides whenever both sides have one: the sensor records it, the log always does, and it
 * is the only join that survives names that differ between sources — this server's log writes
 * `Dead-Sadfatkid-PvP-US` where the client's UnitName says `Dead`. Without a guid (BagBrother keeps
 * none) the name heuristic above is all there is.
 */
export function isCharacter(
  scoped: { name: string | null; guid: string | null },
  candidate: { name: string; guid: string | null },
): boolean {
  if (scoped.guid && candidate.guid) return scoped.guid === candidate.guid;
  return sameCharacter(candidate.name, scoped.name);
}

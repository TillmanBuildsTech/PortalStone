/**
 * Bag drops.
 *
 * "Unroll Bag" (spell 429961) is the only sleeping-bag event the combat log actually records: the
 * caster, the timestamp, and — from the stat block every cast carries — the position and the zone
 * at that moment. Everything else about a bag is inference:
 *
 *   - the camp buffs it hands out (Well-Rested 429959, Camp Benefits 1229741, Boosted Rest
 *     1229451) are applied source == destination, so no player is ever linked to the bag that
 *     buffed them;
 *   - a bag already on the ground keeps buffing people after its owner has walked away, with no
 *     unroll event anywhere near it;
 *   - aura lines carry no coordinates, so a player lying still cannot be placed at all.
 *
 * So this models drops and nothing else: who dropped a bag, where, and when. Hard events only.
 */

export interface Pos {
  x: number;
  y: number;
  map: string;
}

export interface BagDrop {
  ms: number;
  guid: string;
  name: string;
  /** the player whose logs these are */
  mine: boolean;
  zoneName: string;
  map: string;
  x: number;
  y: number;
}

export class BagCollector {
  private readonly drops: BagDrop[] = [];
  private zoneName = '';

  /** Zone as of now, so a drop is stamped with the zone it happened in, not the zone at EOF. */
  noteZone(name: string): void {
    if (name) this.zoneName = name;
  }

  drop(ms: number, guid: string, name: string, mine: boolean, pos: Pos): void {
    this.drops.push({
      ms,
      guid,
      name: name || 'unknown',
      mine,
      zoneName: this.zoneName,
      map: pos.map,
      x: pos.x,
      y: pos.y,
    });
  }

  finish(): BagDrop[] {
    // Newest first: a drop list is read backwards from now.
    return [...this.drops].sort((a, b) => b.ms - a.ms);
  }
}

/**
 * Camps: the sleeping bag, as far as a combat log can tell.
 *
 * "Unroll Bag" (429961) is the only hard event: it names who put a bag down, when, and (via the
 * stat block) where. The buffs a bag hands out — Well-Rested (429959), Camp Benefits (1229741),
 * Boosted Rest (1229451) — are always applied with source == destination, so the client grants
 * them to every player in range and never records whose bag it was. There is no "you are lying in
 * X's bag" line, and there never will be.
 *
 * So the unit of tracking is a CAMP: a place and a stretch of time with one or more bags down,
 * attended by whoever received a camp buff while inside it. Attendance comes in two grades and the
 * data says which one it is:
 *
 *   measured  the attendee had a position sample within a few minutes, and it was inside the
 *             radius — the distance is real
 *   timing    no position sample (auras carry no coordinates, and a player standing still emits
 *             nothing), so all we know is that they were buffed while this camp was the only one
 *             around
 *
 * Never report a timing attendee as if they were measured.
 */

export interface Pos {
  x: number;
  y: number;
  map: string;
}

export interface CampBag {
  ms: number;
  guid: string;
  name: string;
  mine: boolean;
  x: number;
  y: number;
  map: string;
  /** zone the bag was dropped in, as of that moment */
  zoneName?: string;
}

export interface CampAttendee {
  guid: string;
  name: string;
  firstMs: number;
  /** distance from the camp centre in yards, when a position sample existed */
  distanceY: number | null;
  basis: 'measured' | 'timing';
  mine: boolean;
  spells: string[];
}

export interface CampResult {
  startMs: number;
  endMs: number;
  zoneName: string;
  map: string;
  x: number;
  y: number;
  bags: CampBag[];
  attendees: CampAttendee[];
  myBags: number;
}

/** Bags this far apart in time and space are the same camp. */
const MERGE_MS = 5 * 60_000;
const MERGE_YARDS = 40;
/**
 * A camp is a sitting session, not an eternal campfire: bags can be dropped a few minutes apart
 * indefinitely, and chaining them would make one camp span an evening and "attend" a whole zone.
 */
const MAX_CAMP_MS = 15 * 60_000;
/** Anyone buffed this far from the camp centre was not in it. */
export const CAMP_RADIUS_YARDS = 15;
/** A camp stays "open" for attendance this long after its last bag. */
const ATTEND_AFTER_MS = 3 * 60_000;
const ATTEND_BEFORE_MS = 60_000;
/** How stale a position sample may be and still be used to measure a distance. */
const POSITION_WINDOW_MS = 3 * 60_000;

export function yards(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

interface CampDraft {
  bags: CampBag[];
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  map: string;
  zoneName: string;
}

export class CampCollector {
  private readonly bags: CampBag[] = [];
  private readonly buffs: { ms: number; guid: string; name: string; spell: string }[] = [];
  private readonly positions = new Map<string, (Pos & { ms: number })[]>();
  private zoneName = '';

  constructor(private readonly selfGuid: () => string | null) {}

  noteZone(name: string): void {
    if (name) this.zoneName = name;
  }

  /** Record a unit's position. Called for every event that carries a stat block. */
  position(guid: string, ms: number, pos: Pos): void {
    if (!guid || guid === '0000000000000000') return;
    let ring = this.positions.get(guid);
    if (!ring) {
      ring = [];
      this.positions.set(guid, ring);
    }
    ring.push({ ms, ...pos });
    // A handful of recent samples is all attendance needs, and a raid night is millions of lines.
    if (ring.length > 8) ring.splice(0, ring.length - 8);
  }

  unroll(ms: number, bag: CampBag): void {
    this.bags.push(bag);
  }

  buff(ms: number, guid: string, name: string, spell: string): void {
    if (!guid) return;
    this.buffs.push({ ms, guid, name, spell });
  }

  /** Nearest position sample for a unit, if one is close enough in time to mean anything. */
  private sampleFor(guid: string, ms: number): (Pos & { ms: number }) | null {
    const ring = this.positions.get(guid);
    if (!ring || ring.length === 0) return null;
    let best: (Pos & { ms: number }) | null = null;
    let bestGap = Infinity;
    for (const s of ring) {
      const gap = Math.abs(s.ms - ms);
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    return best && bestGap <= POSITION_WINDOW_MS ? best : null;
  }

  finish(): CampResult[] {
    if (this.bags.length === 0) return [];
    const drafts: CampDraft[] = [];
    for (const bag of [...this.bags].sort((a, b) => a.ms - b.ms)) {
      const open = drafts[drafts.length - 1];
      const joins =
        open &&
        bag.map === open.map &&
        bag.ms - open.endMs <= MERGE_MS &&
        bag.ms - open.startMs <= MAX_CAMP_MS &&
        yards(bag.x, bag.y, open.x, open.y) <= MERGE_YARDS;
      if (joins && open) {
        open.bags.push(bag);
        open.endMs = Math.max(open.endMs, bag.ms);
        continue;
      }
      drafts.push({
        bags: [bag],
        startMs: bag.ms,
        endMs: bag.ms,
        x: bag.x,
        y: bag.y,
        map: bag.map,
        zoneName: bag.zoneName ?? this.zoneName,
      });
    }

    const attendees = new Map<CampDraft, Map<string, CampAttendee>>();
    for (const camp of drafts) attendees.set(camp, new Map());

    for (const buff of this.buffs) {
      // Which camp was this buff for? Only camps on the same map, around the buff's time.
      const candidates = drafts.filter(
        (c) =>
          buff.ms >= c.startMs - ATTEND_BEFORE_MS && buff.ms <= c.endMs + ATTEND_AFTER_MS,
      );
      if (candidates.length === 0) continue;
      const sample = this.sampleFor(buff.guid, buff.ms);
      let camp: CampDraft | null = null;
      for (const c of candidates) {
        if (!sample) continue;
        if (sample.map !== c.map) continue;
        if (yards(sample.x, sample.y, c.x, c.y) > CAMP_RADIUS_YARDS) continue;
        if (!camp || buff.ms - c.startMs < buff.ms - camp.startMs) camp = c;
      }
      if (!camp) {
        // No usable position: only trustworthy when one camp could possibly apply. Two camps
        // nearby in time and we would be guessing.
        if (sample) continue; // we measured, and they were outside — not an attendee
        if (candidates.length !== 1) continue;
        camp = candidates[0]!;
      }
      const dist =
        sample && sample.map === camp.map
          ? Math.round(yards(sample.x, sample.y, camp.x, camp.y) * 10) / 10
          : null;
      const map = attendees.get(camp)!;
      const existing = map.get(buff.guid);
      if (existing) {
        existing.firstMs = Math.min(existing.firstMs, buff.ms);
        if (!existing.spells.includes(buff.spell)) existing.spells.push(buff.spell);
        if (dist !== null && (existing.distanceY === null || dist < existing.distanceY)) {
          existing.distanceY = dist;
          existing.basis = 'measured';
        }
      } else {
        map.set(buff.guid, {
          guid: buff.guid,
          name: buff.name,
          firstMs: buff.ms,
          distanceY: dist,
          basis: dist === null ? 'timing' : 'measured',
          mine: buff.guid === this.selfGuid(),
          spells: [buff.spell],
        });
      }
    }

    return drafts
      .map((camp) => ({
        startMs: camp.startMs,
        endMs: camp.endMs,
        zoneName: camp.zoneName,
        map: camp.map,
        x: camp.x,
        y: camp.y,
        bags: camp.bags,
        attendees: [...attendees.get(camp)!.values()].sort((a, b) => a.firstMs - b.firstMs),
        myBags: camp.bags.filter((b) => b.mine).length,
      }))
      .sort((a, b) => b.startMs - a.startMs);
  }
}

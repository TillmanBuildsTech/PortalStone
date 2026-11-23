/**
 * Sessionisation and rollup.
 *
 * Two grains, both kept, because they answer different questions:
 *   - encounter (ENCOUNTER_START/END): "how did the boss go"
 *   - session (activity window):        "what did this evening cost me"
 *
 * Attribution is by flag, not by name or guid equality: every unit you control (you, your pet,
 * your vehicle) carries COMBATLOG_OBJECT_AFFILIATION_MINE. Comparing guids to a single "self"
 * value — the prototype's approach — silently drops pet damage and breaks entirely on logs where
 * the player only ever appears as a target.
 */
import { BAG_SPELL, type LogEvent } from './decode';
import { BagCollector } from '../bags';
import { FLAG } from './fields';

type DamageEvent = Extract<LogEvent, { t: 'damage' }>;

export interface AbilityStat {
  id: number;
  name: string;
  amount: number;
  hits: number;
  crits: number;
}

/**
 * Casts are counted per spell *id*, not per name.
 *
 * Spell ranks share a name in the log ("Holy Light") but not an id (647, 1026, 1042), and the rank
 * number itself is never written down. Counting by id is therefore the only way to tell a rank-3
 * cast from a rank-5 one.
 */
export interface CastStat {
  id: number;
  name: string;
  casts: number;
}

export interface DeathRecord {
  ms: number;
  name: string;
  /** who landed the last hit — a player's name in PvP, 'unknown' when the log never said */
  killer: string;
  killerGuid: string | null;
  /** the killer was a player, not a creature: that is what makes a death PvP rather than PvE */
  killerPlayer: boolean;
  /** the ability that landed the last hit */
  spell: string;
  mine: boolean;
}

/**
 * One side of a player-versus-player exchange.
 *
 * `kill` is someone you killed; `death` is whoever killed you. Both carry the *person*, never the
 * mob and never the spell: "who killed me" is a question about a player, and the ability is
 * evidence, not an answer.
 */
export interface PvpRecord {
  ms: number;
  name: string;
  guid: string | null;
  /** the ability that landed it, '' when the log does not say (a PARTY_KILL line has no payload) */
  spell: string;
}

/** Fold one ability line into another (used when two segments of the same visit are merged). */
function mergeAbility(target: Map<number, AbilityStat>, key: number, v: AbilityStat): void {
  const cur = target.get(key);
  if (!cur) {
    target.set(key, { ...v });
    return;
  }
  cur.amount += v.amount;
  cur.hits += v.hits;
  cur.crits += v.crits;
}

interface LastHit {
  mine: boolean;
  /** the attacker's name: a player in PvP, the creature or pet that hit last otherwise */
  attacker: string;
  attackerGuid: string;
  /** the attacker was a player unit — the difference between a PvP death and a PvE one */
  player: boolean;
  spell: string;
}

/** The most recent hit landed by a player, kept even when a pet or a mob lands the last one. */
interface PlayerHit {
  guid: string;
  name: string;
  spell: string;
  ms: number;
}

export class Bag {
  damageDone = 0;
  damageTaken = 0;
  healingDone = 0;
  overheal = 0;
  hits = 0;
  crits = 0;
  casts = 0;
  interrupts = 0;
  kills = 0;
  /**
   * Units that died while this bag was open, regardless of who killed them — the mirror of
   * `deaths` (field deaths). In a group dungeon a healer lands almost no killing blows, so
   * `kills` alone reports "1 kill" for a run where eighty mobs died.
   */
  fieldKills = 0;
  deaths = 0;
  myDeaths = 0;
  engagedMs = 0;
  firstMs = 0;
  lastMs = 0;
  readonly damageByAbility = new Map<number, AbilityStat>();
  readonly healingByAbility = new Map<number, AbilityStat>();
  readonly castByAbility = new Map<number, CastStat>();
  readonly takenByAbility = new Map<number, AbilityStat>();
  readonly misses = new Map<string, number>();
  readonly castFailures = new Map<string, number>();
  readonly killedNames = new Map<string, number>();
  readonly deathLog: DeathRecord[] = [];
  /** player victims you landed the last hit on */
  readonly pvpKills: PvpRecord[] = [];
  /** players who landed the last hit on you */
  readonly pvpDeaths: PvpRecord[] = [];
  /** distinct players seen dying (one player can die several times) */
  readonly deathVictims = new Set<string>();

  private touch(ms: number): void {
    if (!this.firstMs || ms < this.firstMs) this.firstMs = ms;
    if (ms > this.lastMs) this.lastMs = ms;
  }

  /** Engaged time: consecutive activity gaps of <= 5s count as time actually spent fighting. */
  markActivity(ms: number): void {
    if (this.lastActivityMs !== 0) {
      const gap = ms - this.lastActivityMs;
      if (gap >= 0 && gap <= 5000) this.engagedMs += gap;
    }
    this.lastActivityMs = ms;
    this.touch(ms);
  }

  lastActivityMs = 0;

  /**
   * Fold another bag into this one. A zone change can flicker at an instance portal and split one
   * visit into two segments with the same name; folding them back is the only way the numbers add
   * up again. Engaged time takes the larger of the two rather than summing, so a gap between the
   * halves is not invented as combat time.
   */
  mergeFrom(other: Bag): void {
    this.damageDone += other.damageDone;
    this.damageTaken += other.damageTaken;
    this.healingDone += other.healingDone;
    this.overheal += other.overheal;
    this.hits += other.hits;
    this.crits += other.crits;
    this.casts += other.casts;
    this.interrupts += other.interrupts;
    this.kills += other.kills;
    this.fieldKills += other.fieldKills;
    this.deaths += other.deaths;
    this.myDeaths += other.myDeaths;
    this.engagedMs = Math.max(this.engagedMs, other.engagedMs);
    if (other.firstMs) this.firstMs = this.firstMs ? Math.min(this.firstMs, other.firstMs) : other.firstMs;
    this.lastMs = Math.max(this.lastMs, other.lastMs);
    this.lastActivityMs = Math.max(this.lastActivityMs, other.lastActivityMs);
    for (const [key, v] of other.damageByAbility) mergeAbility(this.damageByAbility, key, v);
    for (const [key, v] of other.castByAbility) {
      const cur = this.castByAbility.get(key);
      if (cur) cur.casts += v.casts;
      else this.castByAbility.set(key, { ...v });
    }
    for (const [key, v] of other.healingByAbility) mergeAbility(this.healingByAbility, key, v);
    for (const [key, v] of other.takenByAbility) mergeAbility(this.takenByAbility, key, v);
    for (const [key, v] of other.misses) this.misses.set(key, (this.misses.get(key) ?? 0) + v);
    for (const [key, v] of other.castFailures) {
      this.castFailures.set(key, (this.castFailures.get(key) ?? 0) + v);
    }
    for (const [key, v] of other.killedNames) {
      this.killedNames.set(key, (this.killedNames.get(key) ?? 0) + v);
    }
    this.deathLog.push(...other.deathLog);
    this.pvpKills.push(...other.pvpKills);
    this.pvpDeaths.push(...other.pvpDeaths);
    for (const victim of other.deathVictims) this.deathVictims.add(victim);
  }

  addDamage(spellId: number, spellName: string, amount: number, isCrit: boolean): void {
    this.damageDone += amount;
    this.hits++;
    if (isCrit) this.crits++;
    const key = spellId || -1;
    const cur = this.damageByAbility.get(key);
    if (cur) {
      cur.amount += amount;
      cur.hits++;
      if (isCrit) cur.crits++;
    } else {
      this.damageByAbility.set(key, {
        id: spellId,
        name: spellName,
        amount,
        hits: 1,
        crits: isCrit ? 1 : 0,
      });
    }
  }

  addCast(spellId: number, spellName: string): void {
    const key = spellId || -1;
    const cur = this.castByAbility.get(key);
    if (cur) cur.casts++;
    else this.castByAbility.set(key, { id: spellId, name: spellName, casts: 1 });
  }

  addTaken(spellId: number, spellName: string, amount: number): void {
    this.damageTaken += amount;
    const key = spellId || -1;
    const cur = this.takenByAbility.get(key);
    if (cur) {
      cur.amount += amount;
      cur.hits++;
    } else {
      this.takenByAbility.set(key, { id: spellId, name: spellName, amount, hits: 1, crits: 0 });
    }
  }

  addHeal(spellId: number, spellName: string, amount: number, overheal: number): void {
    this.healingDone += amount;
    this.overheal += overheal;
    const key = spellId || -1;
    const cur = this.healingByAbility.get(key);
    if (cur) {
      cur.amount += amount;
      cur.hits++;
    } else {
      this.healingByAbility.set(key, { id: spellId, name: spellName, amount, hits: 1, crits: 0 });
    }
  }

  bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  get durationMs(): number {
    return Math.max(this.lastMs - this.firstMs, 0);
  }

  snapshot(): BagSnapshot {
    const durS = this.durationMs / 1000;
    const engagedS = this.engagedMs / 1000;
    const top = (m: Map<number, AbilityStat>, n: number) =>
      [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, n);
    const counted = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      damageDone: this.damageDone,
      damageTaken: this.damageTaken,
      healingDone: this.healingDone,
      overheal: this.overheal,
      hits: this.hits,
      crits: this.crits,
      casts: this.casts,
      interrupts: this.interrupts,
      kills: this.kills,
      fieldKills: this.fieldKills,
      deaths: this.deaths,
      myDeaths: this.myDeaths,
      playersDied: this.deathVictims.size,
      durationS: round(durS, 1),
      engagedS: round(engagedS, 1),
      dps: durS > 0 ? round(this.damageDone / durS, 1) : 0,
      dpsEngaged: engagedS > 0 ? round(this.damageDone / engagedS, 1) : 0,
      hps: durS > 0 ? round(this.healingDone / durS, 1) : 0,
      topAbilities: top(this.damageByAbility, 12),
      topHealing: top(this.healingByAbility, 12),
      topDamageTaken: top(this.takenByAbility, 12),
      // One line per spell id, so two ranks of one spell stay two lines.
      topCasts: [...this.castByAbility.values()].sort((a, b) => b.casts - a.casts).slice(0, 20),
      misses: counted(this.misses, 6),
      castFailures: counted(this.castFailures, 6),
      topKills: counted(this.killedNames, 5),
      pvpKills: [...this.pvpKills],
      pvpDeaths: [...this.pvpDeaths],
      // Only your own deaths: who landed the finishing blow and with what, so the page can say
      // "what killed you" rather than only how many times. Other players' deaths are field deaths,
      // counted but not named here. Deaths are rare, so the whole list is kept, not a top-N.
      yourDeaths: this.deathLog
        .filter((d) => d.mine)
        .map((d) => ({
          ms: d.ms,
          killer: d.killer,
          killerGuid: d.killerGuid,
          killerPlayer: d.killerPlayer,
          spell: d.spell,
        })),
    };
  }
}

/** Your own death: the finishing blow, for the "what killed you" summary. */
export interface YourDeath {
  ms: number;
  killer: string;
  killerGuid: string | null;
  killerPlayer: boolean;
  spell: string;
}

export interface BagSnapshot {
  damageDone: number;
  damageTaken: number;
  healingDone: number;
  overheal: number;
  hits: number;
  crits: number;
  casts: number;
  interrupts: number;
  kills: number;
  /** units that died in this bag's window, whoever killed them */
  fieldKills: number;
  deaths: number;
  myDeaths: number;
  /** distinct players who died (deaths counts events; one player can die several times) */
  playersDied: number;
  durationS: number;
  engagedS: number;
  dps: number;
  dpsEngaged: number;
  hps: number;
  topAbilities: AbilityStat[];
  topHealing: AbilityStat[];
  topDamageTaken: AbilityStat[];
  /** casts per spell id, largest first: ranks of one spell are separate entries */
  topCasts: CastStat[];
  misses: [string, number][];
  castFailures: [string, number][];
  topKills: [string, number][];
  /** player-versus-player: who you killed, and who killed you, one record per event */
  pvpKills: PvpRecord[];
  pvpDeaths: PvpRecord[];
  /** your own deaths, each with the finishing blow — PvE and PvP alike */
  yourDeaths: YourDeath[];
}

export interface EncounterResult {
  kind: 'encounter';
  bossId: number;
  bossName: string;
  difficulty: number;
  size: number;
  success: boolean | null;
  bag: Bag;
}

export interface ZoneSegment {
  name: string;
  zoneId: number | null;
  startMs: number;
  endMs: number;
  /** everything that happened while in this zone */
  bag: Bag;
}

export interface SessionResult {
  kind: 'session';
  startMs: number;
  endMs: number;
  /**
   * Whose session this is.
   *
   * A log file is per *client launch*, not per character: log out to another toon and keep playing
   * without restarting, and both toons write into one file. The identity therefore belongs to the
   * session, not to the file — latching it once per read labelled every later session with the
   * first character's name.
   */
  selfGuid: string | null;
  selfName: string | null;
  /** byte offset in the log where this session's first event line began (for cheap resume) */
  startByte: number;
  offsetMin: number;
  zoneId: number | null;
  zoneName: string;
  /** every zone visit in this session, in order, with its own stats */
  zones: ZoneSegment[];
  open: Bag;
  encounters: EncounterResult[];
}

export interface AggregatorOptions {
  /** split sessions when nothing at all happens for this long (default 20 min) */
  sessionGapMs?: number;
  /** split an unterminated encounter after this long of silence (default 60 s) */
  encounterGapMs?: number;
  /** guids belonging to the player, for logs where affiliation flags are unreliable */
  selfGuids?: string[];
  /** zone already in effect when the first byte is read (resumed reads) */
  startZone?: { id: number | null; name: string };
  /**
   * Character already known when the first byte is read. A resumed read starts mid-session, after
   * the events that identified the player, so without this the re-read session would have no name.
   */
  startSelf?: { guid: string | null; name: string | null };
}

export class Aggregator {
  readonly sessions: SessionResult[] = [];
  selfGuid: string | null = null;
  selfName: string | null = null;
  advanced: boolean | null = null;
  build = '';
  projectId: number | null = null;
  zoneId: number | null = null;
  zoneName = '';
  offsetMin: number | null = null;
  firstMs = 0;
  lastMs = 0;
  unrecognised = 0;
  skipped = 0;

  private cur: SessionResult | null = null;
  private enc: EncounterResult | null = null;
  /**
   * Who hit a unit last, which is the only way the log attributes a kill.
   *
   * It used to store the spell name here, so `deathLog.killer` read "Fireball" or "Melee" where
   * a player's name belonged — fine for "what killed me", useless for "who killed me".
   */
  private readonly lastHitBy = new Map<string, LastHit>();
  /**
   * The last hit a *player* landed on a unit, with its time.
   *
   * A hunter's pet is the killing blow often enough to matter, and the log names the pet
   * ("Cockadile"), not its owner: the pet's guid has no owner in it and no summon line to follow.
   * So "who killed me" is answered by the last player who hit me just before I died — the person
   * whose pet it was — rather than by neither.
   */
  private readonly lastPlayerHitBy = new Map<string, PlayerHit>();
  /** how recently a player must have hit you for their pet's killing blow to count as theirs */
  private readonly playerHitWindowMs = 20_000;
  /** byte offset of the line currently being pushed, used to mark where a session began */
  private lastByte = 0;
  private readonly sessionGapMs: number;
  private readonly encounterGapMs: number;
  private readonly selfGuids: Set<string>;
  /** sleeping bags: every "Unroll Bag" cast, with who, where and when */
  readonly bagDrops = new BagCollector();

  constructor(opts: AggregatorOptions = {}) {
    this.sessionGapMs = opts.sessionGapMs ?? 20 * 60_000;
    this.encounterGapMs = opts.encounterGapMs ?? 60_000;
    this.selfGuids = new Set(opts.selfGuids ?? []);
    // Resumed reads start after the ZONE_CHANGE, so the caller hands back the zone in effect.
    if (opts.startZone) {
      this.zoneId = opts.startZone.id;
      this.zoneName = opts.startZone.name;
    }
    if (opts.startSelf) {
      this.selfGuid = opts.startSelf.guid;
      this.selfName = opts.startSelf.name;
    }
  }

  private get bag(): Bag {
    return this.ensureSession(this.lastMs, this.lastByte).open;
  }

  private ensureSession(ms: number, byteOffset = 0): SessionResult {
    const cur = this.cur;
    if (cur && ms - cur.endMs <= this.sessionGapMs) {
      cur.endMs = ms;
      return cur;
    }
    this.closeEncounter(null, cur?.endMs ?? ms);
    const s: SessionResult = {
      kind: 'session',
      startMs: ms,
      endMs: ms,
      // Whatever is known when the session opens: on a resumed read that comes from startSelf,
      // and otherwise noteSelf fills it in as soon as the player acts.
      selfGuid: this.selfGuid,
      selfName: this.selfName,
      startByte: byteOffset,
      offsetMin: this.offsetMin ?? 0,
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      zones: [this.newSegment(ms)],
      open: new Bag(),
      encounters: [],
    };
    this.sessions.push(s);
    this.cur = s;
    return s;
  }

  private closeEncounter(success: boolean | null, atMs: number): void {
    const e = this.enc;
    if (!e) return;
    e.success = success;
    if (atMs > e.bag.lastMs) e.bag.lastMs = atMs;
    this.enc = null;
  }

  private isMine(flags: number, guid: string): boolean {
    if ((flags & FLAG.MINE) !== 0) return true;
    return this.selfGuids.has(guid);
  }

  /**
   * Who is playing, and — when it changes — a new session for the new character.
   *
   * Only a `Player-` guid can become the self: every unit you control carries the affiliation flag,
   * pets and totems included, so accepting any flagged guid would have made the pet the player.
   * A *different* player guid carrying the flag is not noise — it is the client having switched
   * characters in the same log file, which is normal on a server where you relog between alts.
   *
   * The switch closes the open session so the next event starts a fresh one. One event (the one
   * that revealed the switch) still lands in the previous session: it was already counted before
   * this ran. That is one event of bleed, where the alternative was a whole file's worth.
   */
  private noteSelf(guid: string, name: string, flags: number): void {
    if (!guid.startsWith('Player-')) return; // pets carry the flag too; prefer the player
    if ((flags & FLAG.MINE) === 0 && !this.selfGuids.has(guid)) return;
    if (guid === this.selfGuid) {
      if (!this.selfName && name) {
        this.selfName = name;
        if (this.cur) this.cur.selfName = name;
      }
      return;
    }
    if (this.selfGuid === null) {
      // First identification of the read: the session already open belongs to this character, so
      // adopt it. Closing here would cut every session in two — one event, then the rest.
      this.selfGuid = guid;
      this.selfName = name || null;
      if (this.cur) {
        this.cur.selfGuid = this.selfGuid;
        this.cur.selfName = this.selfName;
      }
      return;
    }
    // A different player, with a character already known: the client switched toons in this file.
    if (this.cur) {
      this.closeEncounter(null, this.cur.endMs);
      this.cur = null;
    }
    this.selfGuid = guid;
    this.selfName = name || this.selfName;
  }

  /** Unmatched swing rolls, held for a moment so a landed twin can cancel them. Forever logs emit
   * both events for the same swing; counting both inflates autoattack damage by roughly 50%.
   */
  private readonly pendingSwings: DamageEvent[] = [];
  private readonly swingWindowMs = 300;

  /** Zones whose names overlap are the same place (the client emits both "Hillsbrad" and
   * "Hillsbrad Foothills" while you ride through). */
  private sameArea(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b) || b.startsWith(a);
  }

  /**
   * Close the open zone segment. Segments shorter than 20s with no combat are transit blips
   * (city gates, sub-zone crossings) and get absorbed into the previous segment rather than
   * becoming their own row.
   */
  private closeSegment(s: SessionResult, atMs: number): void {
    const seg = s.zones[s.zones.length - 1];
    if (!seg) return;
    seg.endMs = Math.max(seg.endMs, atMs);
    const short = seg.endMs - seg.startMs < 20_000;
    const empty = seg.bag.damageDone === 0 && seg.bag.kills === 0 && seg.bag.deaths === 0;
    if (short && empty && s.zones.length > 1) {
      s.zones.pop();
      const prev = s.zones[s.zones.length - 1];
      if (prev) prev.endMs = Math.max(prev.endMs, atMs);
    }
  }

  /**
   * Drop segments with no activity at all that sit between two visits to the same place — the
   * client emits a ZONE_CHANGE when you cross an instance portal, and it will happily report the
   * outside zone for a minute while nothing happens. A live dungeon run showed
   * "Barrens -> RFK -> Barrens(76s, nothing) -> RFK", which reads as if the player kept leaving.
   *
   * Only fully empty segments are dropped: one with any damage, kill, death or cast is a real
   * visit even if it is short.
   */
  private dropNoiseSegments(s: SessionResult): void {
    if (s.zones.length === 0) return;

    // 1. An empty visit that just flips back to where it came from, or that trails the log with
    //    nothing in it, is portal noise rather than a run. This has to happen before the merge
    //    below, or the two halves of one dungeon visit never become adjacent.
    const kept: ZoneSegment[] = [];
    const isEmpty = (seg: ZoneSegment): boolean =>
      seg.bag.damageDone === 0 &&
      seg.bag.kills === 0 &&
      seg.bag.deaths === 0 &&
      seg.bag.casts === 0 &&
      seg.bag.healingDone === 0;
    for (let i = 0; i < s.zones.length; i++) {
      const seg = s.zones[i]!;
      const prev = kept[kept.length - 1];
      const next = s.zones[i + 1];
      const flipsBack = !!prev && !!next && prev.name === next.name;
      const trailsOff = !next;
      if (isEmpty(seg) && (flipsBack || trailsOff)) continue;
      kept.push(seg);
    }

    // 2. Same place twice in a row is one visit: fold the numbers back together.
    const merged: ZoneSegment[] = [];
    for (const seg of kept) {
      const prev = merged[merged.length - 1];
      if (prev && prev.name === seg.name) {
        prev.bag.mergeFrom(seg.bag);
        prev.endMs = Math.max(prev.endMs, seg.endMs);
        continue;
      }
      merged.push(seg);
    }
    s.zones = merged.length > 0 ? merged : [s.zones[0]!];
  }

  private newSegment(ms: number): ZoneSegment {
    return {
      name: this.zoneName || 'unknown',
      zoneId: this.zoneId,
      startMs: ms,
      endMs: ms,
      bag: new Bag(),
    };
  }

  /**
   * Where an event is counted. The encounter bag (when a pull is open) or the session bag, plus
   * the zone segment, so a session can report both "the evening" and "the ten minutes in Warsong
   * Gulch" from one pass. The segment is a second sink, not a second parse.
   */
  private sinkBags(s: SessionResult): Bag[] {
    const primary = this.enc ? this.enc.bag : s.open;
    const seg = s.zones[s.zones.length - 1];
    return seg ? [primary, seg.bag] : [primary];
  }

  private applyDamage(ev: DamageEvent, ms: number): void {
    const s = this.ensureSession(ms, this.lastByte);
    const bags = this.sinkBags(s);
    const mineSrc = this.isMine(ev.srcFlags, ev.srcGuid);
    if (mineSrc && ev.amount > 0) {
      for (const bag of bags) {
        bag.addDamage(ev.spellId, ev.spellName, ev.amount, ev.isCrit);
        bag.markActivity(ms);
      }
      this.lastHitBy.set(ev.dstGuid, {
        mine: true,
        attacker: ev.srcName,
        attackerGuid: ev.srcGuid,
        player: (ev.srcFlags & FLAG.PLAYER) !== 0,
        spell: ev.spellName,
      });
      if ((ev.srcFlags & FLAG.PLAYER) !== 0) {
        this.lastPlayerHitBy.set(ev.dstGuid, {
          guid: ev.srcGuid,
          name: ev.srcName,
          spell: ev.spellName,
          ms,
        });
      }
    }
    if (this.isMine(ev.dstFlags, ev.dstGuid) && ev.amount > 0) {
      for (const bag of bags) bag.addTaken(ev.spellId, ev.spellName, ev.amount);
    }
    if (!mineSrc && ev.amount > 0) {
      this.lastHitBy.set(ev.dstGuid, {
        mine: false,
        attacker: ev.srcName,
        attackerGuid: ev.srcGuid,
        player: (ev.srcFlags & FLAG.PLAYER) !== 0,
        spell: ev.spellName,
      });
      if ((ev.srcFlags & FLAG.PLAYER) !== 0) {
        this.lastPlayerHitBy.set(ev.dstGuid, {
          guid: ev.srcGuid,
          name: ev.srcName,
          spell: ev.spellName,
          ms,
        });
      }
    }
  }

  private dropPendingMatch(landed: DamageEvent): void {
    const i = this.pendingSwings.findIndex(
      (p) =>
        p.srcGuid === landed.srcGuid &&
        p.dstGuid === landed.dstGuid &&
        Math.abs(p.ms - landed.ms) <= this.swingWindowMs,
    );
    if (i >= 0) this.pendingSwings.splice(i, 1);
  }

  private flushOldSwings(nowMs: number): void {
    while (this.pendingSwings.length > 0 && nowMs - this.pendingSwings[0]!.ms > this.swingWindowMs) {
      const ev = this.pendingSwings.shift()!;
      this.applyDamage(ev, ev.ms);
    }
  }

  push(ev: LogEvent, offsetMin: number, byteOffset = 0): void {
    this.lastByte = byteOffset;
    if (ev.t === 'version') {
      if (ev.advanced !== null) this.advanced = ev.advanced;
      if (ev.build) this.build = ev.build;
      if (ev.projectId !== null) this.projectId = ev.projectId;
      return;
    }
    if (this.offsetMin === null && 'ms' in ev) this.offsetMin = offsetMin;
    if (ev.t === 'unknown') {
      this.unrecognised++;
      return;
    }
    const ms = 'ms' in ev ? ev.ms : 0;
    if (ms) {
      if (!this.firstMs) this.firstMs = ms;
      if (ms > this.lastMs) this.lastMs = ms;
      this.flushOldSwings(ms);
    }

    if (ev.t === 'zone') {
      const next = ev.zoneName || this.zoneName;
      this.bagDrops.noteZone(next);
      const cur = this.cur ? this.cur.zones[this.cur.zones.length - 1] : undefined;
      if (cur && this.sameArea(cur.name, next)) {
        // Same place under a different label: keep the segment, keep the first name.
        if (ev.zoneId !== null) this.zoneId = ev.zoneId;
        return;
      }
      if (this.cur) this.closeSegment(this.cur, ms);
      if (ev.zoneName) this.zoneName = ev.zoneName;
      if (ev.zoneId !== null) this.zoneId = ev.zoneId;
      // A zone change ends the zone segment and the encounter, but not the play session: this
      // player crossed 99 zones in one evening, and every real visit is worth its own row.
      this.closeEncounter(null, ms);
      if (this.cur) {
        this.cur.zoneName = this.zoneName;
        this.cur.zones.push(this.newSegment(ms));
      }
      return;
    }

    if (ev.t === 'encounterStart') {
      const s = this.ensureSession(ms, this.lastByte);
      this.closeEncounter(null, ms);
      const e: EncounterResult = {
        kind: 'encounter',
        bossId: ev.bossId,
        bossName: ev.bossName || `encounter ${ev.bossId}`,
        difficulty: ev.difficulty,
        size: ev.size,
        success: null,
        bag: new Bag(),
      };
      e.bag.firstMs = ms;
      e.bag.lastMs = ms;
      s.encounters.push(e);
      this.enc = e;
      return;
    }

    if (ev.t === 'encounterEnd') {
      if (this.enc) {
        this.enc.success = ev.success;
        if (ms > this.enc.bag.lastMs) this.enc.bag.lastMs = ms;
        this.enc = null;
      }
      const s = this.ensureSession(ms, this.lastByte);
      s.endMs = ms;
      return;
    }

    // Who is acting, before anything is counted. A switch of character closes the open session
    // here, so the event that reveals it starts the new character's session rather than bleeding
    // into the previous one's totals.
    if (ev.t === 'damage' || ev.t === 'cast') this.noteSelf(ev.srcGuid, ev.srcName, ev.srcFlags);

    // Anything else is activity: it opens/extends a session and may time out an encounter.
    const s = this.ensureSession(ms, this.lastByte);
    if (this.enc && ms - this.enc.bag.lastMs > this.encounterGapMs) this.closeEncounter(null, ms);
    const bags = this.sinkBags(s);

    switch (ev.t) {
      case 'damage': {
        // Forever emits the same swing twice (a roll and a landed event). Rolls are held until
        // we know whether a landed twin arrives, otherwise every autoattack would count twice.
        if (ev.swing === 'roll') {
          this.pendingSwings.push(ev);
          return;
        }
        if (ev.swing === 'landed') this.dropPendingMatch(ev);
        this.applyDamage(ev, ms);
        return;
      }
      case 'heal': {
        if (this.isMine(ev.srcFlags, ev.srcGuid) && ev.amount + ev.overheal > 0) {
          for (const bag of bags) {
            bag.addHeal(ev.spellId, ev.spellName, ev.amount, ev.overheal);
            bag.markActivity(ms);
          }
        }
        return;
      }
      case 'miss': {
        if (this.isMine(ev.srcFlags, ev.srcGuid)) {
          for (const bag of bags) {
            bag.bump(bag.misses, ev.missType);
            bag.markActivity(ms);
          }
        }
        return;
      }
      case 'cast': {
        if (this.isMine(ev.srcFlags, ev.srcGuid)) {
          for (const bag of bags) {
            bag.casts++;
            bag.addCast(ev.spellId, ev.spellName);
            bag.markActivity(ms);
          }
        }
        if (ev.spellId === BAG_SPELL && ev.pos) {
          this.bagDrops.drop(ms, ev.srcGuid, ev.srcName, this.isMine(ev.srcFlags, ev.srcGuid), ev.pos);
        }
        return;
      }
      case 'castFailed': {
        if (this.isMine(ev.srcFlags, '')) {
          for (const bag of bags) {
            bag.bump(bag.castFailures, ev.reason);
            bag.markActivity(ms);
          }
        }
        return;
      }
      case 'interrupt': {
        if (this.isMine(ev.srcFlags, '')) {
          for (const bag of bags) {
            bag.interrupts++;
            bag.markActivity(ms);
          }
        }
        return;
      }
      case 'kill': {
        if (this.isMine(ev.srcFlags, ev.srcGuid)) {
          // PARTY_KILL carries no payload: the killer is us, the ability is unknown.
          this.lastHitBy.set(ev.dstGuid, {
            mine: true,
            attacker: '',
            attackerGuid: ev.srcGuid,
            player: false,
            spell: '',
          });
        }
        return;
      }
      case 'died': {
        const mine = this.isMine(ev.flags, ev.guid);
        const last = this.lastHitBy.get(ev.guid);
        const isPlayer = (ev.flags & FLAG.PLAYER) !== 0;
        const killedByMe = last?.mine === true && ev.guid !== this.selfGuid;
        // A player killed by someone other than themselves: that is PvP, and the killer's name is
        // the whole point of keeping it.
        const killer = last?.attacker || 'unknown';
        for (const bag of bags) {
          if (isPlayer) {
            bag.deaths++;
            bag.deathLog.push({
              ms,
              name: ev.name,
              killer,
              killerGuid: last?.attackerGuid ?? null,
              killerPlayer: last?.player === true,
              spell: last?.spell ?? '',
              mine,
            });
            if (mine) bag.myDeaths++;
            if (ev.guid) bag.deathVictims.add(ev.guid);
          }
          // A kill is a kill, PvE or PvP: if the last hit on this unit was ours, it died to us.
          // Battleground reports are meaningless without this — player victims were only
          // counted as deaths before.
          if (killedByMe) {
            bag.kills++;
            bag.bump(bag.killedNames, ev.name || 'unknown');
            // A player victim is PvP. Named, because "one of my kills was a person" is worth
            // less than "I killed Uncle-Garry, twice".
            if (isPlayer) {
              bag.pvpKills.push({
                ms,
                name: ev.name || 'unknown',
                guid: ev.guid || null,
                spell: last?.spell ?? '',
              });
            }
          }
          // They killed you. If a player landed the last hit, that is the answer; if a pet or a mob
        // did, the answer is the player who hit you moments before — a hunter's pet finishing you
        // is still the hunter. Neither present means the log does not say, and nothing is invented.
          if (mine && isPlayer) {
            const recent = this.lastPlayerHitBy.get(ev.guid);
            const byPlayer =
              last?.player === true && last.attackerGuid !== this.selfGuid
                ? { name: killer, guid: last.attackerGuid || null, spell: last.spell }
                : recent &&
                    recent.guid !== this.selfGuid &&
                    ms - recent.ms <= this.playerHitWindowMs &&
                    recent.name
                  ? { name: recent.name, guid: recent.guid, spell: recent.spell }
                  : null;
            if (byPlayer) bag.pvpDeaths.push({ ms, ...byPlayer });
          }
          // Field kills are not "yours": they are what died around you. Enemies in PvP are
          // counted as your kills only via the last-hit rule above, never here.
          if (!isPlayer) bag.fieldKills++;
          bag.markActivity(ms);
        }
        return;
      }
    }
  }

  finish(): { sessions: SessionResult[] } {
    while (this.pendingSwings.length > 0) {
      const ev = this.pendingSwings.shift()!;
      this.applyDamage(ev, ev.ms);
    }
    for (const s of this.sessions) {
      const last = s.zones[s.zones.length - 1];
      if (last) last.endMs = Math.max(last.endMs, s.endMs);
      this.dropNoiseSegments(s);
    }
    this.closeEncounter(null, this.lastMs);
    if (this.cur && this.lastMs > this.cur.startMs) this.cur.endMs = this.lastMs;
    return { sessions: this.sessions };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

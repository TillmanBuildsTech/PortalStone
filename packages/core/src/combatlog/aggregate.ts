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
import { CampCollector } from '../camps';
import { FLAG } from './fields';

type DamageEvent = Extract<LogEvent, { t: 'damage' }>;

export interface AbilityStat {
  id: number;
  name: string;
  amount: number;
  hits: number;
  crits: number;
}

export interface DeathRecord {
  ms: number;
  name: string;
  killer: string;
  mine: boolean;
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
  deaths = 0;
  myDeaths = 0;
  engagedMs = 0;
  firstMs = 0;
  lastMs = 0;
  readonly damageByAbility = new Map<number, AbilityStat>();
  readonly takenByAbility = new Map<number, AbilityStat>();
  readonly misses = new Map<string, number>();
  readonly castFailures = new Map<string, number>();
  readonly killedNames = new Map<string, number>();
  readonly deathLog: DeathRecord[] = [];
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

  addHeal(amount: number, overheal: number): void {
    this.healingDone += amount;
    this.overheal += overheal;
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
      deaths: this.deaths,
      myDeaths: this.myDeaths,
      playersDied: this.deathVictims.size,
      durationS: round(durS, 1),
      engagedS: round(engagedS, 1),
      dps: durS > 0 ? round(this.damageDone / durS, 1) : 0,
      dpsEngaged: engagedS > 0 ? round(this.damageDone / engagedS, 1) : 0,
      hps: durS > 0 ? round(this.healingDone / durS, 1) : 0,
      topAbilities: top(this.damageByAbility, 8),
      topDamageTaken: top(this.takenByAbility, 8),
      misses: counted(this.misses, 6),
      castFailures: counted(this.castFailures, 6),
      topKills: counted(this.killedNames, 5),
    };
  }
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
  topDamageTaken: AbilityStat[];
  misses: [string, number][];
  castFailures: [string, number][];
  topKills: [string, number][];
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
  private readonly lastHitBy = new Map<string, { mine: boolean; name: string }>();
  /** byte offset of the line currently being pushed, used to mark where a session began */
  private lastByte = 0;
  private readonly sessionGapMs: number;
  private readonly encounterGapMs: number;
  private readonly selfGuids: Set<string>;
  /** sleeping bags: who unrolled one, where, and who got buffed inside it */
  readonly camps = new CampCollector(() => this.selfGuid);

  constructor(opts: AggregatorOptions = {}) {
    this.sessionGapMs = opts.sessionGapMs ?? 20 * 60_000;
    this.encounterGapMs = opts.encounterGapMs ?? 60_000;
    this.selfGuids = new Set(opts.selfGuids ?? []);
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

  private noteSelf(guid: string, name: string, flags: number): void {
    if (this.selfGuid !== null) return;
    if ((flags & FLAG.MINE) === 0 && !this.selfGuids.has(guid)) return;
    if (!guid.startsWith('Player-')) return; // pets carry the flag too; prefer the player
    this.selfGuid = guid;
    this.selfName = name;
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
    this.noteSelf(ev.srcGuid, ev.srcName, ev.srcFlags);
    if (mineSrc && ev.amount > 0) {
      for (const bag of bags) {
        bag.addDamage(ev.spellId, ev.spellName, ev.amount, ev.isCrit);
        bag.markActivity(ms);
      }
      this.lastHitBy.set(ev.dstGuid, { mine: true, name: ev.spellName });
    }
    if (this.isMine(ev.dstFlags, ev.dstGuid) && ev.amount > 0) {
      for (const bag of bags) bag.addTaken(ev.spellId, ev.spellName, ev.amount);
    }
    if (!mineSrc && ev.amount > 0) {
      this.lastHitBy.set(ev.dstGuid, { mine: false, name: ev.spellName });
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
      this.camps.noteZone(next);
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

    // A camp buff is not combat and must not open a session: people idle at a bag for an hour.
    if (ev.t === 'campBuff') {
      this.camps.buff(ev.ms, ev.guid, ev.name, ev.spellName);
      return;
    }

    // Anything else is activity: it opens/extends a session and may time out an encounter.
    const s = this.ensureSession(ms, this.lastByte);
    if (this.enc && ms - this.enc.bag.lastMs > this.encounterGapMs) this.closeEncounter(null, ms);
    const bags = this.sinkBags(s);

    switch (ev.t) {
      case 'damage': {
        // Position first: swing rolls return early below, and a unit's position is still worth
        // recording even for a swing we only see half of.
        if (ev.pos) this.camps.position(ev.srcGuid, ev.ms, ev.pos);
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
            bag.addHeal(ev.amount, ev.overheal);
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
            bag.markActivity(ms);
          }
        }
        this.noteSelf(ev.srcGuid, ev.srcName, ev.srcFlags);
        if (ev.pos) {
          this.camps.position(ev.srcGuid, ms, ev.pos);
          if (ev.spellId === BAG_SPELL) {
            this.camps.unroll(ms, {
              ms,
              guid: ev.srcGuid,
              name: ev.srcName,
              mine: this.isMine(ev.srcFlags, ev.srcGuid),
              x: ev.pos.x,
              y: ev.pos.y,
              map: ev.pos.map,
              zoneName: this.zoneName,
            });
          }
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
          this.lastHitBy.set(ev.dstGuid, { mine: true, name: ev.dstName });
        }
        return;
      }
      case 'died': {
        const mine = this.isMine(ev.flags, ev.guid);
        const last = this.lastHitBy.get(ev.guid);
        const isPlayer = (ev.flags & FLAG.PLAYER) !== 0;
        const killedByMe = last?.mine === true && ev.guid !== this.selfGuid;
        for (const bag of bags) {
          if (isPlayer) {
            bag.deaths++;
            bag.deathLog.push({ ms, name: ev.name, killer: last?.name ?? 'unknown', mine });
            if (mine) bag.myDeaths++;
            if (ev.guid) bag.deathVictims.add(ev.guid);
          }
          // A kill is a kill, PvE or PvP: if the last hit on this unit was ours, it died to us.
          // Battleground reports are meaningless without this — player victims were only
          // counted as deaths before.
          if (killedByMe) {
            bag.kills++;
            bag.bump(bag.killedNames, ev.name || 'unknown');
          }
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

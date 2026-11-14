/**
 * Synthetic combat-log generator.
 *
 * Fixtures must be *shaped* correctly, not just illustrative: the prototype's fixture mixed
 * infoGUID and non-infoGUID lines in one file, which is why its offset bug survived. Each option
 * produces one internally consistent format, and the tests assert the same numbers appear
 * regardless of which format the bytes are in.
 *
 * Two formats:
 *   'v22'      infoGUID + optional stat block, payload anchored at the end of the line
 *   'forever'  8-field unit header + 19-field unit block, payload after the block, trailing
 *              `nil` padding (the shape observed in `_forever_` logs)
 */

export interface MakeLogOptions {
  format?: 'v22' | 'forever';
  /** v22 only: emit the leading infoGUID field */
  infoGuid?: boolean;
  /** v22 only: mid-line stat fields between the spell prefix and the payload */
  statBlock?: number;
  /** emit the COMBAT_LOG_VERSION header line */
  header?: boolean;
  advanced?: boolean;
  /** null = classic-era style timestamps with no year */
  year?: number | null;
  offsetMin?: number;
  zone?: { id: number; name: string } | null;
  /** a second zone, entered mid-log: damage after it is attributed to that zone */
  zone2?: { id: number; name: string } | null;
  /** casts emitted before the zone change, so the session begins in the first zone */
  zone1Casts?: number;
  encounter?: { id: number; name: string; difficulty: number; size: number; success: boolean } | null;
  playerDamage?: number[];
  bossDamage?: number[];
  /** kill another player (PvP): damage it, then it dies to you */
  enemyPlayerKills?: number;
  /** autoattack damage; `swingEvents` decides which event names carry it */
  swingDamage?: number[];
  swingEvents?: 'both' | 'roll' | 'landed';
  casts?: number;
  interrupts?: number;
  misses?: string[];
  mobKills?: number;
  playerDeath?: boolean;
  /** replace the hex flag fields with words, to force calibration failure */
  corruptFlags?: boolean;
  /** seconds between generated events */
  stepSeconds?: number;
  /**
   * A sleeping-bag drop: the player unrolls a bag. Guest names only add camp-buff lines, which are
   * noise the parser must ignore — nothing about a bag's attendees is recorded in the log.
   */
  bag?: { guests?: string[]; zone?: string } | null;
}

const PLAYER_GUID = 'Player-4385-0A1B2C3D';
const PLAYER_NAME = 'Slouch';
const BOSS_GUID = 'Creature-0-4385-1234-00001-ABCD';
const BOSS_NAME = 'Ragnaros';
const ENEMY_GUID = 'Player-9999-0000ENEMY';

const MINE = '0x0000000000000511';
const HOSTILE = '0x00000a48';

function flagsOf(opts: MakeLogOptions, hex: string): string {
  return opts.corruptFlags ? '"not-a-flag"' : hex;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatWall(wallMs: number, opts: MakeLogOptions): string {
  const d = new Date(wallMs);
  const year = opts.year === undefined ? 2026 : opts.year;
  const base = `${d.getUTCMonth() + 1}/${d.getUTCDate()}${year === null ? '' : `/${year}`}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(
    d.getUTCMilliseconds(),
    3,
  )}`;
  if (year === null) return `${base} ${time}`;
  const off = opts.offsetMin ?? -420;
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${base} ${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The 19-field block Forever puts between the header and the payload. */
function unitBlock(ownerGuid: string, dx = 0, dy = 0): string[] {
  return [
    ownerGuid,
    '0000000000000000',
    '1500',
    '1500',
    '500',
    '0',
    '900',
    '0',
    '0',
    '0',
    '0',
    '1200',
    '1200',
    '0',
    (-1200.5 + dx).toFixed(2),
    (250.5 + dy).toFixed(2),
    '1456',
    '3.1400',
    '35',
  ];
}

function damagePayload(opts: MakeLogOptions, amount: number, school: number, spellPrefixed: boolean): string[] {
  if (opts.format === 'forever') {
    const tail = [String(amount), String(amount), '-1', String(school), '0', '0', '0', 'nil', 'nil', 'nil'];
    return spellPrefixed ? [...tail, 'ST'] : tail;
  }
  // v22 / classic: payload anchored at the end, no nil padding
  return [String(amount), '0', String(school), '0', '0', '0', '0', '0', '0', '0'];
}

function healPayload(opts: MakeLogOptions, amount: number, overheal: number): string[] {
  if (opts.format === 'forever') {
    return [String(amount), String(amount), String(overheal), '0', 'nil'];
  }
  return [String(amount), String(overheal), '0', '0'];
}

export function makeLog(opts: MakeLogOptions = {}): string {
  const format = opts.format ?? 'v22';
  const infoGuid = format === 'forever' ? false : (opts.infoGuid ?? true);
  const statBlock = format === 'forever' ? 0 : (opts.statBlock ?? 10);
  const advanced = opts.advanced ?? true;
  const step = (opts.stepSeconds ?? 1) * 1000;
  let wall = Date.UTC(2026, 10, 12, 21, 0, 0, 0);
  const out: string[] = [];
  const stats = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));
  const block = (owner: string) => (format === 'forever' ? unitBlock(owner) : stats(statBlock));

  const line = (body: string): void => {
    out.push(`${formatWall(wall, opts)}  ${body}`);
    wall += step;
  };

  const header = (): string[] => [
    ...(infoGuid ? ['0000000000000000'] : []),
    PLAYER_GUID,
    PLAYER_NAME,
    flagsOf(opts, MINE),
    '0x0',
  ];

  if (opts.header ?? true) {
    line(`COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,${advanced ? '1' : '0'},BUILD_VERSION,1.60.1,PROJECT_ID,18`);
  }
  if (opts.zone) line(`ZONE_CHANGE,${opts.zone.id},"${opts.zone.name}"`);
  if (opts.encounter) {
    line(
      `ENCOUNTER_START,${infoGuid ? '0000000000000000,' : ''}${opts.encounter.id},"${opts.encounter.name}",${opts.encounter.difficulty},${opts.encounter.size}`,
    );
  }

  if (opts.zone1Casts) {
    // events in the first zone, so the session starts there before the zone change
    for (let i = 0; i < opts.zone1Casts; i++) {
      line(`SPELL_CAST_SUCCESS,${header().join(',')},0000000000000000,"nil",0x80000000,0x80000000,133,"Fireball",0x4,${block(PLAYER_GUID).join(',')}`);
    }
  }
  if (opts.zone2) {
    line(`ZONE_CHANGE,${opts.zone2.id},"${opts.zone2.name}"`);
  }

  for (const amount of opts.playerDamage ?? []) {
    line(
      `SPELL_DAMAGE,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,133,"Fireball",0x4,${block(BOSS_GUID).join(',')},${damagePayload(opts, amount, 4, true).join(',')}`,
    );
  }
  for (const amount of opts.bossDamage ?? []) {
    line(
      `SPELL_DAMAGE,${infoGuid ? '0000000000000000,' : ''}${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,${PLAYER_GUID},"${PLAYER_NAME}",${flagsOf(opts, MINE)},0x0,2170,"Molten Blast",0x4,${block(PLAYER_GUID).join(',')},${damagePayload(opts, amount, 4, true).join(',')}`,
    );
  }
  for (const amount of opts.swingDamage ?? []) {
    const events = opts.swingEvents ?? 'both';
    const names =
      events === 'both'
        ? ['SWING_DAMAGE', 'SWING_DAMAGE_LANDED']
        : [events === 'roll' ? 'SWING_DAMAGE' : 'SWING_DAMAGE_LANDED'];
    // A real log emits the roll and the landed twin at the same millisecond, so do the same:
    // advancing the clock between them would make the fixture test a situation that never occurs.
    for (const ev of names) {
      out.push(
        `${formatWall(wall, opts)}  ${ev},${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,${block(BOSS_GUID).join(',')},${damagePayload(opts, amount, 1, false).join(',')}`,
      );
    }
    wall += step;
  }
  for (let i = 0; i < (opts.casts ?? 0); i++) {
    line(
      `SPELL_CAST_SUCCESS,${header().join(',')},0000000000000000,"nil",0x80000000,0x80000000,133,"Fireball",0x4,${block(PLAYER_GUID).join(',')}`,
    );
  }
  for (let i = 0; i < (opts.interrupts ?? 0); i++) {
    line(
      `SPELL_INTERRUPT,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,2139,"Counterspell",0x40,2170,"Molten Blast",0x4`,
    );
  }
  for (const miss of opts.misses ?? []) {
    line(
      `SPELL_MISSED,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,133,"Fireball",0x4,${miss},0,0,0`,
    );
  }
  for (let i = 0; i < (opts.mobKills ?? 0); i++) {
    // The unit that dies is the one the player has been hitting, so last-hit attribution works.
    line(
      `UNIT_DIED,${infoGuid ? '0000000000000000,' : ''}${BOSS_GUID},"${BOSS_NAME}",${flagsOf(opts, HOSTILE)},0x0,0000000000000000,"nil",0x80000000,0x80000000,0`,
    );
  }
  for (let i = 0; i < (opts.enemyPlayerKills ?? 0); i++) {
    // PvP: damage an enemy player, then it dies. This must count as a kill, not just a death.
    line(
      `SPELL_DAMAGE,${header().join(',')},${ENEMY_GUID},"Red-Tester-PvP-US",${flagsOf(opts, '0x00000548')},0x0,133,"Fireball",0x4,${block(ENEMY_GUID).join(',')},${damagePayload(opts, 900, 4, true).join(',')}`,
    );
    line(
      `UNIT_DIED,${infoGuid ? '0000000000000000,' : ''}0000000000000000,"nil",0x80000000,0x80000000,${ENEMY_GUID},"Red-Tester-PvP-US",${flagsOf(opts, '0x00000548')},0x80000000,0`,
    );
  }
  if (opts.playerDeath) {
    line(
      `UNIT_DIED,${infoGuid ? '0000000000000000,' : ''}0000000000000000,"nil",0x80000000,0x80000000,${PLAYER_GUID},"${PLAYER_NAME}",${flagsOf(opts, MINE)},0x80000000,0`,
    );
  }
  if (opts.encounter) {
    line(
      `ENCOUNTER_END,${infoGuid ? '0000000000000000,' : ''}${opts.encounter.id},"${opts.encounter.name}",${opts.encounter.difficulty},${opts.encounter.size},${opts.encounter.success ? 1 : 0}`,
    );
  }

  if (opts.bag) {
    if (opts.bag.zone) line(`ZONE_CHANGE,1,"${opts.bag.zone}",0`);
    // The bag itself: the only sleeping-bag event the log records.
    line(
      `SPELL_CAST_SUCCESS,${header().join(',')},0000000000000000,"nil",0x80000000,0x80000000,429961,"Unroll Bag",0x1,${block(PLAYER_GUID).join(',')}`,
    );
    // Camp buffs are self-applied and must never be mistaken for bag events.
    const selfHeader = `${header().join(',')},${PLAYER_GUID},${PLAYER_NAME},${flagsOf(opts, MINE)},0x0`;
    line(`SPELL_AURA_APPLIED,${selfHeader},429959,"Well-Rested",0x1,BUFF`);
    for (const [i, guest] of (opts.bag.guests ?? []).entries()) {
      const guid = `Player-6798-00B4${String(i).padStart(10, '0')}`;
      line(
        `SPELL_AURA_APPLIED,${guid},"${guest}",0x518,0x0,${guid},"${guest}",0x518,0x0,1229741,"Camp Benefits",0x1,BUFF`,
      );
    }
  }

  return out.join('\n') + '\n';
}

/** Repeat a log until it exceeds `bytes` (for benchmarks). */
export function stretchLog(log: string, bytes: number): string {
  const parts: string[] = [log];
  let size = Buffer.byteLength(log);
  while (size < bytes) {
    parts.push(log);
    size += Buffer.byteLength(log);
  }
  return parts.join('');
}

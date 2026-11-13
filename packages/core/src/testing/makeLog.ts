/**
 * Synthetic combat-log generator.
 *
 * Fixtures must be *shaped* correctly, not just illustrative: the prototype's fixture mixed
 * infoGUID and non-infoGUID lines in one file, which is why its offset bug survived. Each option
 * here produces one internally consistent format, and the tests assert the same numbers appear
 * regardless of which format the bytes are in.
 */

export interface MakeLogOptions {
  /** emit the leading infoGUID field (format 22+ with advanced logging) */
  infoGuid?: boolean;
  /** count of mid-line stat/power fields between the spell prefix and the damage suffix */
  statBlock?: number;
  /** emit the COMBAT_LOG_VERSION header line */
  header?: boolean;
  advanced?: boolean;
  /** null = classic-era style timestamps with no year */
  year?: number | null;
  offsetMin?: number;
  zone?: { id: number; name: string } | null;
  encounter?: { id: number; name: string; difficulty: number; size: number; success: boolean } | null;
  playerDamage?: number[];
  bossDamage?: number[];
  casts?: number;
  interrupts?: number;
  misses?: string[];
  mobKills?: number;
  playerDeath?: boolean;
  /** replace the hex flag fields with words, to force calibration failure */
  corruptFlags?: boolean;
  /** seconds between generated events */
  stepSeconds?: number;
}

const PLAYER_GUID = 'Player-4385-0A1B2C3D';
const PLAYER_NAME = 'Slouch';
const BOSS_GUID = 'Creature-0-4385-1234-00001-ABCD';
const BOSS_NAME = 'Ragnaros';

const MINE = '0x0000000000000511';
const HOSTILE = '0x00000a48';
const BOSS_FLAGS = '0x00001048';

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

export function makeLog(opts: MakeLogOptions = {}): string {
  const o: Required<Pick<MakeLogOptions, 'infoGuid' | 'statBlock' | 'header' | 'advanced'>> & MakeLogOptions = {
    infoGuid: opts.infoGuid ?? true,
    statBlock: opts.statBlock ?? 10,
    header: opts.header ?? true,
    advanced: opts.advanced ?? true,
    ...opts,
  };
  const step = (opts.stepSeconds ?? 1) * 1000;
  let wall = Date.UTC(2026, 10, 12, 21, 0, 0, 0);
  const out: string[] = [];
  const stats = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));

  const line = (body: string): void => {
    out.push(`${formatWall(wall, o)}  ${body}`);
    wall += step;
  };

  const header = (): string[] => [
    ...(o.infoGuid ? ['0000000000000000'] : []),
    PLAYER_GUID,
    PLAYER_NAME,
    flagsOf(o, MINE),
    '0x0',
  ];

  if (o.header) {
    line(`COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,${o.advanced ? '1' : '0'},BUILD_VERSION,11.0.5,PROJECT_ID,1`);
  }
  if (opts.zone) line(`ZONE_CHANGE,${opts.zone.id},"${opts.zone.name}"`);
  if (opts.encounter) {
    line(
      `ENCOUNTER_START,${o.infoGuid ? '0000000000000000,' : ''}${opts.encounter.id},"${opts.encounter.name}",${opts.encounter.difficulty},${opts.encounter.size}`,
    );
  }

  for (const amount of opts.playerDamage ?? []) {
    line(
      `SPELL_DAMAGE,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(o, HOSTILE)},0x0,133,"Fireball",4,${stats(o.statBlock).join(',')},${amount},0,4,0,0,0,0,0,0,0`,
    );
  }
  for (const amount of opts.bossDamage ?? []) {
    line(
      `SPELL_DAMAGE,${o.infoGuid ? '0000000000000000,' : ''}${BOSS_GUID},"${BOSS_NAME}",${flagsOf(o, HOSTILE)},0x0,${PLAYER_GUID},"${PLAYER_NAME}",${flagsOf(o, MINE)},0x0,2170,"Molten Blast",4,${stats(o.statBlock).join(',')},${amount},0,4,0,0,0,0,0,0,0`,
    );
  }
  for (let i = 0; i < (opts.casts ?? 0); i++) {
    line(`SPELL_CAST_SUCCESS,${header().join(',')},133,"Fireball",4`);
  }
  for (let i = 0; i < (opts.interrupts ?? 0); i++) {
    line(
      `SPELL_INTERRUPT,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(o, HOSTILE)},0x0,2139,"Counterspell",64,2170,"Molten Blast",4`,
    );
  }
  for (const miss of opts.misses ?? []) {
    line(
      `SPELL_MISSED,${header().join(',')},${BOSS_GUID},"${BOSS_NAME}",${flagsOf(o, HOSTILE)},0x0,133,"Fireball",4,${miss},0,0,0`,
    );
  }
  for (let i = 0; i < (opts.mobKills ?? 0); i++) {
    // The unit that dies here is the boss the player has been hitting, so the kill can be
    // attributed through last-hit tracking — a mob that was never damaged is not a kill.
    line(
      `UNIT_DIED,${o.infoGuid ? '0000000000000000,' : ''}${BOSS_GUID},"${BOSS_NAME}",${flagsOf(o, HOSTILE)},0x0,0000000000000000,"nil",0x80000000,0x80000000`,
    );
  }
  if (opts.playerDeath) {
    line(
      `UNIT_DIED,${o.infoGuid ? '0000000000000000,' : ''}${PLAYER_GUID},"${PLAYER_NAME}",${flagsOf(o, MINE)},0x0,0000000000000000,"nil",0x80000000,0x80000000`,
    );
  }
  if (opts.encounter) {
    line(
      `ENCOUNTER_END,${o.infoGuid ? '0000000000000000,' : ''}${opts.encounter.id},"${opts.encounter.name}",${opts.encounter.difficulty},${opts.encounter.size},${opts.encounter.success ? 1 : 0}`,
    );
  }

  return out.join('\n') + '\n';
}

/** Repeat a log body until it exceeds `bytes`, rewriting only the file's shape (not its times). */
export function stretchLog(log: string, bytes: number): string {
  const head = log;
  const parts: string[] = [head];
  let size = Buffer.byteLength(head);
  while (size < bytes) {
    parts.push(head);
    size += Buffer.byteLength(head);
  }
  return parts.join('');
}

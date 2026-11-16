/**
 * One log file, two characters.
 *
 * A combat log belongs to a client launch, not to a character: logging out to an alt and back in
 * without restarting the game keeps appending to the same file. The identity therefore has to be
 * per *session*. It used to be latched once per read, so every session after the first was stamped
 * with whichever character happened to act first.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-identity-'));

const PALADIN = { guid: 'Player-6934-0194514D', name: 'Dead-Sadfatkid-PvP-US' };
const MAGE = { guid: 'Player-6934-02E64FED', name: 'Slouch-Mage-PvP-US' };

/** One character's play, written at a fixed wall clock so two of them can be hours apart. */
function play(player: { guid: string; name: string }, startAt: number, damage: number[]): string {
  return makeLog({ format: 'forever', player, startAt, playerDamage: damage });
}

async function run(name: string, text: string) {
  const path = join(DIR, name);
  writeFileSync(path, text);
  const res = await ingest({ path });
  if (!res.ok) throw new Error(`${res.reason}: ${res.detail}`);
  return res;
}

describe('two characters in one log file', () => {
  const T = Date.UTC(2026, 10, 14, 9, 0, 0, 0);

  it('names each session after the character who played it', async () => {
    // The mage plays first, then — two hours later, past the session gap — the paladin logs in.
    const text = play(MAGE, T, [10, 11, 12, 13, 14]) + play(PALADIN, T + 2 * 3600_000, [20, 21, 22, 23, 24]);
    const res = await run('two.txt', text);

    expect(res.sessions).toHaveLength(2);
    expect(res.sessions[0]!.selfName).toBe(MAGE.name);
    expect(res.sessions[1]!.selfName).toBe(PALADIN.name);
    expect(res.sessions[0]!.selfGuid).toBe(MAGE.guid);
    expect(res.sessions[1]!.selfGuid).toBe(PALADIN.guid);
  });

  it('splits the session when the character changes even without a long gap', async () => {
    // A relog is quick: the second session starts 90 seconds later, well inside the 20-minute gap
    // that normally keeps one sitting together. Two characters is a harder boundary than a pause.
    const text = play(MAGE, T, [10, 11, 12, 13, 14]) + play(PALADIN, T + 90_000, [20, 21, 22, 23, 24]);
    const res = await run('quick.txt', text);

    expect(res.sessions).toHaveLength(2);
    expect(res.sessions.map((s) => s.selfName)).toEqual([MAGE.name, PALADIN.name]);
    // the paladin's damage belongs to the paladin's session, not the mage's
    expect(res.sessions[0]!.open.damageDone).toBe(60);
    expect(res.sessions[1]!.open.damageDone).toBe(110);
  });

  it('keeps the session that is still open attributed to its own character', async () => {
    // The paladin's session is the last one and has no closing event: the common case while playing.
    const text = play(PALADIN, T, [10, 11, 12, 13, 14]);
    const res = await run('open.txt', text);
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0]!.selfName).toBe(PALADIN.name);
  });

  it('reports the last character seen at file level, for the log record', async () => {
    const text = play(MAGE, T, [10, 11, 12, 13, 14]) + play(PALADIN, T + 2 * 3600_000, [20, 21, 22, 23, 24]);
    const res = await run('last.txt', text);
    // the file's own record answers "who is this log", which is the newest character
    expect(res.selfName).toBe(PALADIN.name);
  });
});

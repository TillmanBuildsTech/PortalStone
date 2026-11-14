import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/combatlog/ingest';
import { makeLog } from '../src/testing/makeLog';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-resume-'));

/**
 * Incremental scans re-read the open session from its own starting byte, which is *after* the
 * ZONE_CHANGE that set the zone. Without a seed the re-read session comes back named "unknown",
 * which is what a live dungeon session showed before this was fixed.
 */
describe('resumed reads', () => {
  const log = makeLog({
    format: 'forever',
    playerDamage: [1000, 1100, 1200, 1300, 1400],
    zone: { id: 1, name: 'The Barrens' },
  });
  const path = join(DIR, 'resume.txt');
  writeFileSync(path, log);
  const cut = Buffer.byteLength(log.slice(0, log.indexOf('\n', log.indexOf('ZONE_CHANGE')) + 1));

  it('loses the zone when the read starts after ZONE_CHANGE, with no seed', async () => {
    const res = await ingest({ path, startOffset: cut });
    if (!res.ok) throw new Error(res.reason);
    expect(res.sessions[0]!.zones[0]!.name).toBe('unknown');
  });

  it('keeps the zone when the caller seeds it', async () => {
    const res = await ingest({ path, startOffset: cut, startZone: { id: 1, name: 'The Barrens' } });
    if (!res.ok) throw new Error(res.reason);
    expect(res.sessions[0]!.zones[0]!.name).toBe('The Barrens');
    expect(res.sessions[0]!.zoneName).toBe('The Barrens');
  });
});

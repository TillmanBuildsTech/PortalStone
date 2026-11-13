#!/usr/bin/env node
/**
 * P0 CLI: proves the parser against a real or generated log.
 *
 *   tsx src/cli.ts report <logfile> [--json] [--self GUID] [--session-gap-min N]
 *   tsx src/cli.ts make <outfile> --mb 500 [--layout adv19|adv10|plain|corrupt]
 */
import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { ingest } from './combatlog/ingest';
import { makeLog, type MakeLogOptions } from './testing/makeLog';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtClock(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === 'make') {
    const out = process.argv[3];
    if (!out) throw new Error('make requires an output path');
    const mb = Number(arg('mb', '10'));
    const layout = arg('layout', 'adv19');
    const opts: MakeLogOptions = {
      infoGuid: layout !== 'plain',
      statBlock: layout === 'adv19' ? 19 : layout === 'adv10' ? 10 : 0,
      corruptFlags: layout === 'corrupt',
      zone: { id: 1456, name: 'Orgrimmar' },
      encounter: { id: 1234, name: 'Ragnaros', difficulty: 4, size: 20, success: true },
      playerDamage: [12000, 13500, 11000, 14200, 12800, 11900, 15100, 13300],
      bossDamage: [2600, 2800, 2400],
      casts: 6,
      interrupts: 2,
      misses: ['DODGE', 'MISS'],
      mobKills: 2,
      playerDeath: true,
    };
    const one = makeLog(opts);
    const target = Math.max(mb, 1) * 1024 * 1024;
    const fd = openSync(out, 'w');
    try {
      let written = 0;
      while (written < target) {
        writeSync(fd, one);
        written += Buffer.byteLength(one);
      }
    } finally {
      closeSync(fd);
    }
    console.log(`wrote ${out}: ${(statSync(out).size / 1048576).toFixed(1)} MB, layout=${layout}`);
    return;
  }

  if (mode !== 'report') {
    console.log(
      [
        'usage:',
        '  report <logfile> [--json] [--self GUID,GUID] [--session-gap-min N] [--max-mb N]',
        '  make <outfile> --mb 500 [--layout adv19|adv10|plain|corrupt]',
      ].join('\n'),
    );
    process.exit(2);
  }

  const path = process.argv[3];
  if (!path) throw new Error('report requires a log path');
  const selfArg = arg('self');
  const sessionGap = arg('session-gap-min');
  const maxMb = arg('max-mb');

  const res = await ingest({
    path,
    ...(selfArg ? { selfGuids: selfArg.split(',') } : {}),
    ...(sessionGap ? { sessionGapMs: Number(sessionGap) * 60_000 } : {}),
    ...(maxMb ? { maxBytes: Number(maxMb) * 1024 * 1024 } : {}),
  });

  if (has('json')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (!res.ok) {
    console.log(`FAILED: ${res.reason}`);
    console.log(`  ${res.detail}`);
    console.log(`  scanned ${res.lines.toLocaleString()} lines / ${(res.bytes / 1048576).toFixed(1)} MB`);
    if (res.candidates.length > 0) {
      console.log('  candidate layouts tried:');
      for (const c of res.candidates) {
        console.log(
          `    infoGuid=${String(c.infoGuid).padEnd(5)} trailingExtra=${c.trailingExtra}  score=${(
            c.score * 100
          ).toFixed(0)}%  ${c.reason ?? ''}`,
        );
      }
    }
    process.exit(1);
  }

  const mb = res.bytes / 1048576;
  console.log(
    `layout: ${res.infoGuid ? 'infoGUID' : 'no-infoGUID'}${res.trailingExtra ? ` +${res.trailingExtra} trailing` : ''} ` +
      `(matched ${(res.layout.score * 100).toFixed(0)}% of ${res.layout.samples} damage events)`,
  );
  console.log(
    `log: ${res.lines.toLocaleString()} lines, ${mb.toFixed(1)} MB in ${res.elapsedMs} ms ` +
      `(${(mb / (res.elapsedMs / 1000)).toFixed(0)} MB/s, ${Math.round(res.lines / (res.elapsedMs / 1000)).toLocaleString()} lines/s)`,
  );
  console.log(
    `you: ${res.selfName ?? '?'} (${res.selfGuid ?? 'not found'}) | advanced=${res.advanced} | build=${res.build || '?'} | unparsed=${res.unparsed} skipped=${res.skipped} unknown=${res.unrecognised}`,
  );
  console.log(
    `span: ${res.firstMs ? fmtClock(res.firstMs, res.offsetMin ?? 0) : '?'} → ${res.lastMs ? fmtClock(res.lastMs, res.offsetMin ?? 0) : '?'} | ${res.sessions.length} session(s)`,
  );
  for (const w of res.warnings) console.log(`  ! ${w}`);
  for (const [i, s] of res.sessions.entries()) {
    console.log(
      `\nsession ${i + 1}: ${fmtClock(s.startMs, s.offsetMin)} → ${fmtClock(s.endMs, s.offsetMin)} ` +
        `(${fmtDuration(s.endMs - s.startMs)})${s.zoneName ? ` in ${s.zoneName}` : ''}`,
    );
    for (const e of s.encounters) {
      console.log(
        `  encounter ${e.bossName} (${e.success === true ? 'kill' : e.success === false ? 'wipe' : 'open'}) ` +
          `${e.durationS}s | dmg ${e.damageDone.toLocaleString()} @ ${e.dps.toLocaleString()} dps | ` +
          `taken ${e.damageTaken.toLocaleString()} | deaths ${e.deaths} | kills ${e.kills} | casts ${e.casts}`,
      );
      for (const a of e.topAbilities.slice(0, 3)) {
        console.log(`      ${a.name}: ${a.amount.toLocaleString()} (${a.hits} hits)`);
      }
    }
    const o = s.open;
    if (o.damageDone || o.damageTaken || o.kills) {
      console.log(
        `  open world: dmg ${o.damageDone.toLocaleString()} | taken ${o.damageTaken.toLocaleString()} | kills ${o.kills} | deaths ${o.deaths}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

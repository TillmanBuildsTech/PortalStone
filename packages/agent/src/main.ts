#!/usr/bin/env node
/**
 * Portalstone agent (MVP).
 *
 *   tsx src/main.ts                # scan, serve http://127.0.0.1:48120, rescan every 60s
 *   tsx src/main.ts --open         # same, and open the browser
 *   tsx src/main.ts --once         # scan and exit (for cron / a first look)
 *   tsx src/main.ts --install "D:/Blizzard/World of Warcraft"
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discover, type InstallInfo } from './discover';
import { scan } from './scan';
import { listening, startServer } from './server';
import { Store } from './store';
import { parseMembers, sampleTracked } from './tracking';
import { itemIdsIn, refreshItemNames } from './items';
import { ensureSensorMetrics, readSensor } from './sensor';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function defaultDbPath(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'Portalstone', 'portalstone.db');
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the URL is printed anyway */
  }
}

function describe(installs: InstallInfo[]): string {
  if (installs.length === 0) return '  (none)';
  return installs
    .map(
      (i) =>
        `  ${i.root}\n` +
        i.flavors
          .map((f) => `    ${f.name}: ${f.logs.length} log file(s), ${f.accounts.length} account(s)`)
          .join('\n'),
    )
    .join('\n');
}

async function main(): Promise<void> {
  const once = flag('once');
  const shouldOpen = flag('open') || flag('mvp');
  let force = flag('rebuild');
  const port = Number(arg('port', '48120'));
  const dbPath = arg('db', defaultDbPath()) ?? defaultDbPath();
  const installArg = arg('install');
  const extra = installArg ? [installArg] : [];

  // Mutated in place on every scan so the diagnostics page always reflects the live filesystem.
  const installs: InstallInfo[] = discover(extra);
  console.log(`portalstone: found ${installs.length} install(s)`);
  console.log(describe(installs));
  if (installs.length === 0) {
    console.error(
      '\nNo World of Warcraft install found. Pass --install "<path>" or set PORTALSTONE_WOW_DIR.',
    );
    process.exit(1);
  }

  const store = new Store(dbPath);
  // Per-run ability detail cannot be derived from what an older database stored, so a schema bump
  // costs one full re-read rather than a table that is silently empty on the run page.
  const backfill = store.needsDetailBackfill();
  if (backfill) {
    console.log('portalstone: deriving per-run detail, re-reading logs once');
    force = true;
  }
  let last = { at: 0, entries: 0, errors: 0 };

  const runScan = async (): Promise<void> => {
    const t0 = Date.now();
    const fresh = discover(extra);
    if (fresh.length > 0) installs.splice(0, installs.length, ...fresh);
    const entries = await scan(store, installs, (m) => console.log(m), { force });
    last = { at: Date.now(), entries: entries.length, errors: entries.filter((e) => e.action === 'error').length };
    store.setMeta('last_scan_ms', String(last.at));
    const changed = entries.filter((e) => e.action === 'ingested').length;
    console.log(
      `scan: ${entries.length} log file(s), ${changed} updated, ${last.errors} error(s) · ${Date.now() - t0} ms`,
    );
    // Our own addon, when it is installed: seed the series a fresh install would otherwise make the
    // user pick by hand. Idempotent and cached, so it runs on every scan and costs one parse.
    const sensor = readSensor(installs);
    const seeded = ensureSensorMetrics(store, sensor);
    if (seeded.length > 0) console.log(`  sensor: now tracking ${seeded.length} new series — ${seeded.join(', ')}`);
    // Tracked SavedVariables properties are sampled per flush, so this is cheap when nothing moved.
    const samples = sampleTracked(store, installs);
    for (const s of samples.filter((r) => r.recorded)) {
      console.log(`  tracked: ${s.metric.label} = ${s.value} (${s.instances} instance${s.instances === 1 ? '' : 's'})`);
    }
    for (const s of samples.filter((r) => !r.recorded && r.reason !== 'already stored for this flush')) {
      console.log(`  tracked: ${s.metric.label} not sampled — ${s.reason}`);
    }
    // Item names are optional and cached: this only asks for ids still unknown, a few per scan.
    const itemIds = store
      .trackedMetrics()
      .filter((m) => m.kind === 'set')
      .flatMap((m) => itemIdsIn(parseMembers(store.latestSample(m.id)?.members)));
    if (itemIds.length > 0) {
      const names = await refreshItemNames(store, itemIds);
      if (names.added > 0) console.log(`  names: +${names.added} (${names.sources.join(', ') || 'cache'}), ${names.missing} still unknown`);
    }
  };

  // Claim the port before scanning: a second agent should stop here, not after writing a full scan
  // into the database the first one is using.
  const server = once ? null : startServer(store, installs, { port, dbPath, installs, lastScan: () => last });
  if (server) {
    try {
      await listening(server, port);
    } catch (err) {
      console.error(`portalstone: ${(err as Error).message}`);
      store.close();
      process.exit(1);
    }
  }

  await runScan();
  // Only record the new schema once every log re-read cleanly: a log that failed must get the
  // full-rebuild path again next start rather than leave a hole in the detail.
  if (backfill && last.errors === 0) store.markDetailSchema();
  if (!server) {
    store.close();
    return;
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log(`\nInterface: ${url}`);
  console.log(`Database:  ${dbPath}`);
  console.log('Rescanning every 60s. Ctrl+C to stop.\n');
  if (shouldOpen) openBrowser(url);

  const timer = setInterval(() => {
    runScan().catch((err) => console.error('scan failed:', err));
  }, 60_000);

  const shutdown = (): void => {
    clearInterval(timer);
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

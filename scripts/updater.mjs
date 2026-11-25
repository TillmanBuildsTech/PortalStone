#!/usr/bin/env node
/**
 * Swap an installed PortalStone build for a freshly downloaded one and restart the service.
 *
 * This is shipped inside each release and launched — detached — by the running service when the user
 * clicks "Update & restart". It must run from the staging copy, never from the install folder it is
 * about to replace: Windows will not delete a directory that holds a live process's working
 * directory or a running script.
 *
 *   node updater.mjs --name <service> --target <install dir> --from <extracted build dir>
 *
 * Sequence (all recoverable up to the point of no return):
 *   1. serv stop <name>, and wait for it to actually stop
 *   2. move <target> aside to <target>.bak
 *   3. copy the new build into <target>, carrying forward service.yaml + install.json (the install's
 *      config, which the build does not ship)
 *   4. serv start <name>
 *   5. on success, delete the .bak; on any failure, restore it and start the old build
 *
 * There is no dev tooling here: a release carries plain node and this file.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const name = arg('name', 'portalstone');
const target = arg('target');
const from = arg('from');
const programData = process.env.ProgramData ?? 'C:\\ProgramData';
const logDir = join(programData, 'Portalstone', 'logs');
const logFile = join(logDir, 'updater.log');

if (!target || !from) {
  process.stderr.write('updater: --target and --from are required\n');
  process.exit(2);
}

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile, stamped, { flag: 'a' });
  } catch {
    /* logging is best-effort */
  }
  process.stdout.write(stamped);
}

function serv(args, quiet = false) {
  try {
    execFileSync('serv', args, { stdio: quiet ? 'ignore' : 'inherit' });
    return true;
  } catch (err) {
    if (!quiet) log(`serv ${args.join(' ')} failed: ${err.message}`);
    return false;
  }
}

/** Is the service reported as running? Parsed loosely from `serv status`, which is informational. */
function isRunning() {
  try {
    const out = execFileSync('serv', ['status', name], { encoding: 'utf8' });
    return /running/i.test(out);
  } catch {
    return false;
  }
}

const sleep = (ms) => {
  // A blocking wait is fine: this is a one-shot script with nothing else to do.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin briefly between polls */
  }
};

const bak = `${target}.bak`;

async function main() {
  log(`updating "${name}" at ${target} from ${from}`);

  serv(['stop', name], true);
  for (let i = 0; i < 30 && isRunning(); i++) sleep(1000);
  if (isRunning()) log('warning: service still reports running; proceeding to swap anyway');

  // Carry the install's own config forward — it lives in the target, not in the shipped build.
  const keep = ['service.yaml', 'install.json'];

  rmSync(bak, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, bak);

  try {
    mkdirSync(target, { recursive: true });
    cpSync(from, target, { recursive: true });
    for (const file of keep) {
      const src = join(bak, file);
      if (existsSync(src)) cpSync(src, join(target, file));
    }
    log('new build in place; starting service');
    if (!serv(['start', name])) throw new Error('serv start failed');

    rmSync(bak, { recursive: true, force: true });
    log('update complete');
  } catch (err) {
    log(`swap failed (${err.message}); rolling back`);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(bak)) renameSync(bak, target);
    serv(['start', name]);
    log('rolled back to the previous build');
    process.exit(1);
  }
}

main().catch((err) => {
  log(`unexpected failure: ${err.stack ?? err.message}`);
  process.exit(1);
});

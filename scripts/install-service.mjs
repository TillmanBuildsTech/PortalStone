#!/usr/bin/env node
/**
 * Install the release build as a Windows service, supervised by serv
 * (github.com/TillmanBuildsTech/serv — NSSM's successor: one YAML file, restart backoff, log
 * rotation, no GUI).
 *
 *   npm run build                  # produces dist/portalstone
 *   npm run service:install        # copy to Program Files, install + start the service
 *   npm run service:install -- --print     # write the YAML and show the command, change nothing
 *
 * Options
 *   --db <path>      database to run against (default: the one this user already has, so history
 *                    carries over; otherwise %PROGRAMDATA%\Portalstone\portalstone.db)
 *   --port <n>       port to serve on (default 48120)
 *   --target <dir>   where the release is installed (default %ProgramFiles%\Portalstone)
 *   --name <name>    service name (default portalstone)
 *   --print          stop after writing the config
 *
 * Needs an elevated shell: the SCM, Program Files and ProgramData all do. scripts\install-service.cmd
 * re-launches itself through UAC so you can just double-click it.
 *
 * The service runs as LocalSystem, which is deliberate: it must read combat logs and SavedVariables
 * out of the game folder and a user profile without holding anyone's password, and the UI is bound
 * to 127.0.0.1 so nothing is exposed by it.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'dist', 'portalstone');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const name = arg('name', 'portalstone');
const port = Number(arg('port', '48120'));
const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
const target = resolve(arg('target', join(programFiles, 'Portalstone')));
const programData = process.env.ProgramData ?? 'C:\\ProgramData';
const logDir = join(programData, 'Portalstone', 'logs');
const logFile = join(logDir, `${name}.log`);
const configPath = join(programData, 'serv', name, 'config.yaml');
const dryRun = flag('print');

/** The user's existing database, when there is one: a service should not silently start over. */
function defaultDb() {
  const mine = join(process.env.LOCALAPPDATA ?? '', 'Portalstone', 'portalstone.db');
  if (process.env.LOCALAPPDATA && existsSync(mine)) return mine;
  return join(programData, 'Portalstone', 'portalstone.db');
}
const dbPath = resolve(arg('db', defaultDb()));

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function isElevated() {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function serv(args) {
  return execFileSync('serv', args, { stdio: 'inherit' });
}

function servQuiet(args) {
  try {
    execFileSync('serv', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `serv start` on 0.1.7 can report "already running" while the service manager is still finishing a
 * stop. Three tries a few seconds apart is enough for that to settle.
 */
async function servStart() {
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('serv', ['start', name], { stdio: 'inherit' });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      say(`  start did not take (attempt ${attempt}/3), retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}


/** YAML double-quoted scalars are JSON-quoted scalars, so paths with spaces and backslashes are safe. */
const q = (value) => JSON.stringify(value);

function serviceYaml() {
  const node = process.execPath;
  return [
    `name: ${name}`,
    `display_name: "PortalStone"`,
    `description: "Local World of Warcraft performance tracker — http://127.0.0.1:${port}"`,
    `executable: ${q(node)}`,
    'arguments:',
    `    - ${q(join(target, 'portalstone.mjs'))}`,
    `    - "--port"`,
    `    - ${q(String(port))}`,
    `    - "--db"`,
    `    - ${q(dbPath)}`,
    `working_directory: ${q(target)}`,
    'start_type: auto',
    'stop_method:',
    '    methods:',
    '        - console',
    '        - window',
    '        - threads',
    '        - terminate',
    '    console_timeout: 2s',
    '    window_timeout: 1s',
    '    threads_timeout: 1s',
    '    terminate_timeout: 5s',
    'restart:',
    '    enabled: true',
    '    delay: 5s',
    '    throttle_cap: 2m',
    'exit_actions:',
    '    0: exit            # asked to stop: do not restart',
    '    1: restart         # no WoW install found / startup failure: retry with backoff',
    `stdout: ${q(logFile)}`,
    `stderr: ${q(logFile)}`,
    'log_rotation:',
    '    enabled: true',
    '    max_bytes: 5242880',
    '    max_age: 168h',
    '    timestamp_lines: true',
    'account:',
    '    type: local_system',
    'kill_process_tree: true',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Checks before touching anything.

const bundle = join(source, 'portalstone.mjs');
if (!existsSync(bundle)) {
  say(`No release build at ${bundle}.`);
  say('Run `npm run build` first.');
  process.exit(1);
}
for (const asset of ['dashboard.js', 'dashboard.css', 'gridstack-all.js', 'gridstack.min.css']) {
  if (!existsSync(join(source, 'assets', asset))) {
    say(`Release build is missing assets/${asset} — rebuild with \`npm run build\`.`);
    process.exit(1);
  }
}
if (!existsSync(join(source, 'updater.mjs'))) {
  say('Release build is missing updater.mjs (the self-updater) — rebuild with `npm run build`.');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  say(`--port must be a port number, got "${arg('port', '')}".`);
  process.exit(1);
}

const yaml = serviceYaml();

if (dryRun) {
  say(`Would install as "${name}":`);
  say(`  from    ${source}`);
  say(`  to      ${target}`);
  say(`  node    ${process.execPath}`);
  say(`  db      ${dbPath}`);
  say(`  logs    ${logFile}`);
  say(`  config  ${configPath}`);
  say();
  say('--- service config ---');
  say(yaml.trimEnd());
  process.exit(0);
}

if (process.platform !== 'win32') {
  say('This installer targets the Windows service manager. On Linux/macOS write a systemd/launchd');
  say('unit pointing at dist/portalstone/portalstone.mjs — see docs/SERVICE.md.');
  process.exit(1);
}
if (!isElevated()) {
  say('Needs an elevated shell (administrator): the service manager, Program Files and ProgramData');
  say('are all privileged. Either approve the UAC prompt from scripts\\install-service.cmd, or run:');
  say();
  say('  npm run service:install      # in an administrator terminal');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Copy the release somewhere stable, then hand it to serv.

// A reinstall has to replace the definition, and serv only rewrites an existing service's config
// through its own flags — so an existing install is removed rather than layered on top of. This has
// to happen before the copy: the running service has the install folder as its working directory,
// and Windows will not delete a folder a live process is sitting in.
if (existsSync(configPath)) {
  say(`  service "${name}" already installed — stopping and removing it first`);
  servQuiet(['stop', name]);
  // serv 0.1.7 reports a start it has not finished stopping as "already running", so let the
  // service settle between stop and the next definition.
  await new Promise((r) => setTimeout(r, 2000));
  serv(['remove', name]);
}

say(`portalstone: installing release → ${target}`);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
mkdirSync(logDir, { recursive: true });

const installed = { mjs: statSync(join(target, 'portalstone.mjs')).size, assets: 0 };
for (const asset of ['dashboard.js', 'dashboard.css', 'gridstack-all.js', 'gridstack.min.css']) {
  installed.assets += statSync(join(target, 'assets', asset)).size;
}
say(`  copied portalstone.mjs (${(installed.mjs / 1024).toFixed(1)} KB) + assets (${(installed.assets / 1024).toFixed(1)} KB)`);

writeFileSync(join(target, 'service.yaml'), yaml);
say(`  wrote ${join(target, 'service.yaml')}`);

// The running service reads this to learn how to update itself: the service name to drive `serv`
// with, the folder to swap, and the port/db for reference. Its presence is also how the agent tells
// an installed service (self-update enabled) from a dev run (notify-only).
writeFileSync(
  join(target, 'install.json'),
  JSON.stringify({ name, target, port, db: dbPath }, null, 2) + '\n',
);
say(`  wrote ${join(target, 'install.json')}`);

serv(['install', '--config', join(target, 'service.yaml')]);
await servStart();

// The point of the exercise: it is actually serving. The agent rescans on start, so allow a moment.
const url = `http://127.0.0.1:${port}/`;
let up = false;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    up = res.ok;
    if (up) break;
  } catch {
    /* not listening yet */
  }
  await new Promise((r) => setTimeout(r, 1000));
}

say();
say(`  service  ${name} (${up ? 'running' : 'installed, but not answering yet'})`);
say(`  ui       ${url}`);
say(`  database ${dbPath}`);
say(`  logs     ${logFile}`);
say();
try {
  serv(['status', name]);
} catch {
  /* status is informational */
}
if (!up) {
  say();
  say('The service is installed but the UI did not answer yet. Check the log:');
  say(`  Get-Content "${logFile}" -Tail 40`);
  process.exit(1);
}
say();
say('To stop it while you run a dev server on the same port:  serv stop ' + name);

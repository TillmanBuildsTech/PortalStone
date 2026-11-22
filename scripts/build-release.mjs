#!/usr/bin/env node
/**
 * Release build: the agent as one ES module plus the static files it serves, ready to run on a bare
 * Node — no tsx, no typescript, no node_modules.
 *
 *   npm run build
 *   node dist/portalstone/portalstone.mjs --once      # no dev tooling involved
 *
 * Output (dist/portalstone/) is self-contained apart from `node` itself:
 *
 *   portalstone.mjs         bundled agent + core, sourcemap beside it
 *   assets/                 dashboard builder, grid skin, vendored gridstack (served as-is)
 *   portalstone.cmd         convenience launcher for a console run
 *   service.yaml            written by `npm run service:install`, not here
 *
 * Node 24+ is required at runtime: the store is built on `node:sqlite`, which is why there is no
 * native dependency to carry and nothing to compile on install.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'portalstone');
const assetsDir = join(outDir, 'assets');
const require = createRequire(join(root, 'package.json'));

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'packages/agent/src/main.ts')],
  outfile: join(outDir, 'portalstone.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

/**
 * The server reads these off disk at startup rather than importing them: two of them are vendored
 * from node_modules, and the dashboard builder is a browser script that must not be bundled.
 */
const staticFiles = {
  'dashboard.js': join(root, 'packages/agent/src/ui/assets/dashboard.js'),
  'dashboard.css': join(root, 'packages/agent/src/ui/assets/dashboard.css'),
  'gridstack-all.js': require.resolve('gridstack/dist/gridstack-all.js'),
  'gridstack.min.css': require.resolve('gridstack/dist/gridstack.min.css'),
};

const assetLines = [];
for (const [name, from] of Object.entries(staticFiles)) {
  const to = join(assetsDir, name);
  await cp(from, to);
  assetLines.push(`  assets/${name.padEnd(20)} ${kb(await sizeOf(to))}`);
}

// A console launcher, so a first look after building does not need the full node invocation.
await writeFile(
  join(outDir, 'portalstone.cmd'),
  [
    '@echo off',
    'rem Run Portalstone from this folder. Arguments pass through, e.g. --once or --open.',
    'setlocal',
    'node "%~dp0portalstone.mjs" %*',
    '',
  ].join('\r\n'),
);

const bundleBytes = await sizeOf(join(outDir, 'portalstone.mjs'));
const mapBytes = await sizeOf(join(outDir, 'portalstone.mjs.map'));
const modules = Object.keys(result.metafile.outputs).length;
const inputs = Object.keys(result.metafile.inputs).length;

console.log(`portalstone: release build → ${outDir}`);
console.log(`  portalstone.mjs        ${kb(bundleBytes)} (${inputs} input modules)`);
console.log(`  portalstone.mjs.map    ${kb(mapBytes)}`);
console.log(assetLines.join('\n'));
console.log(`  portalstone.cmd`);
console.log(`\nNext: node "${join(outDir, 'portalstone.mjs')}" --once   # or --open for the UI`);
console.log('      npm run service:install                            # install as a Windows service');
console.log(`      (${modules} output file(s) written)`);

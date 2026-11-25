import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
/** luaparse ships no types; it is a dev-only syntax gate, so the AST stays untyped here. */
const luaparse = require('luaparse') as {
  parse: (src: string, opts?: Record<string, unknown>) => LuaNode;
};

type LuaNode = { type: string; [key: string]: unknown };

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON_DIR = resolve(HERE, '..', '..', '..', 'addons', 'PortalStoneSense');
const LUA_PATH = join(ADDON_DIR, 'PortalStoneSense.lua');
const TOC_PATH = join(ADDON_DIR, 'PortalStoneSense.toc');

function walk(node: unknown, visit: (n: LuaNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as LuaNode;
  if (typeof obj.type === 'string') visit(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') walk(value, visit);
  }
}

function parse(): LuaNode {
  return luaparse.parse(readFileSync(LUA_PATH, 'utf8'), { luaVersion: '5.1', locations: false });
}

describe('PortalStoneSense addon', () => {
  it('ships a .toc that loads the Lua and declares exactly one SavedVariables global', () => {
    expect(existsSync(TOC_PATH)).toBe(true);
    const toc = readFileSync(TOC_PATH, 'utf8');
    expect(toc).toMatch(/^## Interface: \d+/m);
    expect(toc).toMatch(/^## SavedVariables: PortalStoneDB$/m);
    expect(toc).toMatch(/^PortalStoneSense\.lua$/m);
    // A .toc naming more than one global is a second file the app has to learn to read.
    const declared = [...toc.matchAll(/^## SavedVariables(?:PerCharacter)?: (.+)$/gm)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim()),
    );
    expect(declared).toEqual(['PortalStoneDB']);
  });

  it('carries a "## Version:" line for the packager to stamp', () => {
    // scripts/package-addon.mjs rewrites this line with the release version. If the field ever goes
    // missing, the stamp would silently no-op and the in-game list would disagree with the download.
    const toc = readFileSync(TOC_PATH, 'utf8');
    expect(toc).toMatch(/^## Version: .+$/m);
  });

  it('parses as Lua 5.1, which is what an era client runs', () => {
    expect(() => parse()).not.toThrow();
  });

  it('writes one global and one slash command, and nothing else', () => {
    const ast = parse();
    // luaparse has no scope resolution: `x = y` on a local looks like a global assignment. Collect
    // every name declared local (or bound as a parameter) first, then anything else assigned at
    // the top of a function is a real global write.
    const locals = new Set<string>();
    walk(ast, (node) => {
      if (node.type === 'LocalStatement') {
        for (const v of (node.variables as LuaNode[]) ?? []) if (v.type === 'Identifier') locals.add(String(v.name));
      }
      if (node.type === 'FunctionDeclaration') {
        for (const p of (node.parameters as LuaNode[]) ?? []) if (p.type === 'Identifier') locals.add(String(p.name));
      }
      if (node.type === 'ForNumericStatement' || node.type === 'ForGenericStatement') {
        for (const v of ((node.variables as LuaNode[]) ?? [])) if (v.type === 'Identifier') locals.add(String(v.name));
      }
    });
    const names = new Set<string>();
    walk(ast, (node) => {
      if (node.type !== 'AssignmentStatement') return;
      for (const v of (node.variables as LuaNode[]) ?? []) {
        if (v.type === 'Identifier') names.add(String(v.name));
      }
    });
    expect([...names].filter((n) => !locals.has(n)).sort()).toEqual(['PortalStoneDB', 'SLASH_PORTALSTONESENSE1']);
  });

  it('calls every client API through the guarded wrapper', () => {
    // The failure mode this prevents: a function that exists on retail and not on the custom
    // server, throwing mid-snapshot and silently stopping the addon from writing anything.
    const allowed = new Set(['UnitName', 'UnitClass', 'UnitRace', 'CreateFrame']);
    const guarded = new Set<string>();
    const calls: string[] = [];
    walk(parse(), (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as LuaNode | undefined;
      if (!callee || callee.type !== 'Identifier') return;
      const name = String(callee.name);
      if (name === 'safe') {
        const first = (node.arguments as LuaNode[])[0];
        if (first?.type === 'Identifier') guarded.add(String(first.name));
        return;
      }
      if (/^(Get|Unit|Is|In|Request|Create)/.test(name)) calls.push(name);
    });
    const unguarded = [...new Set(calls)].filter((c) => !guarded.has(c) && !allowed.has(c));
    expect(unguarded).toEqual([]);
  });

  it('keeps a bounded spec history, because a respec between logouts leaves no other trace', () => {
    const src = readFileSync(LUA_PATH, 'utf8');
    expect(src).toMatch(/HISTORY_MAX = \d+/);
    // Trim oldest first: a log of changes, not an archive.
    expect(src).toMatch(/while #history > HISTORY_MAX do table\.remove\(history, 1\) end/);
  });

  it('never snapshots inside combat', () => {
    const src = readFileSync(LUA_PATH, 'utf8');
    expect(src).toMatch(/InCombatLockdown\(\)/);
  });

  it('holds combat logging on from the frame tick, guarded', () => {
    const src = readFileSync(LUA_PATH, 'utf8');
    expect(src).toMatch(/safe\(LoggingCombat, true\)/);
    expect(src).toMatch(/SetScript\("OnUpdate", function\(\)[\s\S]*?holdCombatLog\(now\)/);
  });

  it('declares every local function before anything calls it', () => {
    // A local referenced above its declaration is a nil global in Lua, and it fails only in game.
    const src = readFileSync(LUA_PATH, 'utf8');
    for (const [, name] of src.matchAll(/^local function (\w+)/gm)) {
      const declared = src.indexOf(`local function ${name}(`);
      const firstCall = src.search(new RegExp(`(?<![\\w.:])${name}\\(`));
      expect({ name, ok: firstCall >= declared }).toEqual({ name, ok: true });
    }
  });
});

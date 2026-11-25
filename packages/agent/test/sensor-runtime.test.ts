/**
 * The addon, run. sensor-addon.test.ts reads the Lua; this executes it in a Lua VM against a stub
 * of the client API, because the bugs that matter here only exist at runtime: the order in which
 * the client loads a file, loads SavedVariables and fires events, and which caller toggled logging.
 *
 * The VM is Lua 5.4 (wasmoon), the client is 5.1. The addon uses nothing that differs between them,
 * and sensor-addon.test.ts keeps the 5.1 syntax gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory, type LuaEngine } from 'wasmoon';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON = readFileSync(resolve(HERE, '..', '..', '..', 'addons', 'PortalStoneSense', 'PortalStoneSense.lua'), 'utf8');

/**
 * Just enough client. `now` is the clock the test advances; `logging` is the client's combat log
 * state and `opened` counts the files it has started; `chat` collects what the addon printed.
 * The /combatlog handler is the client's: a toggle, defined before any addon loads.
 */
const CLIENT = `
now = 100
logging = false
opened = 0
chat = {}
time = os.time
function GetTime() return now end
function LoggingCombat(on)
  if on == nil then return logging end
  if on and not logging then opened = opened + 1 end
  logging = on and true or false
end
DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) chat[#chat + 1] = m end }
function UnitName() return "Dead" end
function GetRealmName() return "Realm A" end
function UnitGUID() return "Player-6934-0194514D" end
function UnitClass() return "Warrior", "WARRIOR" end
function UnitRace() return "Orc", "Orc" end
function UnitLevel() return 60 end
function InCombatLockdown() return false end
function hooksecurefunc(t, k, f)
  local orig = t[k]
  t[k] = function(...) local r = table.pack(orig(...)); f(...); return table.unpack(r, 1, r.n) end
end
SLASH_COMBATLOG1 = "/combatlog"
SlashCmdList = { COMBATLOG = function() LoggingCombat(not LoggingCombat()) end }
hash_SlashCmdList = { ["/COMBATLOG"] = SlashCmdList.COMBATLOG }
frames = {}
function CreateFrame()
  local f = { scripts = {} }
  function f:RegisterEvent() end
  function f:SetScript(name, fn) self.scripts[name] = fn end
  frames[#frames + 1] = f
  return f
end
function fire(event, ...) frames[1].scripts.OnEvent(frames[1], event, ...) end
function tick(seconds)
  local stop = now + seconds
  while now < stop do now = now + 0.25; frames[1].scripts.OnUpdate(frames[1], 0.25) end
end
function typed(cmd) hash_SlashCmdList[cmd]("") end
function said(pattern)
  for _, m in ipairs(chat) do if string.find(m, pattern) then return true end end
  return false
end
`;

let lua: LuaEngine | null = null;

/** Load the addon the way the client does: file, then SavedVariables, then ADDON_LOADED. */
async function boot(saved: string | null = null): Promise<LuaEngine> {
  lua = await new LuaFactory().createEngine();
  await lua.doString(CLIENT);
  await lua.doString(ADDON);
  if (saved !== null) await lua.doString(`PortalStoneDB = ${saved}`);
  await lua.doString(`fire("ADDON_LOADED", "PortalStoneSense"); fire("PLAYER_ENTERING_WORLD", true, false)`);
  return lua;
}

const get = async <T>(expr: string): Promise<T> => (await lua!.doString(`return ${expr}`)) as T;
const run = async (code: string): Promise<void> => {
  await lua!.doString(code);
};

afterEach(() => {
  lua?.global.close();
  lua = null;
});

describe('PortalStoneSense at runtime', () => {
  it('writes into the SavedVariables table the client loaded, not the placeholder', async () => {
    await boot(`{ schema = 1, chars = { Dead = { meta = { name = "Dead", realm = "Realm A", updated = 1 } } } }`);
    await run('tick(3)');
    expect(await get('PortalStoneDB.schema')).toBe(2);
    expect(await get('PortalStoneDB.chars["Dead"]')).toBeNull();
    expect(await get('PortalStoneDB.chars["Dead-Realm A"].meta.updated > 1')).toBe(true);
    expect(await get('PortalStoneDB.chars["Dead-Realm A"].meta.guid')).toBe('Player-6934-0194514D');
  });

  it('writes on a first run, when there is no saved table', async () => {
    await boot();
    await run('tick(3)');
    expect(await get('PortalStoneDB.chars["Dead-Realm A"].meta.name')).toBe('Dead');
  });

  it('turns combat logging on, and back on after another addon turns it off', async () => {
    await boot();
    await run('tick(1)');
    expect(await get('logging')).toBe(true);
    await run('LoggingCombat(false); tick(3)');
    expect(await get('logging')).toBe(true);
    expect(await get('said("another addon turned combat logging off")')).toBe(true);
  });

  it('leaves logging off when the player types /combatlog, until they type it again', async () => {
    await boot();
    await run('tick(1); typed("/COMBATLOG"); tick(10)');
    expect(await get('logging')).toBe(false);
    expect(await get('PortalStoneDB.logPaused')).toBe(true);
    expect(await get('said("stays off until you type /combatlog again")')).toBe(true);

    await run('typed("/COMBATLOG"); tick(1)');
    expect(await get('logging')).toBe(true);
    expect(await get('PortalStoneDB.logPaused')).toBeNull();
    // An addon turning it off after that is not the player: the hold is back.
    await run('LoggingCombat(false); tick(3)');
    expect(await get('logging')).toBe(true);
  });

  it('keeps a pause through /reload and drops it at the next login', async () => {
    await boot();
    await run('tick(1); typed("/COMBATLOG")');
    // /reload: same SavedVariables, PLAYER_ENTERING_WORLD with isInitialLogin false.
    await run('fire("PLAYER_ENTERING_WORLD", false, true); tick(5)');
    expect(await get('logging')).toBe(false);
    await run('fire("PLAYER_ENTERING_WORLD", true, false); tick(3)');
    expect(await get('logging')).toBe(true);
  });

  it('/psense newlog starts a new file a moment later, without leaving logging off', async () => {
    await boot();
    await run('tick(1)');
    expect(await get('opened')).toBe(1);
    await run('SlashCmdList.PORTALSTONESENSE("newlog")');
    expect(await get('logging')).toBe(false);
    await run('tick(1)');
    // Not yet: a file name has one-second resolution, and the same name is not a new file.
    expect(await get('opened')).toBe(1);
    await run('tick(1)');
    expect(await get('opened')).toBe(2);
    expect(await get('logging')).toBe(true);
    expect(await get('said("new combat log file started")')).toBe(true);
  });

  it('/psense newlog also resumes after a /combatlog pause', async () => {
    await boot();
    await run('tick(1); typed("/COMBATLOG"); SlashCmdList.PORTALSTONESENSE("newlog"); tick(2)');
    expect(await get('logging')).toBe(true);
    expect(await get('PortalStoneDB.logPaused')).toBeNull();
  });

  it('/psense log off is a durable opt-out: logging stays off through a /reload', async () => {
    await boot();
    await run('tick(1)');
    expect(await get('logging')).toBe(true);
    await run('SlashCmdList.PORTALSTONESENSE("log off"); tick(5)');
    expect(await get('logging')).toBe(false);
    expect(await get('PortalStoneDB.logDisabled')).toBe(true);
    // Unlike a /combatlog pause, the opt-out survives a login (isInitialLogin true).
    await run('fire("PLAYER_ENTERING_WORLD", true, false); tick(5)');
    expect(await get('logging')).toBe(false);
    expect(await get('said("combat logging disabled")')).toBe(true);
  });

  it('/psense log on resumes the hold after an opt-out', async () => {
    await boot();
    await run('SlashCmdList.PORTALSTONESENSE("log off"); tick(3)');
    expect(await get('logging')).toBe(false);
    await run('SlashCmdList.PORTALSTONESENSE("log on"); tick(3)');
    expect(await get('logging')).toBe(true);
    expect(await get('PortalStoneDB.logDisabled')).toBeNull();
  });

  it('typing /combatlog back on clears a /psense opt-out', async () => {
    await boot();
    await run('SlashCmdList.PORTALSTONESENSE("log off"); tick(3)');
    expect(await get('PortalStoneDB.logDisabled')).toBe(true);
    // The player re-enabling logging by hand plainly no longer wants the opt-out.
    await run('typed("/COMBATLOG"); tick(1)');
    expect(await get('logging')).toBe(true);
    expect(await get('PortalStoneDB.logDisabled')).toBeNull();
  });
});

--[[--------------------------------------------------------------------------
Portalstone Sensor

One addon, every number the combat log cannot see.

A combat log knows what you cast and what it hit. It does not know your talent
tree, your gear, your professions, your lockouts, or how long you have played;
none of that is in the format and no parser can recover it. This addon writes
those numbers into its own SavedVariables file, which Portalstone already reads,
so the app stops guessing about the things it used to guess at.

Rules this file follows, because the app depends on them:

  * It writes ONE global: PortalstoneDB. Nothing else is touched.
  * Every API call is guarded. Era clients, retail clients and custom servers do
    not have the same functions, and an addon that throws on a missing one is an
    addon that stops writing data. A number that cannot be read is simply absent.
  * It never writes while the player is in combat (talent and equipment events
    fire there, and poking the API mid-fight is noise). A snapshot is deferred to
    the next out-of-combat tick instead of dropped.
  * It is push, not poll: the game flushes SavedVariables on logout and /reload,
    which is exactly the cadence Portalstone samples at.
  * `history` keeps the last HISTORY_MAX spec observations, because a respec
    that happens between two logouts is invisible otherwise.

Commands: /psense (print the snapshot), /psense write (force one now).
--]]--------------------------------------------------------------------------

local ADDON = "PortalstoneSense"
local SCHEMA = 2
local HISTORY_MAX = 40

PortalstoneDB = PortalstoneDB or {}
local DB = PortalstoneDB
DB.schema = SCHEMA
DB.chars = DB.chars or {}

-- ---------------------------------------------------------------- helpers ---

-- Call an API only if it exists. Custom servers drop functions; a missing one
-- must be an absent number, never an error in the middle of a snapshot. Eight
-- return values, because the skill-line and lockout APIs return seven.
local function safe(fn, ...)
  if type(fn) ~= "function" then return nil end
  local ok, a, b, c, d, e, f, g, h = pcall(fn, ...)
  if not ok then return nil end
  return a, b, c, d, e, f, g, h
end

local function round2(v)
  if type(v) ~= "number" then return nil end
  return math.floor(v * 100 + 0.5) / 100
end

-- A table with no keys is noise in the SavedVariables file: write nil instead.
local function orNil(t)
  if type(t) ~= "table" then return nil end
  if next(t) == nil then return nil end
  return t
end

local function trim(s)
  if type(s) ~= "string" then return nil end
  return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

-- --------------------------------------------------------------- identity ---

local function identity()
  local name = UnitName("player")
  if not name then return nil end
  local _, class = UnitClass("player")
  local _, race = UnitRace("player")
  local faction = safe(UnitFactionGroup, "player")
  local guild = safe(GetGuildInfo, "player")
  return {
    name = name,
    realm = safe(GetRealmName),
    guid = safe(UnitGUID, "player"), -- retail only; the log carries the guid anyway
    class = class,
    race = race,
    faction = faction,
    guild = guild,
    level = safe(UnitLevel, "player"),
    zone = safe(GetRealZoneText) or safe(GetZoneText),
  }
end

-- ------------------------------------------------------------------- spec ---
--
-- Vanilla/era has three talent tabs and no "specialization": the build IS the
-- answer, so the string is 0/31/20 and the spec name is the tab with the most
-- points. Retail has GetSpecialization and named trees; when that exists it
-- wins, and the tabs are still recorded because a benchmark wants the build.

local function specSnapshot()
  local spec = { updated = time() }

  -- Retail / Wrath+ named specialization, guarded: era clients do not have it.
  if type(GetSpecialization) == "function" then
    local id = safe(GetSpecialization)
    if id then
      spec.id = id
      local name, _, _, icon = safe(GetSpecializationInfo, id)
      spec.name = name
      if icon then spec.icon = icon end
    end
  end

  -- Talent trees, which every classic-flavoured client has.
  local tabs = safe(GetNumTalentTabs)
  local points = 0
  local best, bestPoints = nil, -1
  if tabs and tabs > 0 then
    spec.tabs = {}
    for i = 1, tabs do
      local name, _, spent = safe(GetTalentTabInfo, i)
      spent = spent or 0
      if name then
        spec.tabs[#spec.tabs + 1] = { name = name, points = spent }
        points = points + spent
        if spent > bestPoints then best, bestPoints = name, spent end
      end
    end
    if #spec.tabs > 0 then
      local parts = {}
      for i = 1, #spec.tabs do parts[i] = tostring(spec.tabs[i].points or 0) end
      spec.build = table.concat(parts, "/")
      spec.points = points
      spec.tab = best
      -- Retail already answered with a real spec name; only fall back when it did not.
      if not spec.name then spec.name = best end
    end
  end

  -- Dual spec / talent groups: which one is active matters as much as the build.
  local group = safe(GetActiveTalentGroup)
  if group then spec.group = group end
  local groups = safe(GetNumTalentGroups)
  if groups then spec.groups = groups end

  -- The role the client would assign, when the client can say.
  local role = safe(UnitGroupRolesAssigned, "player")
  if role and role ~= "NONE" then spec.role = role end

  if not spec.name and not spec.build then return nil end
  return spec
end

-- Where the spec sits in a character's history: deduplicated by (name, build),
-- because PLAYER_TALENT_UPDATE fires on every point spent and only the finished
-- build is worth a row.
local function rememberSpec(char, spec)
  if not spec then return end
  local label = (spec.name or "?") .. "|" .. (spec.build or "?")
  local history = char.history
  if type(history) ~= "table" then history = {}; char.history = history end
  local last = history[#history]
  if last and last.key == label then
    last.points = spec.points
    last.at = spec.updated
    return
  end
  history[#history + 1] = {
    key = label,
    spec = spec.name,
    build = spec.build,
    points = spec.points,
    group = spec.group,
    at = spec.updated,
  }
  -- Oldest out first: this is a log of changes, not an archive.
  while #history > HISTORY_MAX do table.remove(history, 1) end
end

-- ------------------------------------------------------------------ stats ---

local function statsSnapshot()
  local s = {}
  s.str = safe(UnitStat, "player", 1)
  s.agi = safe(UnitStat, "player", 2)
  s.sta = safe(UnitStat, "player", 3)
  s.int = safe(UnitStat, "player", 4)
  s.spi = safe(UnitStat, "player", 5)
  s.armor = safe(UnitArmor, "player")
  s.health = safe(UnitHealthMax, "player")
  s.mana = safe(UnitManaMax, "player")
  s.attackPower = safe(UnitAttackPower, "player")
  s.rangedAttackPower = safe(UnitRangedAttackPower, "player")
  s.spellBonusHealing = safe(GetSpellBonusHealing)
  s.spellBonusDamage = safe(GetSpellBonusDamage, 2) -- 2 = holy; schools differ per class
  s.critMelee = round2(safe(GetCritChance))
  s.critRanged = round2(safe(GetRangedCritChance))
  s.critSpell = round2(safe(GetSpellCritChance, 2))
  s.dodge = round2(safe(GetDodgeChance))
  s.parry = round2(safe(GetParryChance))
  s.block = round2(safe(GetBlockChance))
  return orNil(s)
end

-- ------------------------------------------------------------------- gear ---
--
-- Item level is the one number a benchmark needs and the log cannot give: the
-- log names abilities, never what you were wearing while casting them.

local function gearSnapshot()
  local g = { slots = {} }
  local sum, n = 0, 0
  for slot = 0, 19 do
    local link = safe(GetInventoryItemLink, "player", slot)
    if link then
      local name, _, quality, ilvl = safe(GetItemInfo, link)
      local id = tonumber(string.match(link, "item:(%d+)"))
      if id then
        g.slots[slot] = { id = id, ilvl = ilvl, quality = quality, name = name }
        if ilvl then
          sum = sum + ilvl
          n = n + 1
        end
      end
    end
  end
  if n == 0 then return nil end
  g.ilvl = math.floor(sum / n + 0.5)
  g.equipped = n
  return g
end

-- ------------------------------------------------------------ professions ---

local function professionsSnapshot()
  local lines = safe(GetNumSkillLines)
  if not lines then return nil end
  local out = {}
  for i = 1, lines do
    local name, header, _, rank, _, modifier, maxRank = safe(GetSkillLineInfo, i)
    -- Second profession skills are headers; a profession is a non-header line
    -- that has a maximum rank and something spent in it.
    if name and not header and maxRank and maxRank > 0 and (rank or 0) > 0 then
      out[#out + 1] = { name = name, skill = rank, max = maxRank, modifier = modifier }
    end
  end
  return orNil(out)
end

-- --------------------------------------------------------------- lockouts ---
--
-- Saved instances are the only local evidence that a reset has been spent, and
-- they say which bosses are already down without needing the raid to be logged.

local function lockoutsSnapshot()
  local n = safe(GetNumSavedInstances)
  if not n or n == 0 then return nil end
  local out = {}
  for i = 1, n do
    local name, id, reset, difficulty, locked, extended, remaining = safe(GetSavedInstanceInfo, i)
    if name then
      out[#out + 1] = {
        name = name,
        id = id,
        reset = reset,
        difficulty = difficulty,
        locked = locked and true or nil,
        extended = extended and true or nil,
        remaining = remaining,
      }
    end
  end
  return orNil(out)
end

-- ---------------------------------------------------------------- grouping ---

local function groupSnapshot()
  local party = safe(GetNumPartyMembers) or 0
  local raid = safe(GetNumRaidMembers) or 0
  local prefix, count = "party", party
  if raid > 0 then prefix, count = "raid", raid end
  if count == 0 then return nil end
  local out = {}
  for i = 1, count do
    local unit = prefix .. i
    local name = safe(UnitName, unit)
    if name then
      local _, class = safe(UnitClass, unit)
      local role = safe(UnitGroupRolesAssigned, unit)
      out[#out + 1] = {
        name = name,
        class = class,
        level = safe(UnitLevel, unit),
        role = (role and role ~= "NONE") and role or nil,
      }
    end
  end
  return orNil(out)
end

-- ------------------------------------------------------------------- write ---

-- The key a character is stored under: name and realm. Schema 1 used the name
-- alone, so two characters with one name on two realms of the same account
-- wrote over each other's history. A client with no realm API keeps the name.
local function charKey()
  local name = UnitName("player")
  if not name then return nil end
  local realm = safe(GetRealmName)
  if type(realm) == "string" and realm ~= "" then return name .. "-" .. realm end
  return name
end

-- Move this character's schema-1 entry to its schema-2 key, once. Only the
-- character logged in can be moved: it is the only one whose realm is known
-- for certain, so an entry recorded on another realm is left where it is.
local function adoptLegacy(id, key)
  if key == id.name or DB.chars[key] ~= nil then return end
  local old = DB.chars[id.name]
  if type(old) ~= "table" then return end
  local realm = type(old.meta) == "table" and old.meta.realm or nil
  if realm ~= nil and realm ~= id.realm then return end
  DB.chars[key] = old
  DB.chars[id.name] = nil
end

local function snapshot(reason)
  local id = identity()
  if not id or not id.name then return end
  local key = charKey() or id.name
  adoptLegacy(id, key)
  local char = DB.chars[key]
  if type(char) ~= "table" then char = {}; DB.chars[key] = char end

  char.meta = id
  char.meta.updated = time()
  char.schema = SCHEMA

  local spec = specSnapshot()
  if spec then
    char.spec = spec
    rememberSpec(char, spec)
  end

  char.stats = statsSnapshot() or char.stats
  char.gear = gearSnapshot() or char.gear
  char.professions = professionsSnapshot() or char.professions
  char.lockouts = lockoutsSnapshot()
  char.group = groupSnapshot()

  local xp, xpMax = safe(UnitXP, "player"), safe(UnitXPMax, "player")
  if xp and xpMax and xpMax > 0 then
    char.xp = { level = id.level, current = xp, max = xpMax, rested = safe(GetXPExhaustion) }
  else
    char.xp = nil
  end

  char.money = safe(GetMoney)
  char.last_reason = reason
  DB.updated = char.meta.updated

  -- Played time only arrives as an event; ask on every snapshot and let the
  -- handler fill it in a moment later.
  if type(RequestTimePlayed) == "function" then pcall(RequestTimePlayed) end
end

-- ------------------------------------------------------------------ events ---

local frame = CreateFrame("Frame", ADDON .. "Frame")
local pendingReason = nil
local nextAllowed = 0

-- Coalesce: a burst of talent/equipment events is one write, and never inside
-- combat, where the client's own state is not settled and the write is useless.
local function want(reason, delay)
  pendingReason = reason
  local at = (GetTime and GetTime() or 0) + (delay or 1)
  if at > nextAllowed then nextAllowed = at end
end

frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_LEVEL_UP")
frame:RegisterEvent("PLAYER_TALENT_UPDATE")
frame:RegisterEvent("CHARACTER_POINTS_CHANGED")
frame:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
frame:RegisterEvent("PLAYER_SPECIALIZATION_CHANGED") -- retail; harmless elsewhere
frame:RegisterEvent("TIME_PLAYED_MSG")

frame:SetScript("OnEvent", function(_, event, arg1, arg2)
  if event == "ADDON_LOADED" then
    if arg1 ~= ADDON then return end
    DB.schema = SCHEMA
    DB.chars = DB.chars or {}
    want("load", 2)
    return
  end
  if event == "TIME_PLAYED_MSG" then
    local key = charKey()
    local char = key and DB.chars[key]
    if char and arg1 then
      char.played = { total = arg1, level = arg2 }
    end
    return
  end
  if event == "PLAYER_LEVEL_UP" then
    want("level", 1)
    return
  end
  if
    event == "PLAYER_TALENT_UPDATE"
    or event == "CHARACTER_POINTS_CHANGED"
    or event == "PLAYER_SPECIALIZATION_CHANGED"
  then
    -- A talent event is the one that matters for spec history: write promptly.
    want("talent", 0.5)
    return
  end
  if event == "PLAYER_EQUIPMENT_CHANGED" then
    want("equipment", 3)
    return
  end
  want("zone", 1)
end)

frame:SetScript("OnUpdate", function()
  if not pendingReason then return end
  local now = (GetTime and GetTime() or 0)
  if now < nextAllowed then return end
  if InCombatLockdown and InCombatLockdown() then
    nextAllowed = now + 2
    return
  end
  local reason = pendingReason
  pendingReason = nil
  local ok, err = pcall(snapshot, reason or "tick")
  if not ok and DEFAULT_CHAT_FRAME then
    DEFAULT_CHAT_FRAME:AddMessage("|cffff8080Portalstone|r sensor failed: " .. tostring(err))
  end
end)

-- ----------------------------------------------------------------- commands ---

SLASH_PORTALSTONESENSE1 = "/psense"
SlashCmdList["PORTALSTONESENSE"] = function(msg)
  msg = string.lower(trim(msg) or "")
  if msg == "write" then
    local ok, err = pcall(snapshot, "manual")
    if DEFAULT_CHAT_FRAME then
      DEFAULT_CHAT_FRAME:AddMessage(
        ok and "|cff8080ffPortalstone|r snapshot written; it lands in SavedVariables on /reload or logout."
          or ("|cffff8080Portalstone|r failed: " .. tostring(err))
      )
    end
    return
  end
  local char = DB.chars[charKey() or ""]
  if not char or not DEFAULT_CHAT_FRAME then return end
  local spec = char.spec or {}
  DEFAULT_CHAT_FRAME:AddMessage(
    string.format(
      "|cff8080ffPortalstone|r %s · %s%s · ilvl %s · %s",
      tostring(char.meta and char.meta.level or "?"),
      tostring(spec.name or "no spec"),
      spec.build and (" (" .. spec.build .. ")") or "",
      tostring(char.gear and char.gear.ilvl or "?"),
      tostring(char.meta and char.meta.zone or "?")
    )
  )
  DEFAULT_CHAT_FRAME:AddMessage("|cff8080ffPortalstone|r /psense write forces a snapshot.")
end

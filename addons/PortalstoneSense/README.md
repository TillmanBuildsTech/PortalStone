# PortalStone Sensor

One addon, every number the combat log cannot see.

The combat log records what you cast and what it hit. It has no talent event, no gear, no
professions, no lockouts and no played time — 41 event types, checked against 64 MB of real
`_forever_` logs. Everything PortalStone says about those things today is either an inference from
abilities or a third-party addon's opinion about its own user.

This addon closes that gap with one file we control. It writes `PortalstoneDB` to
`WTF/Account/<account>/SavedVariables/PortalstoneSense.lua` on the game's own flush cadence
(logout, `/reload`, exit), and `packages/agent/src/sensor.ts` projects it onto the sensor page and
onto tracked series.

## Install

```
npm run addon:install          # copies into every flavor found, or use --install "<path>"
```

Then `/reload` in game (or log out and back in). `/psense write` forces a snapshot; `/psense` prints
the current one and whether the combat log is on.

### Combat logging

It also keeps combat logging on, everywhere, all the time, so no other logging addon is needed. It
checks every two seconds and turns logging back on if another addon has turned it off. Don't run one
that logs "only in instances", such as AutoCombatLogger: it turns logging off on every zone change,
each off/on cycle starts a new log file, and this addon will tell you once per session when that
happens.

You still decide:

- **`/psense newlog`** closes the current log file and starts a new one about a second later.
  This is how to give a raid its own file to upload, without ever stopping logging.
- **`/psense log off`** is a durable opt-out: it stops the addon forcing logging at all and survives
  `/reload` and login (unlike a `/combatlog` pause, which lasts only the session). Use it to run with
  logging fully off — for example to A/B test a client issue. **`/psense log on`** resumes the hold.
- **`/combatlog`** works as it always has. If you turn logging off with it, it stays off until you
  type `/combatlog` again, run `/psense newlog`, or next log in. A `/reload` keeps it off. Turning it
  back on by hand also clears a `/psense log off` opt-out. Anything played while it's off never
  reaches PortalStone.

The installer copies two files into `Interface/AddOns/PortalstoneSense`. It never touches `WTF` —
SavedVariables belong to the game. The agent itself never writes to the game directory at all; only
this explicit command does.

## What it records

| section | contents | why the log can't |
|---|---|---|
| `meta` | name, realm, guid (when the client has one), class, race, faction, guild, level, zone | the log knows a guid and a name, not who you are |
| `spec` | named spec (retail) or the dominant tree, `build` as `0/31/20`, points, dual-spec group, role | no talent event exists in the log format |
| `history` | every distinct spec/build observed, with a timestamp, capped at 40 | a respec between two logouts leaves no other trace |
| `stats` | str/agi/sta/int/spi, armor, health, mana, attack power, spell/heal bonus, crit, dodge, parry, block | never logged |
| `gear` | item id, name, ilvl and quality per slot, plus average ilvl | the log names abilities, not what you wore |
| `professions` | every skill line with rank and max | never logged |
| `lockouts` | saved instances with id, difficulty, reset, locked/extended | never logged |
| `played` | total and at-level seconds, from `TIME_PLAYED_MSG` | never logged |
| `xp` | level, current, max, rested | never logged |
| `money` | copper | BagBrother has this; ours is one less dependency |
| `group` | party/raid members with class, level and assigned role | the log has names and guids, not roles |

## Design rules

- **One global.** `PortalstoneDB`, nothing else.
- **Every API is guarded.** Era clients, retail clients and custom servers disagree about which
  functions exist. A missing function must be an absent field, never an error mid-snapshot: an addon
  that throws stops writing data, and then the app silently has none.
- **Never in combat.** Talent and equipment events fire mid-fight; the snapshot is deferred to the
  next out-of-combat tick rather than dropped or written from a half-settled state.
- **Coalesced.** A burst of `CHARACTER_POINTS_CHANGED` (one per talent point) is one write.
- **Absent, not zero.** A table with no keys is written as `nil`. The app renders "not recorded" and
  never a zero it invented.
- **Push, not poll.** No timers, no `OnUpdate` work when nothing is pending.

## Schema

```
PortalstoneDB = {
  schema = 2,
  updated = <epoch>,
  chars = {
    ["Dead-CAMWOW US2 Realm 8 PvP"] = {
      schema = 2,
      meta  = { name, realm, guid, class, race, faction, guild, level, zone, updated },
      spec  = { name, build = "0/31/20", points, tab, role, group, groups, id, updated,
                tabs = { { name, points }, ... } },
      stats = { str, agi, sta, int, spi, armor, health, mana, attackPower, ... },
      gear  = { ilvl, equipped, slots = { [0..19] = { id, ilvl, quality, name } } },
      professions = { { name, skill, max, modifier }, ... },
      lockouts    = { { name, id, difficulty, reset, locked, extended, remaining }, ... },
      played = { total, level },
      xp     = { level, current, max, rested },
      money  = <copper>,
      group  = { { name, class, level, role }, ... },
      history = { { key, spec, build, points, group, at }, ... },
    },
  },
}
```

Character keys are `UnitName("player")` and `GetRealmName()` joined by a hyphen. Schema 1 used the
name alone, so two characters with one name on two realms of the same account overwrote each
other; on login the addon moves the current character's schema-1 entry to its new key, and the app
moves that character's tracked series along with it.

The key is storage, not identity. Names disagree between sources on this server: for the same
character the log writes `Dead-Sadfatkid-PvP-US`, BagBrother `Dead Sadfatkid`, and `UnitName` just
`Dead`. The app joins sensor data to the log by `meta.guid`, which both record; `sameCharacter()`'s
name heuristic is only the fallback for addons that keep no guid.

## Pairs with the inference

Spec chips on sessions and runs are inferred from talent-locked abilities, because that is all the
log holds. This file is the recorded answer. The sensor page shows both, deliberately: an inference
is only trustworthy when the reader can see what it rested on.

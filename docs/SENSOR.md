# The sensor addon

Why this project ships an addon, what it is allowed to do, and what the app does with it.

## The gap it closes

A combat log records what was cast and what it hit. It has no talent event, no gear, no professions,
no lockouts and no played time — 41 event types, checked against 64 MB of real `_forever_` logs
(`SPEC-providers-and-capabilities.md`, `docs/TECHNICAL-PLAN.md` §12). Everything the app says about
those things is therefore either:

- an **inference** from abilities (`packages/core/src/combatlog/spec.ts`: Seal of Command proves
  Retribution, Holy Light proves nothing), or
- a **third-party addon's** opinion about its own user (Attune's roster, BagBrother's money).

Neither answers "what spec is this character now, and what were they wearing while they did it".
That is the one capability the project has always costed as needing an addon of its own
(`addon.ours` in the spec's capability registry). This is that addon, kept as small as that one
capability allows.

## Division of labour

| question | answered by | where |
|---|---|---|
| what happened, when, to whom | combat log | `packages/core/src/combatlog` |
| what spec, gear, professions, lockouts, played time | sensor addon | `addons/PortalstoneSense` |
| what it means together | the app | `packages/agent` |

The addon is push-only. The game flushes SavedVariables on logout and `/reload`, which is exactly
the cadence `packages/agent/src/tracking.ts` samples at, so nothing polls and nothing is invented
between flushes.

## What the app does with it

- **`/sensor` page** (`packages/agent/src/ui/pages/sensor.ts`) — per character: spec and build, the
  talent points per tree, gear with item ids and average item level, professions, saved instances,
  played time, XP, gold, and group composition at the last flush. Every absent field renders as "not
  recorded"; nothing is zero-filled.
- **Tracked series** (`ensureSensorMetrics` in `packages/agent/src/sensor.ts`) — three per character,
  seeded on the first scan after the addon's first flush: item level, played time, current XP. They
  are pinned to that character (`entity`), because two characters' item levels summed into one line
  is a number nobody has.
- **Spec chips** — a chip on a session or run is still an *inference* from the log; the sensor page is
  the recorded answer. They sit in the same app on purpose: an inference is trustworthy only when
  the reader can see what it rested on, and a recorded value is only useful if it is dated.

## Why it is built the way it is

Every rule here exists because of a failure mode seen on this install:

- **Every API through `safe()`.** This client is a custom 1.60.1 build with a retail-shaped logger:
  `UnitGUID`, `GetSpecialization`, `UnitGroupRolesAssigned` and `GetSpellBonusDamage` exist in some
  clients and not others. An unguarded call throws once and the snapshot stops happening for good —
  silently, because nothing reads the error. `test/sensor-addon.test.ts` fails the build if a client
  API is called outside the wrapper.
- **One global.** `## SavedVariables: PortalstoneDB`, asserted by the same test. A second global is a
  second file for the app to learn.
- **Never in combat.** Talent and equipment events fire mid-fight; the write is deferred, not
  dropped. `InCombatLockdown()` guards the flush.
- **Absent, not zero.** Empty tables are written as `nil` (`orNil`), because the app cannot tell a
  real zero from a missing API and would rather say "not recorded".
- **Bounded spec history.** `history` keeps the last 40 distinct (spec, build) observations with
  timestamps. Without it, a respec between two logouts leaves no trace anywhere — the log has no
  respec event, and the app only sees the spec that was true at the last flush.

## Installing and verifying

```
npm run addon:install          # --install "<path>" to be explicit, --dry to look first
```

The installer is the only code in this repo that writes into the game directory, it runs by hand,
and it writes two files into `Interface/AddOns/PortalstoneSense`. SavedVariables are the game's to
write; the agent never touches them.

Verification without the game: `packages/agent/test/sensor.test.ts` reads a fixture file shaped
exactly like the addon's output and asserts every projection, including the absent-API case. The
syntax gate is `luaparse` at Lua 5.1 (`packages/agent/test/sensor-addon.test.ts`), so a typo fails
CI rather than waiting for a client to refuse to load the addon.

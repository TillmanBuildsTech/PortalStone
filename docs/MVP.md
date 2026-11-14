# MVP — the first version you can test against real gameplay

## The one job

> Play; then open a page that shows what that session actually was, and keep it.

If that works and the numbers match the game, the risky part of the product is proven: the parser
is trustworthy on real logs, incremental ingest can keep up while you play, and the data model
survives contact with a real install. Everything else is additive.

## In scope

| Piece | What exists now |
| --- | --- |
| Discovery | Finds `_forever_` (and any other flavor) on every drive, plus the account's SavedVariables. Read-only; it never writes inside the game directory. |
| Ingest | Combat log → sessions, incremental by byte offset, resumable across restarts. Re-reads only the session still in progress. |
| Storage | One SQLite file at `%LOCALAPPDATA%\Portalstone\portalstone.db`: sessions, encounters, damage-by-ability, per-log ingest state. |
| UI | Server-rendered pages at `127.0.0.1:48120`: sessions, one session with a run timeline, one run per zone visit, runs, bags, addons, tracked values, diagnostics. Inline SVG charts, no build step. |
| Addons | Base SavedVariables adapter, `_forever_` only for now. Split into **configured** (a tracked value reads from it, listed with those values) and **available to configure** (readable data, nothing tracked yet), with the file's own state alongside (`in use` / `idle` / `no data` / `unreadable`) and the every-property browser behind each row. See `docs/SAVEDVARS.md`. |
| Tracking | Pick any numeric property from any addon and it becomes a saved series, sampled once per SavedVariables flush. Gold is the first use, not a special case. |
| Loop | Rescans every 60s while running; the current session turns green as it grows. |

## Kills, and why "kills 1" was wrong

`kills` counts **killing blows you landed**: a death only counts when the last damage event on the
unit was yours. For a healer in a group dungeon that is almost nothing — a 37-minute Scarlet
Monastery run reported `kills 1` while **84 creatures died** in it (verified by counting `UNIT_DIED`
in the raw log).

So there are two numbers, mirroring deaths:

| column | meaning |
| --- | --- |
| `your kills` | killing blows you landed (unchanged) |
| `field kills` | non-player units that died while the session/run was open, whoever killed them |
| `field deaths` | players who died around you (existing) |

Two rates are shown, because they answer different questions:

| column | basis | question it answers |
| --- | --- | --- |
| `kills / hr` | wall clock | what an evening of farming produced |
| `kills / combat hr` | `engaged_s` | how fast the fighting itself was |

The gap between them is the travel time. Scarlet Monastery: 84 kills, 135/hr on the clock, 285/hr in
combat; the whole session (127 kills) is 122/hr vs 423/hr, because most of that evening was towns.

## Spell ranks

Ranks are not a field in the combat log: every rank of a spell is written with the same name
(`"Holy Light"`) and only the id differs. On the reference log, Holy Light appears as four ids —
647, 1026, 1042 and 10328 — with no rank number anywhere in the file or in any SavedVariables.

So the app counts casts **per spell id** and shows them as separate rows on the session and run
pages: `Holy Light · 647 · 78 casts · avg 307` next to `Holy Light · 1,042 · 32 casts · avg 630`.
Nothing claims to know that 647 is rank 3; the average is what identifies the size of the rank.
Naming ranks would need a spell-id → rank table, which no local file provides.

## Explicitly out of scope (so the MVP doesn't grow)

- SavedVariables adapters (gold, quests, rares, attunement). Diagnostics lists what is on disk;
  nothing is ingested from it yet.
- Accounts, the hosted site, contribution/upload, benchmarks, price history.
- Hand-written per-addon adapters. The base adapter reads them all generically; a capability
  adapter (money, levels, quests) only gets written once the property browser proves the data.
- Per-transaction history. SavedVariables are snapshots at flush time; gold is a series of balances,
  not a ledger of sales.
- An installer, tray icon, or autostart. You run it from a terminal for now.
- Other game flavors beyond "whatever logs exist on disk".

## How to run it

    npm install
    npm run mvp                 # scan, open the browser, keep rescanning every 60s
    npm run scan                # one pass, no server (for cron or a quick check)
    npm run agent -- --port 49000 --install "D:/Blizzard/World of Warcraft"

The interface is `http://127.0.0.1:48120/`. Diagnostics is `/diagnostics`.

## What to check when you test it

1. **Does it find the install?** `npm run scan` prints every install, flavor, log file and
   account it found. If the install is somewhere unusual, `--install` overrides it.
2. **Does the number look right?** Play for ten minutes with a known kill count, then compare
   kills, deaths and total damage against Details. Percentage differences everywhere means a
   parser bug; a consistent gap usually means one event type is being skipped.
3. **Does it keep up while playing?** Watch the newest session go green and its length grow every
   minute. The scan line prints how many lines it read and how long it took.
4. **Does it survive a restart?** Stop the agent mid-session, start it again: the session should
   continue rather than duplicate or truncate.
5. **Does the log rotate cleanly?** On the next login WoW writes a new `WoWCombatLog-<stamp>.txt`.
   Both files should appear as separate rows in diagnostics, and history should not be lost.
6. **Does an addon read cleanly?** `/addons` should list every installed addon as `parsed`, except
   the ones that legitimately saved nothing (`empty`). A red state names the line it choked on.
7. **Does tracking save?** On `/addon?f=…` track `money` (unit: copper), log out and back in:
   `/tracked` should show a second point and the change, and the first point must survive a restart.
8. **Does a session report gold?** The session page shows each tracked value as
   before → after with the change. A session with no flush on one side must say so, not show 0.

Anything that fails: `/diagnostics` shows the layout the parser calibrated to, its confidence,
lines read, unknown-line count and the last error per log. That page is the bug report.

## Known limits, stated plainly

- **Sessions that never end.** While a session is open it is re-read on every scan. That is cheap
  (84 MB/s) but it means the agent reads the whole current session each time it grows. A 6-hour
  session is about 0.6s per scan.
- **No encounter grain yet.** Forever logs seen so far contain no `ENCOUNTER_START`, so raids are
  untested. The schema and UI already carry encounters; they will be empty until a raid log exists.
- **DPS is over combat time**, not wall-clock, so a session with travel time does not read as
  "10 dps". Both numbers are stored (`active_s`, `duration_s`).
- **`node:sqlite` is experimental.** It warns on startup. Acceptable for testing; swap for
  `better-sqlite3` if it causes trouble.
- **Only combat for now.** Gold, quests and rares are the next capability, and the diagnostics
  page lists exactly which files would light them up.

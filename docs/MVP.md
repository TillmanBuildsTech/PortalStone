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
| UI | Server-rendered pages at `127.0.0.1:48120`: session list, session detail, diagnostics. No build step. |
| Loop | Rescans every 60s while running; the current session turns green as it grows. |

## Explicitly out of scope (so the MVP doesn't grow)

- SavedVariables adapters (gold, quests, rares, attunement). Diagnostics lists what is on disk;
  nothing is ingested from it yet.
- Accounts, the hosted site, contribution/upload, benchmarks, price history.
- Any chart. Tables only.
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

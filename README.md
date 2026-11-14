# Portalstone

A local-first World of Warcraft performance tracker. It reads what the game already writes
(combat logs and addon SavedVariables) on your machine, turns it into a queryable store, and shows
you what a session actually cost you. Nothing leaves the machine unless you explicitly share a
coarsened summary.

Read `docs/TECHNICAL-PLAN.md` first. `SPEC-providers-and-capabilities.md` is the data-architecture
contract; `privacy/` is the consent and contribution contract.

## Layout

    packages/core/            pure TypeScript: no filesystem watching, no SQLite, no HTTP
      src/combatlog/          log reader, layout calibration, decoder, sessionisation
      src/testing/makeLog.ts  synthetic log generator (fixtures and benchmarks)
      src/cli.ts              report / make
    packages/agent/           the running app: discovery, SQLite store, incremental scan, local UI
      src/discover.ts         read-only install / flavor / account finder
      src/store.ts            schema and session replacement (node:sqlite, no native deps)
      src/scan.ts             incremental ingest loop
      src/server.ts           server-rendered UI at 127.0.0.1
    privacy/                  consent copy, payload schema, validator
    wowlog.py, probe_sv.py    the prototype these replaced — kept as reference only

## Status

Phase 0 is done and the MVP loop is runnable: the parser is calibrated against real `_forever_`
logs, and the agent ingests them into SQLite and serves a local UI. See `docs/MVP.md` for what the
MVP is and how to test it.

    npm install
    npm run mvp                  # scan, open http://127.0.0.1:48120, rescan every 60s
    npm run scan                 # one pass, no server
    npm run rebuild              # re-derive everything from raw logs (after a parser change)

    npm test                     # 32 tests (core)
    npm run typecheck            # core + agent

    cd packages/core
    npx tsx src/cli.ts make   /tmp/big.txt --mb 500          # default: forever shape
    npx tsx src/cli.ts report /tmp/big.txt

`--layout` selects the log shape to generate: `forever` (no infoGUID, 19-field unit block,
block-anchored payload), `adv19`, `adv10`, `plain`, or `corrupt` (forces a calibration failure).

## Why the parser calibrates instead of hard-coding offsets

Field positions shift between log formats: with and without the infoGUID, with or without a
mid-line stat block, and with the payload either last on the line (classic/retail) or after a
19-field unit block followed by `nil` padding (`_forever_`). The reader therefore detects the
header shape, locates the payload by the anchor that matches, verifies the choice against sampled
damage events, and refuses to produce numbers when no candidate fits — reporting which candidates
failed and why.

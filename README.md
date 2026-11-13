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
    privacy/                  consent copy, payload schema, validator
    wowlog.py, probe_sv.py    the prototype these replaced — kept as reference only

## Status

Phase 0 is in progress: the parser is rewritten and tested; the agent, storage, and UI are not
built yet.

    npm install
    npm test                     # 28 tests
    npm run typecheck

    cd packages/core
    npx tsx src/cli.ts make  /tmp/big.txt --mb 500 --layout adv19
    npx tsx src/cli.ts report /tmp/big.txt

`--layout` selects the log shape to generate: `adv19` (infoGUID + 19-field stat block), `adv10`,
`plain` (no infoGUID), or `corrupt` (forces a calibration failure).

## Why the parser calibrates instead of hard-coding offsets

Field positions shift between log formats, with and without the infoGUID, and with or without the
mid-line stat block. The reader therefore detects the header layout and anchors damage suffixes to
the *end* of the field list, verifies the choice against a sample of damage events, and refuses to
produce numbers when no layout fits — reporting which candidates failed and why.

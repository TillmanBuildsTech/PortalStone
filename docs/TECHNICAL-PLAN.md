# Portalstone — Technical Plan v1

Status: proposal, 13 Nov 2026. Supersedes nothing; amends `SPEC-providers-and-capabilities.md`
(which stays as the data-architecture contract — it is the best document in the repo).

---

## 0. Verdict up front

You have a strong **data-architecture spec**, a **prototype parser that does not parse real
logs**, a **discovery probe that reports capabilities it cannot verify**, and a **privacy
contract that is not enforced by its own validator**. There is no git repo, no test, no CI, no
packaging.

The spec is the expensive part and it's already good. The code is ~700 lines of throwaway. That
is a fine place to be: the plan below is mostly *choosing* the right shape and then deleting the
prototype's assumptions, not rewriting its ideas.

Three decisions drive everything else:

1. **Browser-only is not viable for the core.** A web page cannot watch a directory, cannot
   tail a 4 GB log, cannot run while the game runs, and cannot re-read your SavedVariables
   without a permission gesture every session. "Browser-based" is the right answer for the
   *interface*, not for the *collector*.
2. **Python leaves the product path.** Not for speed (it is fast enough) — for distribution
   (PyInstaller size + AV false positives + tray/autostart), and because the same parser has to
   run in a browser tab for the zero-install funnel. No Python there. Python stays for analysis
   scripts and as the reference implementation for golden-file output.
3. **No server in v1.** Local-only until the parser and the capability model are trustworthy.
   The hosted aggregate service is phase 3 and is the only thing that can be monetised without
   touching Blizzard's addon policy (spec §10 already says this).

---

## 1. What I actually measured

Run on this machine today, against this repo and this WoW install.

| Probe | Result |
| --- | --- |
| `wowlog.py report tests_fixture.txt` | 91 lines, `advanced=False`, you=Bob, dmg 571,239, **taken 0** |
| Same line with the `infoGUID` the docstring documents | **`me=None`, dmg 0** — parser goes blind |
| `coach.sqlite` (ingested from a real 64 MB log) | 32 rows, **`damage_done=0`, `dps=0` on every row** |
| `probe_sv.py` on the real SavedVariables tree | 27 files, 3 recognised, **Details.lua ignored** |
| `validate_payload.py` vs schema violations | **7 of 7 invalid payloads passed** |
| Python parse throughput | 101 MB / 599,560 lines in **11.2 s → 53k lines/s** |
| Node/TS equivalent scan (same file) | 330 ms → **1.82 M lines/s** |
| Rust equivalent scan (same file) | 115 ms → **5.2 M lines/s** |
| Real install | `E:\World of Warcraft`: `_classic_era_` (647 MB), `_retail_` (264 MB), account `LANC3RR1`, 60 `.lua` files / 7.7 MB, newest 2025-08-05, **no `Logs/` directory at all** |

Two of those deserve emphasis.

**The parser fails on the exact case its own docstring describes.** `src` is read at `params[0]`
and `dest` at `params[4]`, which is the *no-infoGUID* layout, while the damage suffix is read at
`spec-1-shift`, which is the *with-infoGUID* layout. One line of the two conventions is always
wrong: on a real advanced log `src` becomes `0000000000000000`, `AFFILIATION_MINE` never matches,
`me` stays `None`, and every damage/heal comparison silently yields zero. That is what the 32
zero rows in `coach.sqlite` are. Related defects found while tracing it:

- `ENCOUNTER_START` reads `params[1]` (encounter id) as the boss name → `boss="1234"`.
- `damage_taken` is structurally always 0 (wrong `dest` index), so "top damage taken", death
  attribution and `last_hitter` (→ `kills`) are all dead.
- `advanced` is a sticky `len(params) >= 38` heuristic and never consults `COMBAT_LOG_VERSION`.
- `FALLBACK_YEAR = 2026` is a constant; the UTC offset is parsed and then discarded; timestamps
  are naive.
- No test of any kind. The fixture mixes infoGUID-present and infoGUID-absent lines, so it cannot
  catch the bug above — it *passes* precisely because it contains both shapes.

**Nothing on your machine would produce a report.** Combat logging has never been enabled on this
install, so the "core, never gated" capability `combat.events` has no source at all, while
Questie (7 MB), Details, RareScanner and BagBrother do. The spec's principle 1 ("zero addons must
still work") is true in the abstract and false in practice: zero addons *and* logging off is the
default state of every install. Onboarding must turn logging on, and that is a product feature,
not a settings page.

---

## 2. Architecture

```
┌──────────────── browser (any Chromium/Firefox/Safari) ────────────────┐
│  hosted funnel: drop a log → parse in a Worker → render → nothing sent │
│  local app:     http://127.0.0.1:48120 → full app, all data local      │
└───────────────┬───────────────────────────────────────────────────────┘
                │ same-origin HTTP (no CORS, no Private Network Access issues)
┌───────────────┴────────────── agent (background, tray, autostart) ─────┐
│ discovery → providers → probe → canonical rows → SQLite (WAL)          │
│ watch: combat log (tail, near-real-time) + SavedVariables (on flush)   │
└───────────────┬───────────────────────────────────────────────────────┘
                │ opt-in, enumerated, coarsened (spec §9)
┌───────────────┴────────────── hosted service (phase 3) ────────────────┐
│ contribute → validate → reject → aggregates → k-suppressed public API  │
└────────────────────────────────────────────────────────────────────────┘
```

**Why a local agent serving its own UI, not a hosted app with a desktop downloader.** The agent
is the same code as a headless service, it can be run on a second machine, and the UI is a static
build that also deploys to the public site. Critically, serving the UI *from the agent* means the
page and the API are the same origin: no CORS, and no Chrome Local Network Access / Private
Network Access permission prompt that a public HTTPS page calling `127.0.0.1` now triggers.
A public page talking to a local agent is the fragile variant of this design; avoid it.

**Why not upload the log to a server.** The log contains every player name, guild, and every
ability cast by everyone present. Uploading it would obliterate the privacy posture in
`privacy/CONSENT-AND-PAYLOAD.md` and the local-first pitch in spec §1. The funnel works on the
log *in the tab*; the browser parses it and never sends it. That is also a better landing page
claim than anything the competition can make.

**Packaging path.** v1: installer that drops the agent + a tray icon + autostart, opens the
browser at `127.0.0.1:48120`. v1.1: the same UI inside a Tauri 2 shell (window, native dialogs,
no port) — a packaging change, not a rewrite. Do not start with Electron; the Chromium+Node
bundle is 120 MB+ before any data.

---

## 3. Stack decision (with the real trade-off)

**Recommendation: TypeScript, everywhere in the product path.**

| Option | Why | Why not |
| --- | --- | --- |
| **TS core + TS agent** (recommended) | One parser compiled for browser and Node; 1.8–3 M lines/s measured; JSON Schema/zod privacy contract native on both sides; fastest iteration; you already work in JS | Needs a Node runtime in the installer (~35–50 MB, or Bun `--compile` for a single ~60 MB exe); GC pauses on 4 GB files (manageable with streamed chunking) |
| **Rust core + wasm + TS UI** | 5.2 M lines/s, 5–10 MB binary, no runtime dependency, best live-tail headroom | Doubles the language count, slows every parser change, and the bottleneck genuinely isn't throughput (see below) |
| **Keep Python** | It exists | PyInstaller bundles, AV reputation, tray/autostart, and no browser story — and Pyodide in the tab is a 10 MB download that is slower than Node |

Throughput is not the constraint. A busy 20-man raid emits roughly 1–3 k lines/s, and a 500 MB
backfill at 1.8 M lines/s is ~4 seconds. Python at 53 k lines/s would technically keep up with
live tailing but makes every historical import a 60–100 second pause, and its `datetime.strptime`
per line is the dominant cost — a hand-rolled TS timestamp decoder will beat the 1.8 M/s floor in
the table above, which did no date math at all.

Rust earns its place later, and only if one of these becomes true: live in-browser tailing via
WASM is a headline feature, the hosted service needs a hot aggregation path, or installer size /
runtime dependency becomes a support burden. The data model below does not change if you switch.

Concrete choices:

| Layer | Choice | Note |
| --- | --- | --- |
| UI | React + Vite + Tailwind | boring on purpose |
| Charts | uPlot | 100k+ points without the ECharts learning curve |
| Data fetching | TanStack Query | polling the agent, cache invalidation on ingest |
| Agent HTTP | Hono | same router runs on Node and Workers later |
| DB | SQLite (WAL) + plain `.sql` migrations | one file, backup = copy, testable with `:memory:` |
| DB driver | `better-sqlite3` (synchronous, fast) | avoid an ORM on the hot path; Drizzle only for query sugar |
| Validation | Zod, generated *from* `privacy/payload.schema.json` | one source of truth, both sides |
| Watch | `chokidar` + byte-offset tail (the prototype's offset idea is correct — keep it) | SavedVariables only change on flush; log changes continuously |
| Agent packaging | Bun `--compile` if acceptable, else Node SEA + WiX/MSIX | decide at phase 2, not now |
| Hosted API | Hono on Fly.io + Postgres (Neon) | phase 3; aggregates only |

---

## 4. Fixing the parser (phase 0, before any UI)

Do not patch offsets. Replace the indexing scheme with **format descriptors**: a table per
`(project, logVersion, advanced)` that names each field position, so `amount` is looked up rather
than counted. One table per format, one place to add format 23.

```
LOG_FORMAT_22_ADVANCED = {
  infoGuid: 0, sourceGuid: 1, sourceName: 2, sourceFlags: 3, sourceRaidFlags: 4,
  destGuid: 5, destName: 6, destFlags: 7, destRaidFlags: 8,
  spellId: 9, spellName: 10, spellSchool: 11,
  // suffix (advanced block present)
  amount: 30, overkill: 31, school: 32, resisted: 33, blocked: 34, absorbed: 35,
  critical: 36, glancing: 37, crushing: 38, isOffHand: 39,
}
```

Rules that fall out of the bug found above:

1. **Detect the layout once, then assert it.** Read `COMBAT_LOG_VERSION` for
   `ADVANCED_LOG_ENABLED` and `BUILD_VERSION`. If absent (Classic logs often lack it, and your
   fixture does), sniff: is `params[1]` a GUID and `params[2]` a quoted name? Then verify with a
   checksum over the first 100 damage events — `amount` must parse as a positive int,
   `school` in 1..127, `destFlags` a hex flag set. If the checksum fails, the provider is
   **`broken` with a named reason**, not zero rows. This is spec §1.3 applied to the parser
   itself.
2. **Year from the filename.** `WoWCombatLog-111226_172753.txt` encodes `MMDDYY`. Fall back to
   the file's first line only if the name is non-standard. Never a constant.
3. **Keep the offset.** Store epoch milliseconds plus the log's UTC offset; render in local time.
   Naive datetimes silently move session boundaries by hours.
4. **Two grains, both stored.** `encounter` (ENCOUNTER_START/END) and `session` (activity window
   with an idle gap). The prototype's 60 s gap is a reasonable session rule; DPS meters segment
   differently, and users will notice, so expose it as a setting with a sane default.
5. **`me` from the log, then from config.** `AFFILIATION_MINE` is the primary signal; fall back to
   the account's own character list when the log only ever shows you as a target (common on
   low-level/alt sessions and in the first minutes of a session).
6. **Golden files, one per provider.** The current fixture is not a golden file: it mixes
   infoGUID-present and absent lines, which is how the bug survived. Split it into
   `format22-advanced.txt`, `format22-nonadvanced.txt`, `classic-era-no-version.txt`, each with an
   expected JSON output, and add one anonymised real 10 MB slice for the fuzz/property test.

Fixing this is not a refactor of `wowlog.py`; it's a new `core/combatlog` module with the old one
deleted. Keep `wowlog.py` only as the reference implementation whose *numbers* the new parser must
match on the fixtures (it computes several metrics correctly on well-formed non-advanced input).

---

## 5. Provider layer

Implement spec §2 literally — it is right. In TS:

```ts
export interface Provider {
  readonly id: string;                 // "sv.details", "combatlog.files"
  readonly version: number;            // shape version, bumped when the read changes
  describe(): ProviderInfo;            // capabilities[], artifact kinds, licence note
  detect(cfg: WowConfig): AsyncIterable<Artifact>;   // all flavors, all accounts, .lua.bak
  probe(a: Artifact): Promise<ProbeResult>;          // ok | shape_mismatch | version_unknown | empty
  read(a: Artifact): AsyncIterable<CapabilityRow[]>; // streamed, never materialised
  score(a: Artifact): Score;                          // 0..1 + freshness source + coverage
}
```

Three amendments to the registry in spec §3, all evidence-based:

- **Add `sv.details`.** `Details.lua` is 112 KB on your account and `Details_DataStorage` keeps
  three days of parsed combat per character. It is the richest provider on a real, casual
  install and it is missing from the registry entirely. It also solves the "log never enabled"
  problem for existing fights.
- **Add `sv.dbm` as a real provider** (`DBM_AllSavedOptions` is currently mapped with zero
  capabilities) — pull logs, timer history, pull counts.
- **Drop `sv.questietrace` and `sv.atlasloot` from v1** to stay inside the 5-adapter cap:
  `combatlog.files`, `sv.details`, `sv.questie`, `sv.rarescan`, `sv.bagbrother`. That set produces
  four of the five top user questions without any addon of ours.

`probe` must assert at least one *shape* predicate, not just "the global exists". The probe as
written reports `character.inventory` + `character.money` satisfied off a 583-byte
`BagBrother.lua`, and would keep doing it after Bagnon renamed a field. Concretely, for
`sv.bagbrother`: `BrotherBags[realm][char].money` is a number ≥ 0 **and** `.class` is in the known
class enum **and** `.items` is a table — otherwise `shape_mismatch`, with the failing path in the
message.

Discovery is also incomplete: the probe scans only `SavedVariables/` at account level. Real data
lives in `<Account>/<Realm>/<Character>/SavedVariables/` too (Details per character, 100–130 KB on
your account). Walk both, and enumerate every `_<flavor>_` present — you have `_retail_` at 264 MB
with no account tree under it, which is the "flavor installed, not played" case the UI must show
as `absent`, not `broken`.

Lua parsing: use a real subset parser (`luaparse`-class or a 300-line Pratt parser) with a hard
size cap that is *reported* when hit. The current `read_text(limit=8_000_000)` silently truncates
any file over 8 MB, and Questie is already 7.3 MB.

---

## 6. Storage

Canonical store, one SQLite file, `%LOCALAPPDATA%\Portalstone\portalstone.db`.

```sql
-- reference
CREATE TABLE provider (id TEXT PRIMARY KEY, version INT, first_seen INT, deprecated INT);
CREATE TABLE character (id INTEGER PRIMARY KEY, guid TEXT UNIQUE, flavor TEXT,
                        account TEXT, name TEXT, realm TEXT, cls TEXT, level INT);
-- all observations carry provenance
CREATE TABLE session (
  id INTEGER PRIMARY KEY, character_id INT, started_ms INT, ended_ms INT,
  tz_offset_min INT, zone_id INT, engaged_s INT, provider_id TEXT, observed_at INT, ingested_at INT
);
CREATE TABLE encounter (
  id INTEGER PRIMARY KEY, character_id INT, boss_name TEXT, boss_id INT, difficulty INT,
  size INT, success INT, duration_s REAL, damage_done INT, damage_taken INT, healing_done INT,
  overheal INT, deaths INT, interrupts INT, provider_id TEXT, observed_at INT, ingested_at INT
);
CREATE TABLE damage_rollup (encounter_id INT, ability_id INT, kind TEXT, amount INT,
                            hits INT, crits INT, misses INT);
-- optional / heavy, retained 14 days by default
CREATE TABLE combat_event (session_id INT, ts_ms INT, event TEXT, src_guid INT, dst_guid INT,
                           ability_id INT, amount INT, school INT, flags INT);
-- capabilities from addons
CREATE TABLE money_snapshot (character_id INT, date TEXT, copper INT, provider_id TEXT, observed_at INT);
CREATE TABLE item_snapshot  (character_id INT, date TEXT, container INT, slot INT, item_id INT, count INT);
CREATE TABLE quest_state    (character_id INT, quest_id INT, state TEXT, date TEXT, provider_id TEXT);
CREATE TABLE rare_kill      (character_id INT, npc_id INT, killed_at INT, provider_id TEXT);
CREATE TABLE price_sample   (item_id INT, house_id INT, date TEXT, unit_price INT, quantity INT);
CREATE TABLE conflict       (fact_table TEXT, fact_key TEXT, provider_id TEXT, value TEXT, lost_to TEXT, at INT);
```

**Retention, quantified.** Raw logs run ~176 bytes/line; a 6-hour raid at 100 MB/session-file
scale is ~1 GB, ≈6 M lines, ≈4 M damage/heal events. Storing every event is ~200–400 MB per raid
night plus indexes — 5–10 GB a year, which is not a support burden anyone should discover on their
own. Defaults:

- rollups and encounters: **forever** (this is the product's asset, and it's ~1 MB/night)
- per-event rows: **14 days**, off by default, toggled per investigation
- raw log slices: **zstd-compressed, 60 days**, with byte-range index so a "re-analyse this fight"
  can replay the exact lines

Add a disk gauge to Settings from day one. This answers spec §11 Q1/Q2: one SQLite with a
semantic layer, events retained short and rollups retained forever.

---

## 7. Privacy module — the best part of the repo, with one hole

`CONSENT-AND-PAYLOAD.md` is publishable as-is. It also exposes the one structural claim the code
does not honour: **`validate_payload.py` never validates against `payload.schema.json`.** It
checks top-level required keys and unknown top-level keys, then its own privacy invariants. I ran
seven schema violations through it — bad enum, extra nested key, level as a string, negative
damage, non-date `sent_at`, missing `consent.granted_at`, bad `platform` — and **all seven
passed**. The consent copy promises "payloads are validated on our side to reject any that contain
names"; the actual guarantee currently comes only from how the payload is built.

Fix, in this order:

1. Real JSON Schema validation with **Ajv** (`strict: true`, `additionalProperties: false`
   everywhere already declared) → then the privacy invariants → then reject, never sanitise.
2. Generate the TS types and the client-side pre-send check from the same schema file. Do not
   hand-maintain a second copy in TS.
3. The privacy invariants stay hand-written (a schema can't say "this string looks like a
   character name"), and become *tests* with a fixture of 20 realistic leaky payloads.
4. Push the k-anonymity threshold for price data above 20 installs — a single auction-house whale
   can dominate a 20-install average.

---

## 8. Phases and exit criteria

**P0 — make the data trustworthy (2–3 days)**
`git init`, CI, the format-descriptor parser, golden files, `probe` shape assertions, Ajv in the
privacy validator. *Exit: a real 500 MB log ingests in <10 s, `me` detected, `damage_taken > 0`,
boss names are names, and a deliberately corrupted log produces a named failure rather than zero
rows.*

**P1 — first useful session report (1–2 weeks)**
Agent + SQLite + capability model + 4 providers + the local UI + onboarding that gets logging
enabled. *Exit: fresh install on a machine with no addons → an accurate session report in under
three minutes, including the 40 seconds it takes to enable logging.*

**P2 — degrade honestly (2–3 weeks)**
Locked/stale/partial cards per spec §2, provenance and conflict resolution, disk gauge, export,
tray + autostart, installer. *Exit: every panel can be traced to `provider_id` + `observed_at`, and
no panel can be empty without saying why.*

**P3 — the funnel and the only monetisable surface (4–6 weeks)**
Static site + drop-a-log in-tab analyser; consent flow; `/v1/contribute` with Ajv + reject +
k-suppression; public price history and benchmarks; Battle.net OAuth for account linking. *Exit:
a stranger can get value from the site with no install, and the paid tier is server-side
(benchmarks, history, guild reporting) — never an addon or a local gate, per spec §10.*

**P4 — after 1,000 installs**
Own sensor addon, signing + auto-update, opt-in crash reports, multi-user/guild views.

---

## 9. Risks I'd write down now

| Risk | Reality |
| --- | --- |
| **Adapters outlive their addons** | Every provider is a permanent tax, and Details/Questie change shape on patches. Golden files + named failures are the only thing that keeps this from becoming silent breakage. Cap at 5 and mean it. |
| **The meter problem is already solved** | Details! is better than anything you'll ship in-game, and Warcraft Logs owns raid analysis. Your wedge is *synthesis across sources and time* — "what did this session cost me, what's left, what's it worth" — not another parse of the same fight. Make the v1 report answer questions no single addon can. |
| **Combat logging off by default** | The one capability you called "core" needs a user action. Onboarding is the product. |
| **Blizzard policy** | Paid addons are prohibited; companion apps are tolerated. Anything that makes the addon's value depend on payment is the contested line, and spec §10 already flags it. Keep the paid surface server-side and say so publicly. |
| **Support surface** | Windows first. macOS second. Linux never (Proton paths are a rabbit hole). Multi-account, multi-flavor, `.bak` files, OneDrive-redirected folders, and logs on a second drive are all real. |
| **Trust** | The product's claim is "your data never leaves". That claim is only worth anything if the code that could break it is small, reviewable, and tests prove it doesn't. That's why P0 before P1. |

---

## 10. Decisions — answered 13 Nov 2026

1. **Install acceptable — yes.** Local agent confirmed. The website is a first-class surface for
   hosted stats (price history, benchmarks, character/profile pages), not merely a funnel: it is
   the only place cross-install numbers can exist without breaking the local-first promise.
2. **v1 flavor: `forever` only.** Classic Era / retail adapters are deferred. This affects the
   golden-file matrix (one flavor to validate, not four) but it also means **P0 cannot be finished
   without a real Forever log sample** — no Forever client is installed on this machine, and the
   format has not been observed. Everything below is built to calibrate rather than assume; the
   first real sample either confirms the layout or is added as a descriptor.
3. **Rust: no for v1.** Not decided explicitly, but the measured gap does not justify it (see §11).
   Revisit only if live in-browser tailing via WASM becomes a headline feature.
4. **Time budget:** unknown; P0 was scoped to two days of work and is done.

---

## 11. P0 status — parser rewritten, measured 13 Nov 2026

`packages/core/` replaces `wowlog.py` as the product parser. 28 tests, typecheck clean, no
`any` in the public surface.

What changed, against the defects in §1:

| Defect | Now |
| --- | --- |
| header/suffix read under contradictory assumptions | header anchored at the start (infoGUID detected), damage/heal suffix anchored at the **end**, so mid-line stat blocks cannot shift it |
| `me=None`, every number zero on a real log | attribution by `AFFILIATION_MINE` flag (pets included), explicit `selfGuids` override |
| boss names read as encounter ids | `ENCOUNTER_*` decoded by shape, name from the name field |
| `damage_taken` structurally 0 | destination unit read from the calibrated header |
| `FALLBACK_YEAR` constant, offset discarded | year from the rotated filename, epoch ms + offset retained |
| zero rows on a shape change | calibration failure returns `layout_unknown` with the six candidates and their first mismatch |
| no tests | 28, including a regression guard that `damageTaken > 0` and one that the original `tests_fixture.txt` is rejected as internally inconsistent (70/30 mix of two shapes) |

Measured on this machine, 500 MB / 2.5 M lines:

| | result |
| --- | --- |
| infoGUID + 19-field stat block | 6.4 s, 78 MB/s, 389k lines/s, 0 unparsed, correct totals |
| no infoGUID, no stat block | 7.9 s, 63 MB/s, 425k lines/s, correct totals |
| `wowlog.py` on the same bytes | `you=None`, 0 sessions, damage 0 |
| original `tests_fixture.txt` | rejected: `best candidate matched 70% of 77 damage events; first mismatch: srcGuid is not a guid` |

End-to-end throughput is ~390k lines/s, not the 1.8 M/s scan floor in §1: per-line decode plus
rollup dominates. Still 8× Python and 4× inside the P0 target (500 MB in under 10 s); a 1 GB raid
night ingests in ~13 s.

**Still blocked on a real Forever log:** layout confirmation, whether Forever keeps the 19-field
stat block, whether `UNIT_DIED` puts the victim in the source block (assumed, true in every
format seen), and whether `ENCOUNTER_*` carries an infoGUID. The first 2 MB of any Forever
`WoWCombatLog.txt` settles all four.


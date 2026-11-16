# SavedVariables: the base adapter

The combat log cannot answer economy or progression questions. Verified against a 61 MB `_forever_`
log: there is no money, XP or level event in it — the only "gold" strings are player names. Everything
of that kind lives in the SavedVariables files addons write on logout.

So before writing an adapter per addon, there is one adapter for *all* of them. It reads any
SavedVariables file, reports what properties it exposes, and scores which numbers look trackable.
A specific adapter (money, levels, quests) is then a projection over what this proves, not a guess.

```
packages/core/src/savedvars/lua.ts     Lua table reader (data only, never executes)
packages/core/src/savedvars/shape.ts   introspection: paths, types, ranges, candidates
packages/agent/src/addons.ts           discovery + cached read + file states
packages/agent/src/tracking.ts         sampling a chosen property into a time series
```

## Reading

SavedVariables are Lua source — `BrotherBags = { ["forever"] = { ... } }` — so they are parsed as
data, with a real reader rather than regex: string and numeric keys (including `[0]`), `nil` holes,
quoted and long strings, escapes, hex/float/exponent numbers, comments, and one global per line.
A file that breaks mid-way keeps whatever was read before the break, with a warning naming the line.

All 21 SavedVariables files on the reference machine parse with zero warnings; the largest (241 KB)
takes about 5 ms.

### File states

| state | meaning |
| --- | --- |
| `ok` | parsed, properties indexed |
| `empty` | valid file that holds nothing — e.g. `X = nil`, or zero bytes |
| `unparseable` | the reader could not make sense of it; the reason names the line |
| `too_large` | over 64 MB, refused rather than stalled |
| `unreadable` | filesystem error |

`empty` and `unparseable` are deliberately different: one means "the addon has not saved anything
yet", the other means "this app has a bug or the addon changed its format".

## Introspection

For every global the reader walks the table once into a *shape*: every distinct path, its type, how
many values landed on it, the numeric min/max/sum, and up to three sample values.

Two rules keep the result a page instead of a dump:

- **Collections collapse.** A table of 4,000 quest ids becomes one `[*]` path with 4,000 instances.
  Integer-keyed tables of 8+ entries, and named tables of 64+, are treated as collections.
- **Entity siblings fold.** `forever["Dead Sadfatkid"].money` and `forever["Slouch Mage"].money` are
  the same property twice. Siblings that share at least 70% of their field names fold onto
  `forever[*].money`, so a character map reads as one property over N characters. The global's own
  children are never folded, so `toons` and `forever` keep their names.

### Candidate scoring

A number is proposed as trackable when it *varies*, is per-entity, appears often, is shallow, and is
not a 0–1 fraction (colours, alphas) or a one-letter field (`r`, `g`, `b`). Constants are still
listed, marked `flag`, below the metrics.

This is discovery, not semantics: the score says a number is *shaped like* a metric. The user decides
what it means — which is why the property page shows samples next to every candidate.

## Tracking

Selecting a property creates a `tracked_metric` row: `(addon_file, global_name, path, label, unit)`.
On every scan, each tracked property is resolved and sampled:

- **Every instance is collected**, then summed. `forever[*].money` is one value per character, so the
  series is the total across the character map and `instances` records how many wallets it came from.
  When only one entity matches, the series is that entity's value.
- **A sample is keyed by the file's mtime**, not by the scan. SavedVariables only change when the game
  flushes them (logout, `/reload`, exit), so the mtime *is* the observation time. Rescanning every 60
  seconds cannot create duplicate points, and the chart's x axis is honest about when it looked.
- **A missing property stores nothing.** It does not store zero: a zero would read as "your gold
  went to nothing" rather than "the addon has not written that field yet".
- **Multiple accounts:** the file that flushed most recently wins, and its absolute path is stored on
  each sample. Two accounts' wallets are never averaged into one number.

Units decide how the number reads: `plain` (1,234), `copper` (15g 20s 79c), `seconds` (1h 0m). Axis
labels use a short form (15.2g) while tooltips keep the full value.

**Numeric strings are coerced.** Addons disagree about types: BagBrother writes `level = 31`,
Attune writes `level = "31"`. A clean integer or decimal string is treated as a number, because the
alternative is a property that looks trackable in the browser and then never samples. `"1,234"` and
`"31g"` are not coerced — those are text, and they stay text.

**Per-entity values are reachable.** A `[*]` candidate is a total across instances; its row has a
`pick one →` link to the parent table, where each concrete key (`forever["Dead Sadfatkid"]`) can be
tracked on its own. Use that when a sum is wrong for the quantity — a level, for example.

## Equipment (sets)

BagBrother stores `equip` as an array indexed 1..19 — one entry per inventory slot, `nil` where
nothing is equipped, each entry an item string (`3581::::::::31:1486::11:::::::`, item id plus
enchant/gem context). That is a *set of slot → item*, not a number, so it is tracked with
`kind = 'set'`:

- every flush records the members with the key that produced them (`{k: "16", v: "3581:…"}`), and
  `value` is the member count, so a chart still has something to draw;
- a change is a **per-slot diff** — `main hand: #5000 → #6000` — not "one of 19 strings changed";
- removed pieces are listed with the current set rather than disappearing;
- slot numbers are the client's inventory slots, so slot 16 is the main hand even if a slot is empty;
- items show by **id only**. There is no local item database, and the Forever item endpoint 404s for
  a large share of ids, so a name would be invented. Adding one is a static-data job, not a parser job.

Track it from `/addon?f=…` → *lists you can track as a set* → **track as set**, or from any table of
scalars in the browser. The same mechanism fits Attune's `attuned` flags and Questie's completed
quest sets — anything whose value is membership rather than a number.

Sessions show gear changes the same way gold shows its delta: the bracket pair of flushes, minus any
session that cannot be bracketed.

## Item names (and what does not work)

SavedVariables carry item **ids** only. Names are optional and cached:

| source | state |
| --- | --- |
| `PORTALSTONE_ITEM_API` — any endpoint | `GET /{id}` must return `{"name": "…"}`; point it at the Forever API when you have a key |
| `PORTALSTONE_ITEM_NAMES` — a JSON file | `{"123": "Name"}`, e.g. a wiki export or an earlier API pull |
| `PORTALSTONE_BNET_ID` + `PORTALSTONE_BNET_SECRET` (+ `PORTALSTONE_BNET_REGION`, default `us`) | Blizzard's official game-data API, client credentials, per user |
| no source | ids only — `#3581`; nothing breaks |

Each name is stored once in `item_name` and never fetched again, so an API that improves over time
fills the cache progressively and a source that breaks tomorrow does not erase what it already gave.
The gear page reports coverage (`9 of 16 items named · 7 unknown`) rather than pretending.

### The official Blizzard API

It works for names, with three caveats worth knowing before wiring it up:

1. **It needs your own credentials.** A free client from `develop.battle.net`; Blizzard's own forum
   guidance is that credentials are not shareable, and that a local open-source app having each user
   supply their own is the acceptable shape. This app therefore reads them from the environment and
   never ships a secret. Tokens are cached for their lifetime (~24 h) rather than re-issued per call.
2. **Limits:** 36,000 requests/hour and 100/second per client, 50 clients per developer. One item is
   one request, so the app asks for at most 25 ids per scan and backs off on 429.
3. **Unauthenticated requests answer 404, not 401.** Verified:

   | request | status |
   | --- | --- |
   | no token, existing item | `404` |
   | bogus bearer token | `401` |
   | no client credentials at the token endpoint | `401` |

   So an app that treats 404 as "unknown item" cannot distinguish "no access" from "no such item".
   Here the token comes first, and a 401/403 is reported as a configuration error: it is never
   recorded as an unknown item, and nothing is cached as a miss.

**The private-server risk.** Blizzard's static data describes *official* items. Forever is its own
server: many ids line up (its client is modern), but a custom item will be missing, and worse, an id
that was renumbered could return a *wrong* name. Names therefore carry their source (`blizzard`,
`api`, `file`) and the gear page shows it on hover, so a name never looks more certain than it is.

**A miss is remembered for a week** (`item_name_miss`). Without that, a Forever-only item would be
requested on every single scan forever — 1,440 requests a day for one item that will never resolve.

**AtlasLoot does not work as a name source, despite being installed.** Its SavedVariables file is
707 bytes of GUI profile settings (`selected = "RazorfenKraulForever"`, minimap position) — no item
data. The item names live in its data files under `Interface/AddOns/AtlasLootContinued_*/`, and they
are *Lua comments*:

```lua
{ 7, 2963 }, --Bolt of Linen Cloth / 10 / 25
```

That is text written for humans, so reading it means scraping comments, which this project does not
do. QuestieDB ships a 17 MB baked metadata `.toc` with an opaque format; also not a structured
source worth reverse-engineering. The registry entry `sv.atlasloot → world.loottables` is therefore
wrong about SavedVariables and should be treated as a candidate for *static addon data*, not a
provider we can read today.

## Session attribution

Gold per session is the reason any of this exists, and the honest form of it is a *bracket*:

- **before** = the last sample at or before the session's first event
- **after** = the first sample at or after its last event
- **change** = after − before, only when both exist

Everything else is reported as unknown, never as zero:

| case | what the page says |
| --- | --- |
| session still open / no logout since | `no flush since this session ended` |
| tracking started after the session began | `no flush before this session began` |
| one flush pair covers two sessions | the number, plus `shared across 2 sessions` |
| play continued after the last combat event | a separate **after this session** table: the flushes no session covers |

The third case is why the count exists: two evenings between the same login and logout cannot be
split, so the page shows the delta and says it is shared instead of inventing an attribution.

The fourth case matters because combat is not the only thing a player does. Banking, spending gold
and turning in quests write nothing to the combat log, so a sitting that produced no combat
produces no session — while SavedVariables still flush at logout and `/reload`. Those flushes are
not folded into the session bracket (they can be minutes or hours later, or a different sitting);
they are shown underneath it, bounded by the next session's start. That answers "where did my gold
go" without claiming the spend happened mid-dungeon. A wildcard path such as `forever.*.money`
also carries a `sum of N` hint, because the number is several characters' wallets added together,
not one.

A zero delta reads `no change`, not a dash: a dash in the change column means *unknown*, and the two
must not look alike.

## Gold, end to end

1. `/addons` → **BagBrother** (registry: `sv.bagbrother`, expected `character.money`).
2. Its property list shows `BrotherBags.forever[*].money` — two characters, `370 – 152,079`.
3. **track** with unit `copper`. The current flush is sampled immediately, so the page is not empty.
4. `/tracked` shows `15g 24s 49c` (the paladin's 152,079 plus the mage's 370), and each later flush
   adds a point with its change.

Verified on a synthetic install: 152,449 copper, then 268,820 after a second flush, `+11g 63s 71c`,
two points on the chart, history intact across a restart.

## Limits, stated plainly

- **Flush granularity.** The line moves once per login/logout (or `/reload`), not per mob.
- **No per-activity attribution.** A delta cannot be split across a dungeon and an auction house
  visit; the combat log and SavedVariables have no shared key.
- **Summed characters.** The `[*]` series is a total. Tracking one character means using the
  `pick one →` link on the candidate row and tracking a concrete path (`forever["Name"].money`).

## What the real files taught us

Numbers from the reference machine, worth knowing before writing a capability adapter:

- **BagBrother** keeps `money` and `level` as numbers per character: `forever["Dead Sadfatkid"].money`
  = 191,101 copper, `level` = 35. This is the easiest source for both, because it only contains your
  own characters.
- **Attune** stores `level` as a *string* (`"31"`) and its `toons` table is a 26-member **guild
  roster**, not your characters. `toons[*].level` therefore sums 26 other people — meaningless.
  Track `toons["Your Toon"].level`, or use BagBrother.
- **Questie** carries per-character journey history (`journey[*].Level`, `.Timestamp`, `.Quest`) —
  useful later for level-up moments, but it is not a money source.
- Three files in the reference account are 26–37 bytes and legitimately hold nothing
  (`X = nil`): they read as `empty`, not as errors.
- **Gold earned is not gold made.** Vendor sales, repairs, mail and auction income all fold into the
  same number. A true ledger needs an addon that logs transactions — our own sensor addon, which is
  the `addon.ours` provider in `SPEC-providers-and-capabilities.md`.

## Next step, when wanted

A capability adapter is now small: read the file, project the paths this document names, and write
rows with `provider_id` + `observed_at`. The capability registry (`packages/agent/src/providers.ts`)
already maps each known file to the capabilities it is expected to satisfy, which is the same table
the addons page shows.

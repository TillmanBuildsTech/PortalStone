# Capabilities, Providers, Features — v0.1

A local-first WoW performance tracker. This document is the data architecture: what the app
needs (capabilities), where it can come from (providers), what lights up when it's there
(features), and how the app stays honest when a source is missing, stale or broken.

Nothing here assumes the user runs any particular addon, or any addon at all.

---

## 1. Principles

1. **Zero addons must still work.** The combat log is the only source that is always present.
   It is never gated, never degraded, and it is the entry point.
2. **Absence is a feature, not an error.** A capability with no provider shows an unlock card,
   not a broken panel. Missing data is how users discover what to install.
3. **Never show a silently empty or silently stale chart.** Every panel resolves to one of
   `full / partial / stale / locked`, and says which and why.
4. **Never blend sources invisibly.** Every stored fact carries `provider_id` and `observed_at`.
5. **Local by default.** Reads happen on the user's machine. Uploads are explicit, opt-in, and
   enumerated item by item before they leave.
6. **The addon is an accelerant, not a requirement.** Zero addons = a usable app; our sensor
   addon = every capability satisfied at once.

---

## 2. Model

```
Provider ──produces──> Capability <──requires── Feature
    │                     │
    └──observed_at────────┴──provenance──> canonical rows
```

- **Capability** — a named fact-set with a shape, a freshness SLA, and a criticality flag.
  Example: `auction.prices` (item id → unit price per auction house, daily granularity).
- **Provider** — an adapter that produces one or more capabilities. Identity is stable
  (`sv.bagbrother`), independent of the file it came from.
- **Feature** — a user-visible view or answer. Declares a minimum viable capability set and a
  degradation policy.

### Provider interface

Every provider implements four methods and one descriptor:

| Method | Question | Output |
| --- | --- | --- |
| `detect` | Is any artifact present? | bool + paths |
| `probe` | Is the shape what we expect, and what version? | `ok / shape_mismatch / version_unknown` + detail |
| `read` | Produce canonical rows | rows + warnings |
| `score` | How much do I trust this right now? | 0–1 + freshness + coverage |
| `describe` | Static metadata | id, capabilities, artifact kind, docs URL, licence note |

`probe` is not optional. A global that exists with the wrong shape is the normal case after an
addon update, and it must produce a *named* failure, not zero rows.

### Provider states (user-visible)

| State | Meaning | UI |
| --- | --- | --- |
| `connected` | probe ok, fresh within SLA | green, "last synced 2h ago" |
| `stale` | probe ok, older than SLA | amber, "last synced 6d ago — play and log out, or /reload" |
| `partial` | probe ok, some expected fields missing | blue, lists what's missing |
| `broken` | probe failed after previously working | red, "Auctionator changed its format; adapter update needed" |
| `absent` | nothing detected | grey, unlock card |

Distinguishing `absent` from `broken` matters: one is an upsell, the other is your bug.

---

## 3. Capability registry

Freshness SLA = how old data may be before the capability is `stale`. Criticality = `core`
(never gated) or `optional`.

| Capability | Shape | SLA | Criticality | Providers (v1 candidates) |
| --- | --- | --- | --- | --- |
| `combat.events` | log lines → sessions/pulls, damage, casts, deaths, zone timeline | live + 1h | **core** | `combatlog.files` |
| `character.money` | char → money (copper) time series | 1 session | optional | `sv.bagbrother`, `sv.bagsync`, `sv.tsm`, `addon.ours` |
| `character.inventory` | char → container/slot → item string | 1 session | optional | `sv.bagbrother`, `sv.bagsync`, `addon.ours` |
| `character.equipment` | char → slot → item + bonus ids | 1 day | optional | `api.blizzard.forever` (equipment), `sv.bagbrother` |
| `character.stats` | stats/ilvl snapshots | 1 day | optional | `api.blizzard.forever` (statistics) |
| `auction.prices` | item → price/qty per house, per day | 1 day | optional | `api.blizzard.forever` (commodities/auctions), `sv.auctionator`, `sv.tsm.auction` |
| `profession.skills` | char → profession → skill | 1 day | optional | `api.blizzard.forever` (professions), `addon.ours`, `sv.tsm` |
| `quest.completion` | char → quest id → state | 1 day | optional | `sv.questie`, `api.blizzard.forever` (quests), `addon.ours` |
| `progression.attunement` | char → step → done | 1 day | optional | `sv.attune`, `addon.ours` |
| `roster.levels` | guild → member → class/level/attunement | 1 day | optional | `sv.attune`, `api.blizzard.forever` (guild roster) |
| `rare.spawns` | npc → spawn samples/timestamps | 1 week | optional | `sv.rarescan` |
| `world.loottables` | source → items | static | optional | `sv.atlasloot` |
| `world.mapdata` | map → sub-rects | static | optional | `sv.questietrace` |

Forever API provider notes: see §7. It is the only zero-install route to equipment, statistics,
professions, quests, and — since Nov 6 — auction data.

---

## 4. Feature gating

Each feature declares requirements and an explicit degradation:

```yaml
feature: gold_per_hour_by_zone
requires:
  - combat.events        # zone timeline + session boundaries
  - character.money      # money deltas
viable_with: [combat.events, character.money]
degrades_to: "session-level gold/hour without zone attribution"   # partial
locked_because: "no money source connected"
```

Rules:

1. **Locked features stay visible.** A card with an unlock list, never a hidden route.
2. **Every lock names the capability, not a product.** "Money over time — 2 sources available"
   then the provider list with cost-of-install facts.
3. **Partial is a first-class outcome.** Combat-only gold/hour (no per-zone split) is still
   useful and should say what's missing.
4. **No feature may require the sensor addon exclusively** if a third-party provider exists;
   offering only our addon makes the paywall/loophole smell worse.

---

## 5. Provenance and canonical storage

Everything lands in a canonical store, then features query it. Minimum columns on every fact:

- `provider_id` — which adapter produced it
- `observed_at` — when the source observed it (not when you read it)
- `ingested_at` — when the app read it
- `game_flavor` — `forever` / `retail` / `classic_era` / `classic_tbc` (SV buckets are per-flavor;
  a `forever` reading must never be compared with a retail one)
- `character_guid` — `Player-XXXX-XXXXXXXX` where available; `name-slug` for realmless Forever

Conflicts (two providers disagreeing on the same fact) resolve by declared precedence per
capability, and the losing value is kept, not deleted. An aggregate that mixes sources without
that rule is unfalsifiable, which defeats the point of owning the data.

---

## 6. Discovery mechanics (Windows)

Paths, per account: `World of Warcraft/_<flavor_>/WTF/Account/<ACCOUNTNAME#>/SavedVariables/*.lua`

- Enumerate all flavors; never assume `_retail_`.
- Multi-account users have several `ACCOUNTNAME#` trees. Treat each as a separate account scope.
- `.lua.bak` siblings exist and are usually one flush behind — usable as fallback, never as truth.
- Fingerprint by **top-level global**, not filename: `BrotherBags`, `BagSyncDB`,
  `TradeSkillMasterDB`, `AUCTIONATOR_PRICE_DATABASE`, `Attune_DB`, `RareScannerDB`,
  `QuestieConfig`, `AtlasLootDB`, `QuestieTraceDumps`.
- Parse with a real Lua-table parser (Lua subset: `nil` holes, `[0]`, `[key] = value`, string
  escapes, numbers, booleans, nested tables). Regex extraction is for exploration only.
- **Freshness must come from the data where possible.** `os.path.getmtime` on a synced or
  restored folder lies; several addons embed epoch timestamps (`lastClean`, session times) which
  are far better evidence.

---

## 7. Forever API provider (`api.blizzard.forever`)

Community-documented (unofficial, subject to change):

- Namespaces: `static-forever-{region}` (pinned `static-1.60.1_70399-forever-{region}`),
  `dynamic-forever-{region}`, `profile-forever-{region}`. US/EU/KR/TW.
- **No realms — rulesets.** `/data/wow/ruleset/index`. 15 roleplay-pvp / 3 roleplay / 2 normal /
  1 pvp per region.
- **Characters are realmless**: `{name}-{surname}` lowercase slug. Profile + equipment,
  achievements, appearances, collections, encounters, professions, pvp-summary, quests,
  reputations, specializations, statistics, titles, character-media.
- Characters appear **only from level 10 and only after logout**; media lags hours.
  Account summary (user token) can trail 20–40 min. This makes the API a "final state" provider,
  not a live one — pair it with the log for anything time-sensitive.
- **Auctions are live** (since Nov 6): `/data/wow/ruleset/{id}/auctions/{houseId}` and
  `/commodities`. House ids 110–121, 123–125 (5 Alliance, 5 Horde, 5 Blackwater). Some houses
  return no `auctions` field at all. 50–68k auctions per house, ~9 MB per response.
  **Identical data across rulesets today — do not sum across rulesets.** The old
  `/data/wow/auctions/commodities` is still 404.
- **43% of AH item ids 404** from `/data/wow/item/{id}` in `static-forever` — resolve names
  lazily and store item ids even when the name is unknown.
- OAuth user tokens are the only clean way to discover *which* characters a user owns without an
  addon; app client id/secret is otherwise per-request.

Implications: `auction.prices` moves from "needs an addon" to "needs an API key + one nightly
crawl" — which removes the single biggest third-party dependency on Forever, where TSM is
reportedly not updated.

---

## 8. Adapter maintenance policy

- **Cap at 5 adapters for v1.** Every adapter is a permanent maintenance obligation.
- Each adapter ships a **golden-file test**: one real, anonymised `SavedVariables` sample plus
  the expected canonical rows. Adapter changes break the test before they break users.
- Each adapter declares a **shape version** and tolerates unknown extra fields (forward
  compatible read, never strict equality).
- Provider failures are surfaced with the addon name and the reason, so users report
  "Auctionator broke" rather than "the chart is empty".
- Deprecating a provider keeps its rows: mark `provider_id` deprecated, stop reading, keep
  history.

---

## 9. Privacy

- Local reads, local store. No telemetry without an explicit toggle.
- **Third-party data exists in this corpus.** Guild roster addons (e.g. Attune) contain other
  players' names, levels and progress. Those players never consented to anything. Keep such data
  local; if ever aggregated, drop names entirely and aggregate only numerics.
- Any upload shows a preview: exactly which fields, and how many characters/guildmates are in it.
- Precedent to copy: QuestieTrace ships `dataCollectionConsent = false`; RareScanner has its own
  telemetry toggle. Default off.

---

## 10. Monetisation constraints (design input, not decided here)

- Blizzard policy: addons must be free, no paid features, no premium tiers. A companion desktop
  app is de facto tolerated (TSM, WowCoach, Zygor), but an addon whose value requires payment is
  squarely in the contested loophole.
- Local-first and offline gates are incompatible: enforcing "1 character free" requires a licence
  check that phones home, which contradicts the ownership pitch and is trivially bypassed anyway.
- The defensible paid surface is whatever structurally cannot run on the user's machine:
  benchmarks, aggregation, cross-machine backup, guild-tier reporting.

---

## 11. Open decisions

1. Canonical store: one SQLite with a semantic layer, or per-capability tables + views?
2. Where does the "canonical event store" boundary sit — do we keep raw log lines, or only parsed
   events? (Storage suggests parsed + compressed raw archive.)
3. Character identity for Forever: `name-slug` is mutable (name changes), the API `id` is stable.
   Which is the primary key?
4. Does the app ship its own log-to-SQLite ingest, or ingest on open only? (Live ingest is only
   justified by the post-wipe card.)
5. Aggregation: what is the smallest consent-respecting payload that still makes benchmarks useful?

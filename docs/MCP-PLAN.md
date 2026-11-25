# MCP server plan: `packages/mcp`

Expose PortalStone's SavedVariables- and combat-log-derived data to an MCP client (Claude Desktop,
Claude Code, any MCP host) as **read-only tools**, so you can ask natural-language questions —
"how much gold did my paladin make last session", "what was my ilvl trend this week", "which addon
exposes money" — and get answers grounded in the exact data the app already holds.

This is a **new surface over the existing core/store**, the same way `packages/agent/src/server.ts`
is. It unlocks no new data (see §6).

---

## 1. Package placement

A new workspace package: **`packages/mcp`** (`@portalstone/mcp`), inside the existing monorepo —
**not a separate repo**. Dependency direction is one-way, matching the layers already in the repo:

```
@portalstone/mcp  ──imports──▶  @portalstone/agent  ──imports──▶  @portalstone/core
   (MCP surface)                   (store, discover,                (pure reader/parser)
                                    readSensor, listAddons)
```

What it imports (all already exported):

- `@portalstone/agent/src/store` — `Store` class (SQLite; the whole query surface, §4).
- `@portalstone/agent/src/discover` — `discover()` → `InstallInfo[]`.
- `@portalstone/agent/src/sensor` — `readSensor(installs)` → `SensorRead`.
- `@portalstone/agent/src/addons` — `listAddons`, `readAddon`.
- `@portalstone/agent/src/providers` — `PROVIDERS`, `providerFor` (capability registry, §6).
- `@portalstone/core` — only if a tool needs raw shape introspection beyond what the agent wraps
  (it mostly doesn't; the agent already re-exports what the browser needs).

No code in `agent` or `core` imports `mcp`. The agent does **not** need to change for v1; `mcp` is
additive. (Optional later: a `--mcp` flag on `main.ts` to also host it over HTTP — see §3.)

---

## 2. Reuse vs. reimplement — **import the store/core directly**

**Decision: the MCP tools open a `Store` and call `discover`/`readSensor`/`listAddons` in-process.
They do NOT HTTP-call the agent's `/api/*` endpoints.**

Why:

- **No running server required.** `main.ts` builds everything from three cheap calls: `discover()`,
  `new Store(dbPath)`, `readSensor(installs)` (`main.ts:73,83,106`). The MCP process can do the same
  against the same `coach.sqlite`. A user running the MCP server from Claude Desktop should not also
  have to keep `npm run mvp` alive.
- **The store is the real stable surface, not `/api`.** `/api/*` today is only 6 routes
  (`/api/summary`, `/api/session`, `/api/run`, `/api/dashboards`, `/api/dashboard`, `/api/addons`,
  `/api/addon` — `server.ts:186–393`) and each is a bespoke JSON projection for one web page. The
  `Store` class exposes ~40 typed methods (`listSessions`, `totals`, `characters`, `session`,
  `segments`, `abilities`, `trackedMetrics`, `samples`, `zoneAggregates`, `bagDropStats`,
  `recentRuns`, `pvpSummary`, …). Binding tools to the store gives a far richer surface than the
  web JSON, with types, and nothing to keep in sync across a network hop.
- **Freshness.** The store is only as fresh as the last scan. The MCP server should run a scan on
  startup (and optionally a lightweight `--once`-style rescan before a query) by reusing the agent's
  scan path, OR document that it reads whatever the agent/service last wrote. Simplest v1: **reuse
  the agent's one-shot scan** (factor `runScan` out of `main.ts` if not already callable) so an
  MCP-only user still gets current data; fall back to read-only if the log dir is unreadable.

Trade-off accepted: `mcp` is coupled to `agent`'s internal store API (not a versioned HTTP
contract). That's fine inside one monorepo with one release unit. If a *third party* ever consumes
this, the thing to stabilise and publish is `@portalstone/core` (§7), not the agent store.

The one case for the HTTP shim — a remote/overlay client that can't run Node locally — is handled
instead by the agent optionally hosting MCP-over-HTTP itself (§3), still backed by the same store.

---

## 3. Transport — **stdio for v1; HTTP/SSE as an opt-in later**

- **v1: stdio.** `@modelcontextprotocol/sdk` `StdioServerTransport`. This is what Claude Desktop and
  Claude Code launch directly — one process per session, no port, no auth surface, local-only by
  construction, which matches PortalStone's "nothing leaves the machine" posture.

  User wiring (Claude Desktop `claude_desktop_config.json`, or Claude Code `.mcp.json`):

  ```json
  {
    "mcpServers": {
      "portalstone": {
        "command": "node",
        "args": ["C:/Users/.../portalstone/dist/mcp.mjs"],
        "env": { "PORTALSTONE_WOW_DIR": "..." }
      }
    }
  }
  ```

  Dev form points `command` at `tsx` + `packages/mcp/src/main.ts`; release form at a bundled
  `dist/mcp.mjs` (add an esbuild target alongside the existing `scripts/build-release.mjs`).

- **Later: `StreamableHTTPServerTransport`**, hosted by the agent on an opt-in flag/port, same
  `127.0.0.1` binding as the web UI. This is the path for the planned overlay / mobile / WASM client
  that wants MCP without spawning a local Node process. Defer until the overlay exists; note it so
  the tool layer is written transport-agnostic (tools take args + `Store`, return JSON — the
  transport is glue).

Respect repo conventions: ESM (`"type": "module"`), `node:sqlite` via the store, minimal deps.

---

## 4. Tool surface (read-only, v1)

All tools return JSON already shaped by the store's typed rows. `character` is the optional scope
filter the store already supports (`guid` or name; `null` = all). Names are `portalstone_*` to
namespace them in a multi-server host.

| tool | params | returns | backed by |
|---|---|---|---|
| `portalstone_overview` | `{ character? }` | totals + last 50 sessions + character list + last-scan time | `store.totals`, `store.listSessions`, `store.characters` (mirrors `/api/summary`) |
| `portalstone_list_characters` | `{}` | every character with sessions, play time, damage/healing/kills/deaths | `store.characters()` |
| `portalstone_list_sessions` | `{ character?, limit? }` | session rows (times, zones, duration, engaged, dmg/heal/kills/deaths) | `store.listSessions` |
| `portalstone_session_detail` | `{ id }` | one session: runs/segments, top abilities (damage/healing/taken), encounters | `store.session`, `store.segments`, `store.abilities`, `store.encounters` (mirrors `/api/session`) |
| `portalstone_run_detail` | `{ id }` | one zone visit: abilities + this zone's run history | `store.segment`, `store.segmentAbilities`, `store.runsForZone` |
| `portalstone_recent_runs` | `{ character?, limit? }` | newest zone visits across sessions | `store.recentRuns` |
| `portalstone_zone_aggregates` | `{ character? }` | per-zone rollups (time, kills, throughput) | `store.zoneAggregates` |
| `portalstone_pvp_summary` | `{ character? }` | kills/deaths/opponents + top opponents | `store.pvpSummary`, `store.pvpOpponents` |
| `portalstone_tracked_metrics` | `{}` | every tracked series (id, label, unit, path, entity, kind) | `store.trackedMetrics` |
| `portalstone_metric_samples` | `{ id, sinceMs? }` | time series points for one tracked metric | `store.samples` |
| `portalstone_gold_by_session` | `{ character? }` | **the headline tool**: per-session gold bracket (before/after/change, plus `shared across N` / `unknown` states) | tracked `*.money` series bracketed against sessions — the logic in `docs/SAVEDVARS.md §Session attribution`; factor it out of the dashboard/tracked page into a store or sensor helper the tool calls |
| `portalstone_sensor` | `{ character? }` | recorded spec/build, talent tabs, gear (slot→item id, ilvl), professions, lockouts, played time, XP, group, spec history | `readSensor(installs)` → filter `SensorRead.chars` |
| `portalstone_list_addons` | `{}` | installed SavedVariables files: provider id, state, globals, trackable-count | `listAddons` + `readAddon` (mirrors `/api/addons`) |
| `portalstone_addon_detail` | `{ file }` | one addon's shape: every path, type, instances, min/max, samples, score, constants | `readAddon` (mirrors `/api/addon`; this is the property browser / shape introspection) |
| `portalstone_capabilities` | `{}` | the provider→capability registry and which files on this install satisfy each | `PROVIDERS` + `providerFor` cross-referenced with `listAddons` |

Notes:

- **Every tool states provenance in its description** — e.g. `portalstone_sensor` is the *recorded*
  answer; a spec chip on a session is an *inference* from the log (`docs/SENSOR.md`). The
  description is where the model learns not to conflate them.
- **Absent ≠ zero.** Tools pass through the store/sensor `null`/"not recorded" semantics verbatim;
  do not coerce missing fields to 0 (the whole project is strict about this —
  `docs/SAVEDVARS.md`, `SENSOR.md`).
- Return large collections already collapsed the way the shape introspection does (a 4,000-quest
  table is one `[*]` path, not 4,000 rows) — `portalstone_addon_detail` inherits this from
  `readAddon`.

### Write tools — explicitly deferred

Candidates for a later version, all currently POST routes in the web UI: `addTrackedMetric` /
`removeTrackedMetric`, dashboard create/rename/delete/card edits, `saveItemNames`. **Out of scope
for v1** — v1 is read-only so an MCP client cannot mutate `coach.sqlite` or the user's tracked set.
When added, gate behind a tool annotation (`readOnlyHint: false`) and keep them separate from the
read tools.

---

## 5. Resource surface

Tools over resources for almost everything, because this data is **parameterised and queried**, not
a fixed set of documents, and MCP resources are best for stable, enumerable, URI-addressable blobs.

Worth exposing as **resources** (read-only, cacheable, nice for a client to list/attach):

- `portalstone://capabilities` — the capability registry + install status (static-ish reference).
- `portalstone://addons/{file}` — each SavedVariables file's shape report, addressable by name.
- Optionally `portalstone://docs/savedvars`, `.../sensor` — serve the existing `docs/*.md` so a
  model can cite the project's own semantics (gold brackets, absent-vs-zero) when explaining a
  number. Cheap, high value for grounding.

Everything time-ranged or id-scoped (sessions, runs, samples, gold-by-session) stays a **tool** —
it takes arguments.

---

## 6. Framing constraint — MCP does not widen the WoW API

State this prominently in the server's top-level description and the README:

> MCP exposes the data PortalStone already derives from **combat logs + addon SavedVariables on
> this machine**. It does not call the WoW client, does not bypass the addon sandbox, and cannot
> read anything the sensor addon or a third-party addon did not already write. It reads the same
> files the web UI reads.

Reachable: everything in `SPEC-providers-and-capabilities.md` the install actually has a provider
for — combat-log throughput/sessions/runs/pvp, and whatever SavedVariables exist (money/inventory
from BagBrother et al., spec/gear/played/lockouts from the sensor). **Not reachable:** anything no
addon records (the combat log has no money/XP/level event — `docs/SAVEDVARS.md`), item **names**
without an external source configured (ids only — `docs/SAVEDVARS.md §Item names`), and anything
behind a provider the user hasn't installed. `portalstone_capabilities` makes this legible: it
reports which capabilities have a live provider on *this* install vs. which are unmet.

---

## 7. Reusability path (future, not v1)

The genuinely reusable asset for other addon authors is the **SavedVariables reader + shape
introspection**, already isolated as pure code in `@portalstone/core` (`savedvars/lua.ts`,
`savedvars/shape.ts`) with no fs/http/sqlite deps. MCP adds no reusability by itself — a shared
library does.

To publish (documented future step):

1. Decide the public surface: either publish `@portalstone/core` as-is, or carve a slim
   `wow-savedvars` package (just `lua.ts` + `shape.ts` + their types) so consumers don't pull the
   combat-log parser. The combat-log reader could ship as a second package (`wow-combatlog`).
2. Give it a real version (currently `0.0.0`, `private: true`), a build (it's `main: src/index.ts`
   today — needs a compiled `dist` + `types` for npm consumers), a LICENSE, and a README with the
   "reads as data, never executes" guarantee front and centre.
3. Then the MCP server becomes a thin, open-sourceable layer: "point it at any addon's
   SavedVariables, get an MCP tool surface." The generic version of `portalstone_addon_detail`
   (shape of any file) is the reusable core tool; the session/gold tools are PortalStone-specific
   and stay here.

Not v1 scope: v1 keeps `core` private and in-repo.

---

## 8. Testing (no running game)

The repo already tests every data path against fixtures with **vitest** (`packages/agent/test/*` —
`sensor.test.ts` reads a fixture shaped exactly like the addon's output; `addons.test.ts`,
`accounts.test.ts`, etc.). The MCP layer is thin, so:

- **Tool-handler unit tests** (`packages/mcp/test/*.test.ts`): build a `Store` over a temp SQLite
  seeded from the existing fixtures (reuse the agent test helpers), call each tool handler
  **directly** (not over a transport), assert the JSON shape and the absent-vs-zero behaviour. No
  MCP client needed — handlers are plain functions of `(args, { store, installs })`.
- **One transport smoke test**: spin the server on an in-memory/stdio pair using the SDK's
  `InMemoryTransport`, call `tools/list` and one `tools/call`, assert a well-formed MCP response.
- **Schema gate**: assert each tool's input schema (zod) matches its handler's params, so a param
  rename can't silently break the contract.
- Keep the game out entirely: no tool test may require `discover()` to find a real install — inject
  a fixture `InstallInfo[]` and a seeded store.

Add `packages/mcp` to the root `test` and `typecheck` scripts.

---

## 9. Dependencies

- **`@modelcontextprotocol/sdk`** — official TypeScript SDK. **Current latest: `1.32.2`** (verified
  via `npm view`). ESM, ships its own types. Use `McpServer` (high-level) with `registerTool` +
  zod input schemas, and `StdioServerTransport`. Pin a caret range (`^1.32.2`).
- **`zod`** — the SDK uses it for tool input schemas; it'll come in transitively but declare it
  explicitly as a direct dep since tool definitions import it.
- Nothing else. No HTTP framework (stdio in v1; the SDK's `StreamableHTTPServerTransport` covers
  HTTP later with no extra dep). Reuse `node:sqlite` via the agent store — do **not** add a second
  SQLite driver. Keep the dependency count in the spirit of the root `package.json` (esbuild,
  luaparse, tsx, typescript, vitest, wasmoon — all dev).

---

## 10. Phased build order

1. **Skeleton + stdio + one tool.** `packages/mcp` wired into the workspace; `McpServer` over
   `StdioServerTransport`; implement `portalstone_overview` against a `Store` opened on the same
   `dbPath` discovery the agent uses. Prove it loads in Claude Code via `.mcp.json`.
2. **Read tools over the combat-log store.** `list_sessions`, `session_detail`, `run_detail`,
   `recent_runs`, `zone_aggregates`, `pvp_summary`, `list_characters`. Pure store passthroughs.
3. **Sensor + addon tools.** `portalstone_sensor`, `list_addons`, `addon_detail`, `capabilities`,
   `tracked_metrics`, `metric_samples`. Introduces `readSensor` + `listAddons`.
4. **`gold_by_session`.** Factor the session-attribution bracket logic (currently in the
   tracked/dashboard page) into a reusable helper; this is the highest-value answer and the reason
   much of the project exists.
5. **Freshness + packaging.** Reuse the agent's one-shot scan on startup; add an esbuild target for
   `dist/mcp.mjs`; document Claude Desktop/Code config. Resources (`capabilities`, `addons/{file}`,
   docs) land here.
6. **Deferred, separate milestones:** write tools (gated), HTTP/SSE transport for the overlay,
   `@portalstone/core` npm extraction.

Ship 1–4 as the usable v1; 5 makes it a clean install; 6 is future.

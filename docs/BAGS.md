# Bags

Tracked: **bag drops**. Nothing about who shared a bag, because the log does not record it.

## What is recorded

`SPELL_CAST_SUCCESS` with spell **429961 `Unroll Bag`** — one event per bag put on the ground, with
the caster's name, the timestamp, and (from the stat block every cast line carries) the position
`x, y, mapId`. The zone is whatever `ZONE_CHANGE` last reported at that moment.

That is the whole feature: who dropped a bag, where, and when. `npm run rebuild`, then `/bags`.

## What is not recorded, and why

| Tempting signal | Why it cannot be used |
| --- | --- |
| `Well-Rested` (429959), `Camp Benefits` (1229741), `Boosted Rest` (1229451) | all applied source == destination — the client grants each player the buff individually and never names the bag that caused it |
| `SPELL_AURA_APPLIED_DOSE` on `Well-Rested` | doses 2 and 3 were observed, and they track time rested per player, not the number of people in the bag |
| Proximity from damage/cast positions | auras carry no coordinates, and a player lying still emits nothing, so "who was nearby" is unknown for exactly the people who are resting |
| Bags already on the ground | they keep buffing passersby with no `Unroll Bag` event at all — 10 of the player's 12 camp buffs came from bags someone else had dropped earlier |
| Timing | the buff lands ~60s after the bag goes down, so unroll and buff cannot be paired by simultaneity |

An earlier build tried to reconstruct attendance from position samples and two grades of evidence.
It was removed: in a capital city one camp "attended" 71 players with no position on record, which
is foot traffic, not bag-mates. Guessing at that is worse than saying nothing.

## Where it lives

- `packages/core/src/bags.ts` — `BagCollector`: drops only, stamped with the zone in effect.
- `packages/core/src/combatlog/decode.ts` — `BAG_SPELL`, and the position block reader.
- `packages/agent/src/store.ts` — `bag_drop` table, rebuilt per log file.
- `packages/agent/src/server.ts` — `/bags`: who drops, where, and every drop with position.

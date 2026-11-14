# Camps

A sleeping bag is not a thing the combat log reports. A **camp** is.

## What the game actually writes

| Event | Spell | What it proves |
| --- | --- | --- |
| `SPELL_CAST_SUCCESS` | 429961 `Unroll Bag` | who put a bag down, when, and where (the stat block carries x/y/mapId) |
| `SPELL_AURA_APPLIED` | 429959 `Well-Rested` | this player is resting at a camp |
| `SPELL_AURA_APPLIED` | 1229741 `Camp Benefits` | this player is inside a camp's radius |
| `SPELL_AURA_APPLIED` | 1229451 `Boosted Rest` | the camp has already been used by this player |
| `SPELL_AURA_APPLIED_DOSE` | 429959 | `Well-Rested` stacks (doses 2 and 3 observed) while resting |

Every one of the ~10,000 camp-buff applications in a measured 8-hour log has **source == destination**:
the client grants the buff to each player individually and never records whose bag it was. So:

- There is no "you are lying in X's bag" line. There never will be one.
- There is no bag membership list, no owner attribution, no capacity.
- A bag that is already on the ground produces buffs with no `Unroll Bag` event at all — measured
  in practice: 10 of the player's 12 camp buffs came from bags someone else had already dropped.

The buff lands roughly **60 seconds after** the bag goes down, so the unroll and the buff cannot be
matched by simultaneity. And the buffs appear to reach about **10-12 yards** (a measured attendee
was buffed at 10.5y; one at 120y was a different camp entirely).

## What the product therefore models

A camp is `(place, time window, bags[])` with attendance attached. Bags merge into one camp when
they are within 5 minutes of each other, within 40 yards, on the same map, and the camp is younger
than 15 minutes — a camp is a sitting session, not an eternal campfire. Chaining bags indefinitely
was a real bug: it turned one camp into an evening and "attended" a whole city.

Attendance has two grades, and the interface shows them differently:

**measured** — the attendee emitted an event with a position block (a cast or a hit) within 3
minutes of taking the buff, and that position was within 15 yards. The distance is real.

**inferred** — the player took the buff while this was the only camp in play, but never emitted a
positioned event. Auras carry no coordinates and a player lying still emits nothing, so the log
genuinely cannot say where they stood. These are counted ("+N others took the camp buff here with
no position on record"), never listed as if they were in the bag.

## Consequences for the UI and the pitch

- Never call an inferred attendee a participant.
- Distances are evidence, not decoration: show the yardage.
- The honest sentence is "N players were inside the camp radius", not "N players shared your bag".
- The feature is a camp tracker whose anchor event happens to be a bag.

## Where it lives

- `packages/core/src/camps.ts` — `CampCollector`, clustering and attendance grades.
- `packages/core/src/combatlog/decode.ts` — `BAG_SPELL`, `CAMP_SPELLS`, position extraction.
- `packages/agent/src/store.ts` — `camp`, `camp_bag`, `camp_attendee` tables.
- `packages/agent/src/server.ts` — `/camps`.

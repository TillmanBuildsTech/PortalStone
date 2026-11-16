# Dashboards

A dashboard is a named view the user builds for themselves: a grid of cards, where each card picks
a piece of data, how to draw it and how far back to look. Nothing is hard-coded per dashboard — the
same catalog serves every card, so adding a data source once makes it available everywhere.

    /dashboards              list, create, delete
    /dashboard?id=           one dashboard: drag, resize, edit, remove cards
    /dashboard/card?id=      the add-card form, with a live preview
    /dashboard/card/edit?id= the same form for an existing card
    /dashboard/card/preview  the HTML fragment the form's preview fetches
    /dashboard/card/body     the same card at an arbitrary w/h, used after a resize
    /dashboard/layout        POST the grid after a drag or resize (JSON)

## A card is a metric, a view and a window

Metrics come from `packages/agent/src/ui/dashboardData.ts`:

| group | source | what it is |
| --- | --- | --- |
| combat | `session` | one point per session: damage, healing, damage taken, kills, deaths, casts, time played, time in combat |
| places | `zone_segment` | every zone visit added up per zone: damage, healing, time, kills, deaths, visits |
| bags | `bag_drop` | drop counts by zone and by the player who unrolled the bag |
| tracked | `tracked_metric` | any numeric addon property the user tracks, sampled once per SavedVariables flush |

Views are `stat`, `bar`, `pie`, `line` and `table`, rendered as inline SVG by `ui/charts.ts`
(`pieChart` is the one written for this page).

Windows are stored as minutes and offered as presets in the units a player thinks in: all time,
15m, 1h, 6h, 24h, 7d, 30d. A window is relative to **now**, not to the newest point, so "last 24
hours" after a week away is honestly empty rather than quietly showing last week. Each reader
applies it to its own grain: session start time, zone visit start time, SavedVariables flush time,
bag-drop time.

## Shape decides which views are honest

Every metric declares a shape:

- `time` — a value measured at a moment (a session's damage, a gold balance at a flush)
- `split` — a total broken into categories (damage by zone, drops by player)

`line` only fits `time`; `pie` only fits `split`. A line across categories would imply an order the
data does not have, and a pie across timestamps would pretend a series is a whole. `bar`, `stat`
and `table` fit both.

The form states the rule, the POST validates it, and a card stored with a mismatch (an older row, a
hand-edited database) renders the default view with a note under it rather than drawing something
misleading. The live preview shows the coercion immediately instead of after saving.

## The builder: drag, resize, save

Grid geometry is [gridstack](https://gridstackjs.com) 14, vendored from `node_modules` and served
by the agent itself — no bundler, no CDN, no build step:

    /vendor/gridstack/gridstack-all.js     require.resolve('gridstack/dist/gridstack-all.js')
    /vendor/gridstack/gridstack.min.css
    /assets/dashboard.js                   this repo's enhancement script
    /assets/dashboard.css                  grid skin, drag handle, preview layout

The page renders a plain list of grid items and the script upgrades it in place. Cards are placed
on a 12-column grid; drag one by the ⠿ handle, resize it by the bottom-right corner. The grid uses
`float: false`, so cards compact upward and fill the gaps they leave — resize a card narrower and
its neighbour moves up, which is the "auto sizing to how they fit" behaviour a dashboard needs.
The minimum is 2×2 cells, set per item.

On every `change` the script debounces for 500 ms and posts the whole grid:

    POST /dashboard/layout
    { "dashboard": 3, "items": [ { "id": 12, "x": 6, "y": 0, "w": 6, "h": 3 }, … ] }

The server clamps each field (x 0–11, w 1–12, h 1–40, y ≥ 0), verifies each card id belongs to that
dashboard, writes them in one transaction and returns `{ "saved": n }`. The status line above the
grid reads `layout saved`, or `layout not saved` in the error colour. Nothing else about a card
changes when it is moved: geometry is stored separately from its metric, view and window.

Without JavaScript the dashboard still renders every card in document order (gridstack never
upgrades the list), and the add/edit form still previews the values it was rendered with. Drag,
resize, layout persistence and live preview are enhancements, not requirements.

## Editing and preview

`/dashboard/card/edit?id=` is the add form with the card's current values and the same validation;
geometry is untouched by an edit and only changes by dragging. `title` is optional and defaults to
the metric label.

Both forms render a server-side preview on load and re-fetch it as `metric`, `view`, `window` or
`title` changes (`/dashboard/card/preview`, 180 ms debounce). The preview is the exact card renderer
used on the dashboard, minus the edit/remove tools, at the width the card will occupy, so a narrow
pie and a wide line look the way they will look after saving.

## Fitting the card

Nothing scrolls. A card is a flex column: header, then a body that takes the remaining height, and
the chart fills the body. Charts are rendered at the aspect ratio of the cells the card occupies
(~87 px per column, 92 px per row, minus the header), so the SVG scales to fill its card instead
of letterboxing or running over.

The server picks one of four layout buckets from `w/h` (`ui/dashboardData.ts#cardTier`):

| bucket | when | what changes |
| --- | --- | --- |
| xs | ≤3 columns or ≤2 rows | stat value 20px, view pill hidden, tighter padding, pie key below in two columns |
| sm | ≤5 columns | stat 26px, view pill hidden, pie key below |
| md | ≤8 columns or ≤3 rows | stat 32px, pie key beside when the aspect allows |
| lg | wider and taller | stat 40px, the most label room |

Charts also adapt internally:

- axis margins shrink on narrow cards, and bar/line labels thin to the number that fits;
- value labels over bars disappear when the bars are too narrow for them;
- the pie chooses a side or below key by aspect ratio, collapses to 4–7 slices, and scales legend
  text with the card;
- tables spend their height on rows (`(h*92-92)/27`), drop the share column under 5 columns, and
  say "showing N of M rows" instead of overflowing.

After a resize the browser asks for `GET /dashboard/card/body?id=&w=&h=` and swaps the card in
place, so the bucket and every chart are chosen for the new size without a page reload. That
endpoint is also what lets the preview show the exact card you are about to save.

## What a card stores

    dashboard       id, name, created_ms, updated_ms
    dashboard_card  id, dashboard_id, title, metric, view, range_minutes,
                    x, y, w, h, span, position, created_ms

`metric` is a stable id such as `session_damage`, `zone_time` or `tracked:7`. `range_minutes` is 0
for all time. `x/y/w/h` are gridstack geometry; `x/y` stay -1 until something is placed, and
gridstack auto-positions those on load. `span` and `position` are the pre-grid ordering fields,
kept so a database from before the builder migrates cleanly: wide cards become 12×3, half cards
6×3, paired across rows.

A card whose metric no longer exists (the tracked value behind `tracked:7` was removed) is shown as
a card that says so, with its edit and remove buttons — a dangling reference never breaks the page.

## The example dashboard

An install with no dashboards offers **start from the example**: one click creates "Overview" with
a wide damage-per-session line, where the time went as a pie, kills per session as bars, and a
fourth card that is the first tracked numeric value when one exists (last 7 days), or damage by
zone when not. It is a starting point; every card can be edited, moved, resized or removed.

## JSON

The pages are server-rendered, but the numbers are available for a future client:

    GET /api/dashboards          every dashboard with its cards
    GET /api/dashboard?id=7      one dashboard: each card's geometry, window, metric metadata and points

## Limits, stated plainly

- **Windows are preset.** 15m through 30d, all time; there is no free-form "since 14:00" and no
  timezone picker. The window is relative to now, not to the last session.
- **Sessions are filtered by start time.** A session that began before the window and is still open
  is outside it; zone visits are filtered the same way.
- **A card has no scrollbars.** Content that does not fit is elided (table rows, labels) rather
  than scrolled; resize the card taller if you need more rows.
- **The grid is a fixed 12 columns.** On a narrow window cards keep their column widths and become
  small; the page is usable but not redesigned for phones.
- **Dragging needs JavaScript.** Without it the cards are a static list and the layout stays as
  stored.
- **No undo.** A drag saved is a drag saved; deleting a dashboard deletes its cards (the underlying
  sessions, tracked values and bag drops are untouched).

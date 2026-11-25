/**
 * Page shell and the small pieces every page shares.
 *
 * One header, one nav, one set of cards/tables/pills, so a change to the look happens in one place
 * instead of five. Styles are inline in the document: no bundler, no build step, no CDN.
 */
import { ago, dur, esc, num, plural } from './format';
import type { Ctx } from './context';
import { VERSION } from '../../../core/src/version';
import type { UpdateState } from '../update';

export type NavKey =
  | 'sessions'
  | 'dashboards'
  | 'runs'
  | 'pvp'
  | 'people'
  | 'addons'
  | 'sensor'
  | 'tracked'
  | 'diagnostics';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'sessions', href: '/', label: 'sessions' },
  { key: 'dashboards', href: '/dashboards', label: 'dashboards' },
  { key: 'runs', href: '/runs', label: 'runs' },
  { key: 'pvp', href: '/pvp', label: 'pvp' },
  { key: 'people', href: '/people', label: 'people' },
  { key: 'addons', href: '/addons', label: 'addons' },
  { key: 'sensor', href: '/sensor', label: 'sensor' },
  { key: 'tracked', href: '/tracked', label: 'tracked' },
  { key: 'diagnostics', href: '/diagnostics', label: 'diagnostics' },
];

const CSS = `
:root {
  color-scheme: dark;
  /* Stone & gold: a dark Warcraft frame lit by torchlight, data still reads first. */
  --bg: #0a0b0d; --panel: #14130f; --panel-2: #1c190f; --line: #3a3322; --line-soft: #221f16;
  --ink: #e7ddc8; --ink-strong: #fbf3df; --ink-dim: #a79c83; --ink-faint: #766d58;
  --accent: #c8aa6e; --accent-bright: #f0d98a; --accent-dim: #8a7752;
  --good: #5fcf6b; --bad: #ff6b61; --warn: #ffb454; --raid: #c79bff; --mana: #6ea8fe;
  --radius: 9px;
  --font-body: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-display: "Trajan Pro", "Cinzel", Constantia, "Palatino Linotype", "Book Antiqua", Georgia, serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

header { position: sticky; top: 0; z-index: 30; background: rgba(11,15,20,.92);
  border-bottom: 1px solid var(--line); backdrop-filter: blur(6px); }
.bar { max-width: 1180px; margin: 0 auto; padding: 0 18px; height: 52px; min-width: 0;
  display: flex; align-items: center; gap: 14px; }
.brand { color: var(--ink-strong); font-weight: 650; letter-spacing: .01em; font-size: 15px;
  display: flex; align-items: center; gap: 8px; }
.brand:hover { text-decoration: none; }
.brand i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px rgba(110,168,254,.15); display: inline-block; }

/* The menu toggle: a hamburger that opens the slide-out drawer. Pure CSS — a hidden checkbox
 * drives the drawer and the scrim through sibling selectors, so every page gets a working menu
 * with no script, and each full page load starts with the drawer closed. The checkbox keeps real
 * opacity:0 placement (not display:none) so it stays keyboard-focusable and toggles with space. */
.nav-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; margin: 0; }
.hamburger { display: inline-flex; flex-direction: column; justify-content: center; gap: 4px;
  width: 36px; height: 34px; padding: 0 7px; border-radius: 7px; cursor: pointer; flex: 0 0 auto;
  border: 1px solid transparent; }
.hamburger:hover { border-color: var(--line); background: var(--panel-2); }
.hamburger span { display: block; height: 2px; width: 100%; background: var(--ink); border-radius: 2px;
  transition: transform .22s ease, opacity .18s ease; }
.nav-toggle:focus-visible + .hamburger { outline: 2px solid var(--accent); outline-offset: 2px; }
.nav-toggle:checked + .hamburger span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
.nav-toggle:checked + .hamburger span:nth-child(2) { opacity: 0; }
.nav-toggle:checked + .hamburger span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }

/* The slide-out drawer holds every section link, off-canvas to the left until the hamburger opens
 * it. It works the same at every screen size — the nav links live here, never on the top bar. */
nav { position: fixed; top: 0; left: 0; z-index: 40; height: 100vh; height: 100dvh;
  width: min(84vw, 288px); display: flex; flex-direction: column; background: var(--panel);
  border-right: 1px solid var(--line); box-shadow: 6px 0 30px -10px rgba(0,0,0,.7);
  transform: translateX(-100%); transition: transform .24s ease; overflow-y: auto;
  overscroll-behavior: contain; }
.nav-toggle:checked ~ nav { transform: translateX(0); }
.nav-head { display: flex; align-items: center; justify-content: space-between; height: 52px;
  padding: 0 12px 0 20px; border-bottom: 1px solid var(--line-soft); flex: 0 0 auto; }
.nav-title { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--ink-faint); }
.nav-close { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border-radius: 7px; cursor: pointer; color: var(--ink-dim); font-size: 15px; line-height: 1; }
.nav-close:hover { background: var(--panel-2); color: var(--ink); }
nav a { color: var(--ink-dim); display: flex; align-items: center; gap: 10px; padding: 12px 20px;
  font-size: 14px; border-left: 3px solid transparent; }
nav a:hover { color: var(--ink); background: var(--panel-2); text-decoration: none; }
nav a.on { color: var(--ink-strong); border-left-color: var(--accent); background: var(--panel-2); }

/* The scrim dims the page behind an open drawer; clicking it (it is a label for the toggle) closes
 * the menu, as does clicking any link or the ✕. */
.nav-scrim { position: fixed; inset: 0; z-index: 35; background: rgba(0,0,0,.5); opacity: 0;
  pointer-events: none; transition: opacity .24s ease; }
.nav-toggle:checked ~ .nav-scrim { opacity: 1; pointer-events: auto; }

.hdr-right { margin-left: auto; display: flex; align-items: center; gap: 16px; min-width: 0; }
.status { color: var(--ink-faint); font-size: 12px; display: flex;
  align-items: center; gap: 10px; }
.status .live { color: var(--good); }
/* The character switcher: one dropdown in the frame, on every page that sums characters, so the
 * chosen character follows you instead of being re-picked per page. */
.who { display: flex; align-items: center; gap: 7px; min-width: 0; }
.who-label { color: var(--ink-faint); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; white-space: nowrap; }
.who select { background: var(--panel-2); border: 1px solid var(--line); color: var(--ink);
  border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 12.5px; max-width: 220px;
  text-overflow: ellipsis; cursor: pointer; }
.who select:focus { border-color: var(--accent); outline: none; }

main { max-width: 1180px; margin: 0 auto; padding: 26px 22px 72px; }
h1 { font-size: 21px; line-height: 1.3; margin: 0 0 4px; color: var(--ink-strong); font-weight: 650;
  letter-spacing: -.01em; }
h2 { font-size: 12px; margin: 30px 0 10px; color: var(--ink-dim); font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em; display: flex; align-items: baseline; gap: 10px; }
h2 .hint { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--ink-faint);
  font-size: 12px; }
.sub { color: var(--ink-dim); font-size: 12.5px; }
.sub a { color: var(--ink-dim); text-decoration: underline; text-decoration-color: var(--line); }
.sub a:hover { color: var(--accent); }
.metas { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ink-dim); font-size: 12.5px;
  align-items: baseline; }
.metas .sep { color: var(--ink-faint); }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 9px;
  margin: 16px 0 4px; }
.card { background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius);
  padding: 9px 12px 10px; }
.card .k { color: var(--ink-faint); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .v { font-size: 18px; color: var(--ink-strong); font-variant-numeric: tabular-nums;
  line-height: 1.35; }
.card .v small { font-size: 11.5px; color: var(--ink-faint); font-weight: 400; letter-spacing: 0; }
.card.lead { border-color: #24384f; background: linear-gradient(180deg, #131c27, var(--panel)); }
.card.lead .v { color: #cfe3ff; }

.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--line-soft);
  white-space: nowrap; }
th { color: var(--ink-faint); font-weight: 500; font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .06em; background: var(--bg); }
td.l, th.l { text-align: left; }
tbody tr:hover { background: var(--panel); }
tbody tr.live td { color: var(--good); }
tbody tr.total td { border-top: 1px solid var(--line); }
tbody tr.total td, tfoot td { color: var(--ink-strong); }
td.wrap { white-space: normal; }

/* A dense table: many columns, read by scanning numbers.
 *
 * The nowrap rule on every cell sets a table's minimum width to the sum of its longest
 * unbroken strings, which is how a 13-column session list ends up wider than the page and scrolls
 * sideways. Here cells wrap instead, so the table shrinks to the container and a long character
 * name breaks rather than pushing the last column out of view. Numbers stay on one line because
 * they have no spaces in them, and the tight padding buys back the room the meter used to take. */
table.dense th, table.dense td { padding: 6px 7px; white-space: normal; }
table.dense td { overflow-wrap: anywhere; }
table.dense th { letter-spacing: .04em; }
table.dense .meter { width: 46px; margin-top: 3px; }
table.dense td.num, table.dense th.num { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; }

.pill { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--line); color: var(--ink-dim); vertical-align: 1px; background: var(--panel); }
.pill.dungeon { color: var(--accent); border-color: #24384f; }
.pill.raid { color: var(--raid); border-color: #3a2a54; }
.pill.battleground { color: var(--warn); border-color: #4a3524; }
.pill.city { color: var(--ink-dim); }
.pill.spec { color: #a99ade; border-color: #332e46; border-style: dashed; }
.pill.ok { color: var(--good); border-color: #22402b; }
.pill.sel { color: var(--ink-strong); border-color: #2c5480; background: #16202c; }
.chars { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin: 12px 0 0; }
.chars .lbl { color: var(--ink-faint); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; margin-right: 2px; }
.pill.bad { color: var(--bad); border-color: #4a2b2b; }
.pill.warn { color: var(--warn); border-color: #4a3524; }

.meter { display: block; height: 4px; width: 74px; background: #1b232d; border-radius: 3px;
  overflow: hidden; margin-left: auto; }
.meter i { display: block; height: 4px; border-radius: 3px; }
td .meter { margin-top: 4px; }

.chart { margin: 4px 0 2px; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart-scroll { overflow-x: auto; }
.chart-scroll svg { width: 100%; height: auto; display: block; }
.chart-scroll a:hover rect { opacity: 1; }
svg .grid { stroke: #1c2530; stroke-width: 1; }
svg .baseline { stroke: var(--line); stroke-width: 1.5; }
svg .axis-label { fill: var(--ink-faint); font-size: 10px; }
svg .bar-label { fill: var(--ink-dim); font-size: 9.5px; }
svg .row-label { fill: var(--ink-dim); font-size: 11.5px; }
svg a:hover .row-label { fill: var(--accent); }
svg .pie-label { fill: var(--ink-dim); font-size: 10px; }
svg .pie-value { fill: var(--ink-strong); font-size: 10px; font-variant-numeric: tabular-nums; }
svg .pie-total { fill: var(--ink-strong); font-size: 15px; font-weight: 600; }
svg .pie-caption { fill: var(--ink-faint); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }

/* A dashboard is a grid of cards (see /assets/dashboard.css for the gridstack skin). */
.dash-card { background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius);
  padding: 12px 14px 10px; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.dash-hd { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dash-hd .t { color: var(--ink-strong); font-size: 13px; font-weight: 600; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-hd form { display: inline; }
.dash-stat { font-size: 32px; line-height: 1.15; color: var(--ink-strong);
  font-variant-numeric: tabular-nums; margin: 12px 0 4px; }
.dash-note { color: var(--ink-faint); font-size: 11.5px; margin-top: auto; padding-top: 8px; }
.form { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; margin: 14px 0; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > label { color: var(--ink-faint); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; }
.field input[type="text"], .field select { background: var(--panel-2); border: 1px solid var(--line);
  color: var(--ink); border-radius: 6px; padding: 7px 9px; font: inherit; min-width: 180px; }
.field input[type="text"]:focus, .field select:focus { border-color: #2c5480; outline: none; }
button.primary { background: #1b3a5f; border: 1px solid #2c5480; color: #cfe3ff; border-radius: 6px;
  padding: 7px 14px; font: inherit; cursor: pointer; }
button.primary:hover { background: #21476f; }

.dist { position: relative; height: 18px; margin: 6px 0 2px; }
.dist-track { position: absolute; left: 0; right: 0; top: 8px; height: 3px; background: #1b232d;
  border-radius: 2px; }
.dist .dot { position: absolute; top: 3px; width: 6px; height: 6px; margin-left: -3px;
  border-radius: 50%; background: #3d4854; box-shadow: 0 0 0 1px var(--bg); }
.dist .dot.you { top: 1px; width: 10px; height: 10px; margin-left: -5px; background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px rgba(110,168,254,.35); }

.empty { background: var(--panel); border: 1px dashed var(--line); border-radius: var(--radius);
  padding: 16px 16px; color: var(--ink-dim); font-size: 13px; }
.notice { background: var(--panel); border: 1px solid var(--line-soft); border-left: 3px solid var(--accent);
  border-radius: 6px; padding: 11px 14px; margin: 16px 0; color: var(--ink); }
.notice.warn { border-left-color: var(--warn); }

.row { display: flex; gap: 26px; flex-wrap: wrap; }
.col { flex: 1 1 320px; min-width: 0; }
.linkbtn { background: none; border: 1px solid var(--line); color: var(--accent); border-radius: 6px;
  padding: 2px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.linkbtn:hover { border-color: #2b3a4d; background: #16202c; text-decoration: none; }
.up { color: var(--good); }
.down { color: var(--bad); }
select.unit { background: #12181f; border: 1px solid var(--line); color: var(--ink); border-radius: 6px;
  padding: 6px 8px; font: inherit; }
.kv { margin: 6px 0 0; padding: 0; list-style: none; }
.kv li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0;
  border-bottom: 1px solid var(--line-soft); font-size: 13px; }
.kv li b { font-weight: 500; color: var(--ink-strong); font-variant-numeric: tabular-nums; }
ul.plain { margin: 4px 0 0; padding-left: 18px; color: var(--ink-dim); font-size: 13px; }

.crumbs { display: flex; gap: 8px; align-items: center; color: var(--ink-faint); font-size: 12px;
  margin-bottom: 8px; }
.crumbs a { color: var(--ink-dim); }
.pager { display: flex; justify-content: space-between; gap: 14px; margin-top: 26px;
  border-top: 1px solid var(--line-soft); padding-top: 12px; font-size: 13px; }
.pager .next { margin-left: auto; text-align: right; }

footer { max-width: 1180px; margin: 0 auto; padding: 0 22px 30px; color: var(--ink-faint);
  font-size: 11.5px; }

/* The update banner: a slim bronze strip under the header when a newer build exists, or a live
 * progress line while one is being applied. */
.update-bar { background: linear-gradient(180deg, rgba(200,170,110,.12), rgba(200,170,110,.04));
  border-bottom: 1px solid var(--accent-dim); }
.update-bar .inner { max-width: 1180px; margin: 0 auto; padding: 9px 22px; display: flex;
  align-items: center; gap: 12px 16px; flex-wrap: wrap; font-size: 13px; color: var(--ink); }
.update-bar .msg { color: var(--ink-strong); }
.update-bar .msg b { color: var(--accent-bright); font-weight: 600; }
.update-bar .ver { color: var(--ink-dim); }
.update-bar .actions { margin-left: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.update-bar form { display: inline; }
.update-bar .spin { display: inline-block; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--accent-dim); border-top-color: var(--accent-bright);
  animation: spin 0.8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 700px) { .update-bar .inner { padding: 9px 14px; } }

@media (max-width: 700px) {
  .bar { gap: 10px; padding: 0 12px; }
  .status { display: none; }
  .who-label { display: none; }
  .who select { max-width: 150px; }
  main { padding: 18px 14px 60px; }
  .card .v { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

/* ========================================================================
 * Warcraft skin — stone, bronze and torch-gold, authored in CSS (no network,
 * no imported art). Layered over the base rules above so structure is untouched
 * and only the surface changes.
 * ===================================================================== */
html, body { min-height: 100%; }
body {
  font-family: var(--font-body);
  background-color: var(--bg);
  background-image:
    radial-gradient(1150px 540px at 50% -9%, rgba(200,170,110,.08), transparent 66%),
    radial-gradient(920px 620px at 100% -4%, rgba(123,92,186,.06), transparent 60%),
    radial-gradient(1200px 900px at 50% 120%, rgba(0,0,0,.55), transparent 70%),
    repeating-linear-gradient(135deg, rgba(200,170,110,.014) 0 1px, transparent 1px 7px);
  background-attachment: fixed;
}
/* Your own art (optional): drop background.jpg (or .png/.webp) into the art/ folder beside the
 * database and the whole app sits on it, WoW-login style. Absent, this paints nothing and the
 * authored backdrop below shows through — nothing is fetched from the network either way. */
body::before { content: ""; position: fixed; inset: 0; z-index: -2; pointer-events: none;
  background:
    linear-gradient(180deg, rgba(9,10,12,.66), rgba(9,10,12,.80) 55%, rgba(9,10,12,.88)),
    url("/art/background") center / cover no-repeat fixed; }
/* A faint portal sigil, drawn here (no imported art), so the empty corners still read as Warcraft. */
body::after { content: ""; position: fixed; right: -70px; bottom: -90px; width: 560px; height: 560px;
  z-index: -1; pointer-events: none; opacity: .9;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='560' height='560' viewBox='0 0 100 100'%3E%3Cg fill='none' stroke='%23c8aa6e' stroke-opacity='.05'%3E%3Cellipse cx='50' cy='50' rx='26' ry='40' stroke-width='1.1'/%3E%3Cellipse cx='50' cy='50' rx='40' ry='26' stroke-width='.9'/%3E%3Cellipse cx='50' cy='50' rx='13' ry='28' stroke-width='.7'/%3E%3Ccircle cx='50' cy='50' r='2' fill='%23c8aa6e' fill-opacity='.06' stroke='none'/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat; }

::-webkit-scrollbar { width: 11px; height: 11px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3a3322; border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: #534724; background-clip: padding-box; }

/* Header: a gold-trimmed frame edge. */
header { background: linear-gradient(180deg, rgba(16,14,10,.94), rgba(10,9,7,.9));
  border-bottom: 1px solid var(--accent-dim);
  box-shadow: 0 1px 0 rgba(200,170,110,.14), 0 6px 20px -6px rgba(0,0,0,.7); }
.brand { font-family: var(--font-display); font-size: 16px; letter-spacing: .05em; font-weight: 600;
  background: linear-gradient(180deg, #f6e7b4, #c8a85f 70%, #a9823f);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
.brand svg { width: 21px; height: 21px; display: block; flex: 0 0 auto;
  filter: drop-shadow(0 0 5px rgba(200,170,110,.5)); }
nav { background: linear-gradient(180deg, rgba(16,14,10,.98), rgba(10,9,7,.98));
  border-right-color: var(--accent-dim); }
.nav-head { border-bottom-color: var(--accent-dim); }
nav a.on { color: var(--accent-bright); border-left-color: var(--accent);
  background: rgba(200,170,110,.08); text-shadow: 0 0 12px rgba(200,170,110,.45); }
.status .live { color: var(--good); text-shadow: 0 0 10px rgba(95,207,107,.35); }

/* Engraved titles. */
h1 { font-family: var(--font-display); font-size: 24px; font-weight: 600; letter-spacing: .004em;
  color: var(--ink-strong); text-shadow: 0 1px 2px rgba(0,0,0,.55); }
h2 { color: #bba169; }
h2::before { content: "◆"; color: var(--accent); font-size: 7px; opacity: .85;
  position: relative; top: -1px; text-shadow: 0 0 6px rgba(200,170,110,.5); }
h2 .hint { color: var(--ink-faint); }

/* Cards as inlaid stone tiles, the lead one gilded. */
.card { background-color: var(--panel);
  background-image: linear-gradient(180deg, rgba(255,240,205,.03), transparent 44%);
  border: 1px solid var(--line-soft); box-shadow: inset 0 1px 0 rgba(255,240,205,.045); }
.card .k { color: var(--ink-faint); }
.card.lead { border-color: var(--accent-dim);
  background-image: linear-gradient(180deg, rgba(200,170,110,.13), rgba(200,170,110,.02) 60%);
  box-shadow: inset 0 1px 0 rgba(240,217,138,.2), 0 0 0 1px rgba(200,170,110,.1),
    0 12px 32px -16px rgba(200,170,110,.35); }
.card.lead .k { color: #cbb588; }
.card.lead .v { color: var(--accent-bright); }
.card.lead .v small { color: #b79f6f; }

/* Pills: bronze outlines; the chosen character struck in solid gold. */
.pill { background: var(--panel-2); border-color: var(--line); color: var(--ink-dim); }
.pill.sel { color: #1b1408; border-color: var(--accent-dim); font-weight: 600;
  background: linear-gradient(180deg, var(--accent-bright), var(--accent));
  box-shadow: 0 0 10px -2px rgba(200,170,110,.5); }
.pill.dungeon { color: var(--mana); border-color: #2a3b55; }
.pill.raid { color: var(--raid); border-color: #3a2a54; }
.pill.battleground { color: var(--warn); border-color: #4a3a24; }
.pill.spec { color: #d6bd82; border-color: #4c4126; }
.pill.ok { color: var(--good); border-color: #2a4a2b; }

/* Controls carved from the same stone, lettered in gold. */
button.primary, .linkbtn { color: var(--accent-bright);
  background: linear-gradient(180deg, #2b2416, #1b1710); border: 1px solid var(--accent-dim); }
button.primary:hover, .linkbtn:hover { border-color: var(--accent);
  background: linear-gradient(180deg, #38301c, #241f13); text-decoration: none;
  box-shadow: 0 0 12px -3px rgba(200,170,110,.45); }
.field input[type="text"], .field select, select.unit { background: var(--panel-2); border-color: var(--line); }
.field input[type="text"]:focus, .field select:focus { border-color: var(--accent); }

/* Distribution dots: your mark glows like an enchant. */
.dist-track { background: #241f15; }
.dist .dot { background: #4a4536; box-shadow: 0 0 0 1px var(--bg); }
.dist .dot.you { background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg), 0 0 9px 2px rgba(200,170,110,.5); }
.meter { background: #241f15; }

/* Tables: a faint warm wash on hover; totals ruled in bronze. */
tbody tr:hover { background: rgba(200,170,110,.05); }
th { background: var(--bg); color: var(--ink-faint); }
.empty { border-color: var(--line); }
.notice { border-left-color: var(--accent); }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** The portal mark as a self-contained favicon (served inline, so no network and no 404). */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E" +
  "%3Cellipse cx='12' cy='12' rx='6.4' ry='9' stroke='%23e0b968' stroke-width='1.8'/%3E" +
  "%3Cellipse cx='12' cy='12' rx='3' ry='6.3' stroke='%23e0b968' stroke-width='1.3'/%3E" +
  "%3Ccircle cx='12' cy='12' r='1.7' fill='%23f0d98a'/%3E%3C/svg%3E";

/** A portal seen edge-on — the app's namesake, drawn in gold. Original mark, no imported art. */
const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs>
<linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6e7b4"/>
<stop offset="1" stop-color="#b98f46"/></linearGradient></defs>
<ellipse cx="12" cy="12" rx="6.4" ry="9" stroke="url(#pg)" stroke-width="1.6"/>
<ellipse cx="12" cy="12" rx="9" ry="6.4" stroke="url(#pg)" stroke-width="1.1" opacity=".55"/>
<ellipse cx="12" cy="12" rx="3" ry="6.3" stroke="url(#pg)" stroke-width="1.15" opacity=".82"/>
<circle cx="12" cy="12" r="1.6" fill="url(#pg)"/></svg>`;

export interface PageOptions {
  active?: NavKey;
  /** seconds between automatic reloads; only for pages that follow a live scan */
  refresh?: number;
  ctx?: Ctx;
  /** stylesheets served by this app (e.g. /assets/dashboard.css) */
  styles?: string[];
  /** deferred scripts served by this app (e.g. /assets/dashboard.js) */
  scripts?: string[];
  /**
   * This page adds characters up, so its nav links carry `?char=` and the switcher is offered.
   * A page about one session or one run sets nothing: it is already about one character, and a
   * scoped link to it would be a second, conflicting answer.
   */
  scope?: boolean;
}

/** Append the character scope to a link, so clicking through keeps the character you chose. */
export function withCharacter(href: string, character: string | null | undefined): string {
  if (!character) return href;
  return `${href}${href.includes('?') ? '&' : '?'}char=${encodeURIComponent(character)}`;
}

export function page(title: string, body: string, opts: PageOptions = {}): string {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  const styles = (opts.styles ?? []).map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join('');
  const scripts = (opts.scripts ?? []).map((src) => `<script src="${esc(src)}" defer></script>`).join('');
  const char = opts.scope ? (opts.ctx?.character ?? null) : null;
  const nav = NAV.map(
    (n) =>
      `<a href="${esc(withCharacter(n.href, char))}"${
        n.key === opts.active ? ' class="on" aria-current="page"' : ''
      }>${n.label}</a>`,
  ).join('');
  const last = opts.ctx?.lastScan;
  const status = last
    ? `<span class="${last.errors ? '' : 'live'}">${last.errors ? `${last.errors} log error(s)` : 'scanning ok'}</span>
       <span>${last.at ? `scanned ${ago(last.at)}` : 'no scan yet'}</span>`
    : '';
  // The switcher only belongs on pages that add characters up; a page about one session or run is
  // already about one character. Its base is this exact page (char stripped) so the choice sticks.
  const base = opts.ctx?.path ?? NAV.find((n) => n.key === opts.active)?.href ?? '/';
  const switcher = opts.scope && opts.ctx ? scopeSwitcher(opts.ctx, base) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<link rel="icon" href="${FAVICON}">
<title>${esc(title)} · PortalStone</title><style>${CSS}</style>${styles}${scripts}</head>
<body><header><div class="bar">
<input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Toggle navigation menu">
<label for="nav-toggle" class="hamburger" aria-hidden="true"><span></span><span></span><span></span></label>
<a class="brand" href="/">${BRAND_MARK}PortalStone</a>
<div class="hdr-right">${switcher}<div class="status">${status}</div></div>
<label for="nav-toggle" class="nav-scrim" aria-hidden="true"></label>
<nav aria-label="Primary"><div class="nav-head"><span class="nav-title">Menu</span>
<label for="nav-toggle" class="nav-close" aria-label="Close menu">&#10005;</label></div>${nav}</nav>
</div></header>${opts.ctx?.update ? updateBanner(opts.ctx.update) : ''}
<main>${body}</main>
<footer>PortalStone v${esc(VERSION)} · read from your own combat logs · nothing leaves this machine</footer></body></html>`;
}

/**
 * The strip under the header. Three states:
 *   - applying: a live progress line that polls /api/update and reloads when the new build answers
 *     (the poll survives the service restarting under it — a failed fetch just keeps waiting);
 *   - available + installed service: the offer, with "View changes" and "Update & restart";
 *   - available but a dev run: the offer with a link only, since self-update needs the service.
 * Nothing shows when there is no newer build.
 */
export function updateBanner(u: UpdateState): string {
  const phase = u.apply.phase;
  if (phase !== 'idle') {
    if (phase === 'error') {
      return `<div class="update-bar"><div class="inner">
        <span class="msg"><b>Update failed.</b></span>
        <span class="ver">${esc(u.apply.message ?? 'see the service log')}</span>
        <span class="actions"><a href="/diagnostics">diagnostics</a></span>
      </div></div>`;
    }
    const label =
      phase === 'restarting'
        ? 'Restarting into the new build'
        : `Updating${u.latest ? ` to v${esc(u.latest.version)}` : ''}`;
    return `<div class="update-bar"><div class="inner">
      <span class="msg"><span class="spin"></span> ${label}…</span>
      <span class="ver">${esc(u.apply.message ?? '')}</span>
    </div></div>
    <script>(function(){var cur=${JSON.stringify(u.current)};setInterval(function(){
      fetch('/api/update',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
        if(s.current!==cur||s.apply.phase==='idle'||s.apply.phase==='error'){location.reload();}
      }).catch(function(){});
    },3000);})();</script>`;
  }

  if (!u.latest) return '';
  const l = u.latest;
  const beta = l.prerelease ? ' <span class="pill spec">beta</span>' : '';
  const action = u.installed
    ? `<form method="post" action="/api/update/apply"><button type="submit" class="linkbtn">Update &amp; restart</button></form>`
    : `<span class="ver">run the installer to update</span>`;
  return `<div class="update-bar"><div class="inner">
    <span class="msg"><b>PortalStone v${esc(l.version)}</b> is available${beta}</span>
    <span class="ver">you're on v${esc(u.current)}</span>
    <span class="actions"><a href="${esc(l.url)}" target="_blank" rel="noopener">View changes</a>${action}</span>
  </div></div>`;
}

/**
 * The character switcher that lives in the header frame: a dropdown of every character, plus "all
 * characters", that reloads the current page scoped to the one chosen. Returned empty (so nothing
 * shows) when there is only one character — a picker with a single option is noise.
 *
 * `base` is the current page with `char` stripped; each option appends the character's identity key
 * to it, so switching keeps you on the same page.
 *
 * Options show the character's name alone for now. The combat log never records a WoW account, so
 * distinguishing alts on two accounts would mean joining to the sensor addon — left out until it is
 * worth it.
 */
export function scopeSwitcher(ctx: Ctx, base: string): string {
  const roster = ctx.store.characters();
  if (roster.length < 2) return '';

  const option = (value: string, label: string, on: boolean): string =>
    `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;

  const options = [
    option(base, 'all characters', ctx.character === null),
    ...roster.map((c) => option(withCharacter(base, c.key), c.name, ctx.character === c.key)),
  ];

  return `<label class="who"><span class="who-label">character</span>
    <select aria-label="filter by character" onchange="if(this.value)location.href=this.value">${options.join(
      '',
    )}</select></label>`;
}

/** "kills 212 · deaths 1 · 3h 12m" — the line under every page title. */
export function metas(parts: (string | null | undefined | false)[]): string {
  const kept = parts.filter((p): p is string => !!p);
  return `<div class="metas">${kept
    .map((p, i) => (i === 0 ? p : `<span class="sep">·</span>${p}`))
    .join('')}</div>`;
}

export interface CardSpec {
  k: string;
  v: string;
  hint?: string;
  lead?: boolean;
}

export function cards(items: CardSpec[]): string {
  return `<div class="cards">${items
    .map(
      (c) => `<div class="card${c.lead ? ' lead' : ''}"><div class="k">${esc(c.k)}</div>
        <div class="v">${c.v}${c.hint ? ` <small>${esc(c.hint)}</small>` : ''}</div></div>`,
    )
    .join('')}</div>`;
}

export function kindPill(kind: string | null | undefined): string {
  if (!kind || kind === 'zone') return '';
  return ` <span class="pill ${esc(kind)}">${esc(kind)}</span>`;
}

/**
 * A specialization chip, dashed and always carrying its evidence.
 *
 * Every one of these is read from what was cast, not from the talent tree the game never writes to
 * the log, so the tooltip states the ability and the count it rests on. No guess, no chip: a run
 * with nothing talent-locked in it gets silence rather than a plausible label.
 */
export function specPill(spec: string | null | undefined, title: string): string {
  if (!spec) return '';
  return ` <span class="pill spec" title="${esc(title)}">${esc(spec.toLowerCase())}</span>`;
}

/** A table whose first column is the row's identity and the rest are numbers. */
export function table(
  head: string[],
  rows: string[],
  opts: { left?: number[]; empty?: string; dense?: boolean } = {},
): string {
  if (rows.length === 0) return `<div class="empty">${esc(opts.empty ?? 'Nothing recorded yet.')}</div>`;
  const left = new Set(opts.left ?? [0]);
  const cls = (i: number): string => (left.has(i) ? ' class="l"' : '');
  return `<div class="scroll"><table${opts.dense ? ' class="dense"' : ''}><thead><tr>${head
    .map((h, i) => `<th${cls(i)}>${h}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** Section heading with an optional trailing explanation. */
export function section(title: string, body: string, hint?: string): string {
  return `<h2>${esc(title)}${hint ? `<span class="hint">${hint}</span>` : ''}</h2>${body}`;
}

export function emptyState(text: string, extra = ''): string {
  return `<div class="empty">${text}${extra ? `<div class="sub" style="margin-top:6px">${extra}</div>` : ''}</div>`;
}

/** "3h 12m · 212 kills · 1 death" from the numbers a session or run carries. */
export function summaryLine(parts: { durationS?: number; kills?: number; deaths?: number }): string {
  return [
    parts.durationS !== undefined ? dur(parts.durationS) : null,
    parts.kills ? plural(parts.kills, 'kill') : null,
    parts.deaths ? plural(parts.deaths, 'death') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function bigNum(v: number): string {
  return num(v);
}

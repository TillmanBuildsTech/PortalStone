/**
 * Page shell and the small pieces every page shares.
 *
 * One header, one nav, one set of cards/tables/pills, so a change to the look happens in one place
 * instead of five. Styles are inline in the document: no bundler, no build step, no CDN.
 */
import { ago, dur, esc, num, plural } from './format';
import type { Ctx } from './context';

export type NavKey =
  | 'sessions'
  | 'dashboards'
  | 'runs'
  | 'pvp'
  | 'bags'
  | 'addons'
  | 'sensor'
  | 'tracked'
  | 'diagnostics';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'sessions', href: '/', label: 'sessions' },
  { key: 'dashboards', href: '/dashboards', label: 'dashboards' },
  { key: 'runs', href: '/runs', label: 'runs' },
  { key: 'pvp', href: '/pvp', label: 'pvp' },
  { key: 'bags', href: '/bags', label: 'bags' },
  { key: 'addons', href: '/addons', label: 'addons' },
  { key: 'sensor', href: '/sensor', label: 'sensor' },
  { key: 'tracked', href: '/tracked', label: 'tracked' },
  { key: 'diagnostics', href: '/diagnostics', label: 'diagnostics' },
];

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0b0f14; --panel: #12181f; --panel-2: #161d26; --line: #222b36; --line-soft: #1a222c;
  --ink: #d5dde6; --ink-strong: #eef4fa; --ink-dim: #8b98a6; --ink-faint: #66717e;
  --accent: #6ea8fe; --good: #56d364; --bad: #ff7b72; --warn: #ffa657; --raid: #bc8cff;
  --radius: 10px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

header { position: sticky; top: 0; z-index: 10; background: rgba(11,15,20,.92);
  border-bottom: 1px solid var(--line); backdrop-filter: blur(6px); }
.bar { max-width: 1180px; margin: 0 auto; padding: 0 22px; height: 52px; min-width: 0;
  display: flex; align-items: center; gap: 26px; }
.brand { color: var(--ink-strong); font-weight: 650; letter-spacing: .01em; font-size: 15px;
  display: flex; align-items: center; gap: 8px; }
.brand:hover { text-decoration: none; }
.brand i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px rgba(110,168,254,.15); display: inline-block; }
nav { display: flex; gap: 2px; align-items: stretch; height: 100%; min-width: 0;
  overflow-x: auto; scrollbar-width: none; }
nav::-webkit-scrollbar { display: none; }
nav a { color: var(--ink-dim); padding: 0 11px; display: flex; align-items: center;
  font-size: 13px; border-bottom: 2px solid transparent; }
nav a:hover { color: var(--ink); text-decoration: none; }
nav a.on { color: var(--ink-strong); border-bottom-color: var(--accent); }
.status { margin-left: auto; color: var(--ink-faint); font-size: 12px; display: flex;
  align-items: center; gap: 10px; }
.status .live { color: var(--good); }

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

@media (max-width: 700px) {
  .bar { gap: 14px; padding: 0 14px; }
  nav { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  nav a { padding: 0 7px; font-size: 12px; flex: 0 0 auto; }
  .status { display: none; }
  main { padding: 18px 14px 60px; }
  .card .v { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${esc(title)} · Portalstone</title><style>${CSS}</style>${styles}${scripts}</head>
<body><header><div class="bar"><a class="brand" href="/"><i></i>Portalstone</a><nav>${nav}</nav>
<div class="status">${status}</div></div></header>
<main>${body}</main>
<footer>Portalstone · read from your own combat logs · nothing leaves this machine</footer></body></html>`;
}

/** "who: all characters · Slouch Mage · Dead-Sadfatkid" — the scope switch for pages that sum. */
export function characterBar(ctx: Ctx, base: string): string {
  const roster = ctx.store.characters();
  // One character is not a choice; showing a picker with a single option is noise.
  if (roster.length < 2) return '';
  const chip = (href: string, label: string, on: boolean, hint: string): string =>
    `<a class="pill${on ? ' sel' : ''}" href="${esc(href)}" title="${esc(hint)}">${esc(label)}</a>`;
  const parts = [
    chip(base, 'all characters', ctx.character === null, `every character, added up — ${roster.length} of them`),
  ];
  for (const c of roster) {
    parts.push(
      chip(
        withCharacter(base, c.name),
        c.name,
        ctx.character === c.name,
        `${c.name} · ${c.sessions} session${c.sessions === 1 ? '' : 's'} · last played ${ago(c.last_ms)}`,
      ),
    );
  }
  return `<div class="chars"><span class="lbl">character</span>${parts.join(' ')}</div>`;
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

/**
 * Page shell and the small pieces every page shares.
 *
 * One header, one nav, one set of cards/tables/pills, so a change to the look happens in one place
 * instead of five. Styles are inline in the document: no bundler, no build step, no CDN.
 */
import { ago, dur, esc, num, plural } from './format';
import type { Ctx } from './context';

export type NavKey = 'sessions' | 'runs' | 'bags' | 'addons' | 'tracked' | 'diagnostics';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'sessions', href: '/', label: 'sessions' },
  { key: 'runs', href: '/runs', label: 'runs' },
  { key: 'bags', href: '/bags', label: 'bags' },
  { key: 'addons', href: '/addons', label: 'addons' },
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
.bar { max-width: 1180px; margin: 0 auto; padding: 0 22px; height: 52px;
  display: flex; align-items: center; gap: 26px; }
.brand { color: var(--ink-strong); font-weight: 650; letter-spacing: .01em; font-size: 15px;
  display: flex; align-items: center; gap: 8px; }
.brand:hover { text-decoration: none; }
.brand i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 3px rgba(110,168,254,.15); display: inline-block; }
nav { display: flex; gap: 2px; align-items: stretch; height: 100%; }
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
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; }

.pill { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--line); color: var(--ink-dim); vertical-align: 1px; background: var(--panel); }
.pill.dungeon { color: var(--accent); border-color: #24384f; }
.pill.raid { color: var(--raid); border-color: #3a2a54; }
.pill.battleground { color: var(--warn); border-color: #4a3524; }
.pill.city { color: var(--ink-dim); }
.pill.ok { color: var(--good); border-color: #22402b; }
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
  nav a { padding: 0 7px; font-size: 12px; }
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
}

export function page(title: string, body: string, opts: PageOptions = {}): string {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  const nav = NAV.map(
    (n) => `<a href="${n.href}"${n.key === opts.active ? ' class="on" aria-current="page"' : ''}>${n.label}</a>`,
  ).join('');
  const last = opts.ctx?.lastScan;
  const status = last
    ? `<span class="${last.errors ? '' : 'live'}">${last.errors ? `${last.errors} log error(s)` : 'scanning ok'}</span>
       <span>${last.at ? `scanned ${ago(last.at)}` : 'no scan yet'}</span>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${esc(title)} · Portalstone</title><style>${CSS}</style></head>
<body><header><div class="bar"><a class="brand" href="/"><i></i>Portalstone</a><nav>${nav}</nav>
<div class="status">${status}</div></div></header>
<main>${body}</main>
<footer>Portalstone · read from your own combat logs · nothing leaves this machine</footer></body></html>`;
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

/** A table whose first column is the row's identity and the rest are numbers. */
export function table(head: string[], rows: string[], opts: { left?: number[]; empty?: string } = {}): string {
  if (rows.length === 0) return `<div class="empty">${esc(opts.empty ?? 'Nothing recorded yet.')}</div>`;
  const left = new Set(opts.left ?? [0]);
  const cls = (i: number): string => (left.has(i) ? ' class="l"' : '');
  return `<div class="scroll"><table><thead><tr>${head
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

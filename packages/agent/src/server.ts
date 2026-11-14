/**
 * Local HTTP UI. Server-rendered HTML on purpose: no bundler, no framework, no build step, so the
 * first testable version is one command away. The React/Vite surface replaces this later; the API
 * shape (`/api/summary`) is the part that survives.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { InstallInfo } from './discover';
import type { SessionRow, Store } from './store';

const PROVIDERS: Record<string, { id: string; caps: string[] }> = {
  'Attune.lua': { id: 'sv.attune', caps: ['progression.attunement', 'roster.levels'] },
  'RareScanner.lua': { id: 'sv.rarescan', caps: ['rare.spawns'] },
  'Questie.lua': { id: 'sv.questie', caps: ['quest.completion'] },
  'QuestieTrace.lua': { id: 'sv.questietrace', caps: ['world.mapdata'] },
  'BagBrother.lua': { id: 'sv.bagbrother', caps: ['character.money', 'character.inventory'] },
  'Bagnon.lua': { id: 'sv.bagnon', caps: ['character.inventory'] },
  'AtlasLootContinued.lua': { id: 'sv.atlasloot', caps: ['world.loottables'] },
  'Blizzard_AuctionHouseUI.lua': { id: 'blizzard.auctionhouse', caps: ['auction.prices'] },
  'DBM-Core.lua': { id: 'sv.dbm', caps: [] },
  'Plater.lua': { id: 'sv.plater', caps: [] },
};

export interface ServerOptions {
  port: number;
  dbPath: string;
  installs: InstallInfo[];
  lastScan: () => { at: number; entries: number; errors: number };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function num(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

function dur(sec: number | null | undefined): string {
  const s = Math.round(sec ?? 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function when(ms: number | null | undefined, offsetMin = 0): string {
  if (!ms) return '—';
  const d = new Date(ms + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Where the session actually happened: one row per zone visit, in order. */
function runsTable(store: Store, sessionId: number): string {
  const runs = store.segments(sessionId);
  if (runs.length === 0) return '';
  const rows = runs
    .map(
      (r) => `<tr>
        <td>${esc(r.zone_name)}${kindPill(r.kind)}</td>
        <td>${when(r.start_ms)} → ${when(r.end_ms)}</td>
        <td>${dur(r.duration_s)}</td>
        <td>${dur(r.engaged_s)}</td>
        <td>${num(r.damage_done)}</td>
        <td>${num(r.kills)}</td>
        <td>${num(r.my_deaths)}</td>
        <td>${num(r.field_deaths)}</td>
      </tr>`,
    )
    .join('');
  return `<h2>activity</h2><table><thead><tr><th>zone</th><th>when</th><th>length</th>
    <th>in combat</th><th>damage</th><th>kills</th><th>your deaths</th><th>field deaths</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="sub" style="margin-top:6px">one row per zone entry: dungeons, battlegrounds and
    zones are all separated here, and field deaths are everyone's, not just yours.</div>`;
}

function kindPill(kind: string): string {
  if (kind === 'zone') return '';
  return ` <span class="pill">${esc(kind)}</span>`;
}

function renderRuns(store: Store, lastScan: ServerOptions['lastScan']): string {
  const runs = store.recentRuns(80);
  const last = lastScan();
  const rows = runs
    .map(
      (r) => `<tr>
        <td><a href="/session?id=${r.session_id}">${esc(r.zone_name)}</a>${kindPill(r.kind)}</td>
        <td>${when(r.start_ms)}</td>
        <td>${dur(r.duration_s)}</td>
        <td>${dur(r.engaged_s)}</td>
        <td>${num(r.damage_done)}</td>
        <td>${num(r.damage_taken)}</td>
        <td>${num(r.kills)}</td>
        <td>${num(r.my_deaths)}</td>
        <td>${num(r.field_deaths)}</td>
      </tr>`,
    )
    .join('');
  const instances = runs.filter((r) => r.kind !== 'zone' && r.kind !== 'city').length;
  return page(
    'Runs',
    `<h1>Runs</h1>
     <div class="sub">${runs.length} zone visits · ${instances} in instances ·
       last scan ${last.at ? new Date(last.at).toLocaleTimeString() : 'never'} ·
       <a href="/">sessions</a> · <a href="/diagnostics">diagnostics</a></div>
     ${
       runs.length === 0
         ? '<div class="notice">No zone visits recorded yet.</div>'
         : `<table><thead><tr><th>zone</th><th>when</th><th>length</th><th>in combat</th>
            <th>damage</th><th>taken</th><th>kills</th><th>your deaths</th><th>field deaths</th>
            </tr></thead><tbody>${rows}</tbody></table>`
     }`,
    { refresh: 30 },
  );
}

function dayLabel(ms: number, offsetMin = 0): string {
  const d = new Date(ms + offsetMin * 60_000);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]!;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #c9d1d9;
  font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: #6ea8fe; text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 20px; letter-spacing: .02em; margin: 0 0 2px; }
h2 { font-size: 15px; margin: 28px 0 10px; color: #e6edf3; font-weight: 600; }
.sub { color: #8b949e; font-size: 12.5px; }
.row { display: flex; gap: 22px; flex-wrap: wrap; align-items: baseline; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 6px; }
.card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px 12px; }
.card .k { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.card .v { font-size: 19px; font-variant-numeric: tabular-nums; color: #e6edf3; }
table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 7px 8px; border-bottom: 1px solid #21262d; white-space: nowrap; }
th { color: #8b949e; font-weight: 500; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
th:first-child, td:first-child { text-align: left; }
th:nth-child(2), td:nth-child(2) { text-align: left; }
tbody tr:hover { background: #161b22; }
tbody tr.live td { color: #7ee787; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid #30363d; color: #8b949e; }
.pill.ok { color: #7ee787; border-color: #2b4a33; }
.pill.bad { color: #ff7b72; border-color: #4a2b2b; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.muted { color: #8b949e; }
.notice { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #6ea8fe;
  border-radius: 6px; padding: 10px 12px; margin: 16px 0; color: #c9d1d9; }
.bar { height: 3px; background: #21262d; border-radius: 2px; margin-top: 6px; }
.bar > i { display: block; height: 3px; background: #6ea8fe; border-radius: 2px; }
footer { margin-top: 36px; color: #6e7681; font-size: 11.5px; }
`;

function page(title: string, body: string, opts: { refresh?: number } = {}): string {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${esc(title)} · Portalstone</title><style>${CSS}</style></head>
<body><div class="wrap">${body}<footer>Portalstone · local only · nothing leaves this machine</footer></div></body></html>`;
}

function renderIndex(store: Store, lastScan: ServerOptions['lastScan']): string {
  const sessions = store.listSessions(120);
  const totals = store.totals();
  const last = lastScan();
  const now = Date.now();
  // Render instants in the zone the log was recorded in, not the viewer's clock.
  const tz = sessions[0]?.offset_min ?? 0;

  if (sessions.length === 0) {
    return page(
      'No sessions yet',
      `<h1>Portalstone</h1>
       <div class="sub">Watching for combat logs. Nothing ingested yet.</div>
       <div class="notice">No sessions stored. If you have played since installing this, check
         <a href="/diagnostics">diagnostics</a> — the log may not be found, or the file may be
         still empty.</div>`,
      { refresh: 15 },
    );
  }

  const rows = sessions
    .map((s) => {
      const live = now - (s.end_ms ?? 0) < 5 * 60_000;
      return `<tr class="${live ? 'live' : ''}">
        <td><a href="/session?id=${s.id}">${when(s.start_ms, s.offset_min)}</a></td>
        <td>${esc(s.zone_name || '—')}${s.zones_count > 1 ? ` <span class="pill">+${s.zones_count - 1}</span>` : ''}</td>
        <td>${dur(s.duration_s)}</td>
        <td>${num(Math.round(s.damage_done / Math.max(s.engaged_s || s.active_s || s.duration_s, 1)))}</td>
        <td>${num(s.damage_done)}</td>
        <td>${num(s.damage_taken)}</td>
        <td>${num(s.kills)}</td>
        <td>${num(s.my_deaths)}</td>
        <td>${num(s.casts)}</td>
        <td>${s.encounters > 0 ? s.encounters : '—'}</td>
      </tr>`;
    })
    .join('');

  const body = `
    <h1>Portalstone</h1>
    <div class="sub">${sessions.length} session${sessions.length === 1 ? '' : 's'} ·
      last scan ${last.at ? new Date(last.at).toLocaleTimeString() : 'never'}
      ${last.errors ? `· <span class="pill bad">${last.errors} log error</span>` : ''}
      · <a href="/runs">runs</a> · <a href="/diagnostics">diagnostics</a></div>
    <div class="cards">
      <div class="card"><div class="k">damage done</div><div class="v">${num(totals.damage)}</div></div>
      <div class="card"><div class="k">kills</div><div class="v">${num(totals.kills)}</div></div>
      <div class="card"><div class="k">sessions</div><div class="v">${num(totals.sessions)}</div></div>
      <div class="card"><div class="k">first recorded</div><div class="v" style="font-size:15px">${when(totals.firstMs, tz)}</div></div>
    </div>
    <h2>sessions</h2>
    <table><thead><tr>
      <th>when</th><th>zone</th><th>length</th><th>dps</th><th>damage</th>
      <th>taken</th><th>kills</th><th>your deaths</th><th>casts</th><th>fights</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  return page('Sessions', body, { refresh: 20 });
}

function renderSession(store: Store, id: number): string {
  const s = store.session(id);
  if (!s) return page('Not found', `<h1>404</h1><p>No session ${esc(id)}. <a href="/">Back</a></p>`);
  const abilities = store.abilities(id);
  const encounters = store.encounters(id);
  // DPS is measured over time actually spent fighting (gaps of <=5s count), not wall-clock:
  // a leveling session is mostly travel, and dividing by 6h would report a meaningless 10 dps.
  const basis = s.engaged_s > 0 ? s.engaged_s : s.active_s > 0 ? s.active_s : s.duration_s;
  const dps = basis > 0 ? Math.round(s.damage_done / basis) : 0;
  const dtps = basis > 0 ? Math.round(s.damage_taken / basis) : 0;

  const abilityRows = abilities
    .map(
      (a) =>
        `<tr><td>${esc(a.name)}</td><td>${num(a.amount)}</td><td>${num(a.hits)}</td>
         <td>${num(a.hits ? Math.round(a.amount / a.hits) : 0)}</td>
         <td>${((100 * a.amount) / Math.max(s.damage_done, 1)).toFixed(1)}%</td></tr>`,
    )
    .join('');

  const encRows = encounters
    .map(
      (e) =>
        `<tr><td>${esc(e.boss_name)}</td><td>${e.success === 1 ? 'kill' : e.success === 0 ? 'wipe' : 'open'}</td>
         <td>${dur(Number(e.duration_s))}</td><td>${num(Number(e.damage_done))}</td>
         <td>${num(Number(e.dps))}</td><td>${num(Number(e.deaths))}</td></tr>`,
    )
    .join('');

  const body = `
    <h1>${esc(s.zone_name || 'Unknown zone')}</h1>
    <div class="sub">${dayLabel(s.start_ms, s.offset_min)} ${when(s.start_ms, s.offset_min)} →
      ${when(s.end_ms, s.offset_min)} · ${dur(s.duration_s)} ·
      ${esc(s.character_name || '')} · <a href="/">all sessions</a></div>
    <div class="cards">
      <div class="card"><div class="k">dps (in combat)</div><div class="v">${num(dps)}</div></div>
      <div class="card"><div class="k">damage done</div><div class="v">${num(s.damage_done)}</div></div>
      <div class="card"><div class="k">damage taken</div><div class="v">${num(s.damage_taken)}</div></div>
      <div class="card"><div class="k">dtps</div><div class="v">${num(dtps)}</div></div>
      <div class="card"><div class="k">in combat</div><div class="v">${dur(s.engaged_s)}</div></div>
      <div class="card"><div class="k">kills</div><div class="v">${num(s.kills)}</div></div>
      <div class="card"><div class="k">your deaths</div><div class="v">${num(s.my_deaths)}</div></div>
      <div class="card"><div class="k">field deaths (${num(s.players_died)} players)</div><div class="v">${num(s.deaths)}</div></div>
      <div class="card"><div class="k">casts</div><div class="v">${num(s.casts)}</div></div>
      <div class="card"><div class="k">interrupts</div><div class="v">${num(s.interrupts)}</div></div>
    </div>
    ${runsTable(store, id)}
    ${
      encounters.length
        ? `<h2>fights</h2><table><thead><tr><th>boss</th><th>result</th><th>length</th>
             <th>damage</th><th>dps</th><th>deaths</th></tr></thead><tbody>${encRows}</tbody></table>`
        : ''
    }
    <h2>damage by ability</h2>
    ${
      abilities.length
        ? `<table><thead><tr><th>ability</th><th>damage</th><th>hits</th><th>avg</th><th>share</th></tr></thead>
           <tbody>${abilityRows}</tbody></table>`
        : `<div class="sub">No outgoing damage recorded in this session.</div>`
    }`;
  return page(s.zone_name || 'Session', body);
}

function renderDiagnostics(store: Store, installs: InstallInfo[], opts: ServerOptions): string {
  const logs = store.logFiles();
  const last = opts.lastScan();

  const logRows = logs
    .map((l) => {
      let layout = '—';
      if (l.layout) {
        try {
          const p = JSON.parse(String(l.layout)) as { mode: string; infoGuid: boolean; midBlock: number; score: number };
          layout = `${p.mode}${p.infoGuid ? '+info' : ''}${p.mode === 'afterBlock' ? `/${p.midBlock}` : ''} ${(p.score * 100).toFixed(0)}%`;
        } catch {
          layout = 'unparsed';
        }
      }
      const err = l.last_error ? `<span class="pill bad">${esc(l.last_error)}</span>` : `<span class="pill ok">ok</span>`;
      return `<tr><td class="mono">${esc(l.path)}</td><td>${num(Number(l.bytes))}</td>
        <td>${num(Number(l.offset))}</td><td>${esc(layout)}</td>
        <td>${esc(l.build || '—')}</td><td>${num(Number(l.unknown_lines))}</td><td>${err}</td></tr>`;
    })
    .join('');

  const installsHtml = installs
    .map((i) => {
      const flavors = i.flavors
        .map((f) => {
          const sv = f.accounts
            .map(
              (a) =>
                `<div class="sub" style="margin:6px 0 2px">account <b>${esc(a.name)}</b></div>
                 <table><thead><tr><th>SavedVariables</th><th>provider</th><th>capabilities</th><th>size</th><th>state</th></tr></thead>
                 <tbody>${a.savedVariables
                   .map((v) => {
                     const p = PROVIDERS[v.name];
                     return `<tr><td class="mono">${esc(v.name)}</td><td class="mono">${esc(p?.id ?? '—')}</td>
                       <td style="text-align:left">${esc(p?.caps.join(', ') || '—')}</td>
                       <td>${num(v.bytes)}</td>
                       <td>${p ? '<span class="pill">adapter pending</span>' : '<span class="pill">—</span>'}</td></tr>`;
                   })
                   .join('')}</tbody></table>`,
            )
            .join('');
          return `<h2>${esc(f.name)} <span class="muted mono">${esc(f.dir)}</span></h2>${sv}
            <div class="sub" style="margin-top:8px">${f.logs.length} combat log file(s)</div>`;
        })
        .join('');
      return `<h2>${esc(i.root)}</h2>${flavors}`;
    })
    .join('');

  const body = `
    <h1>Diagnostics</h1>
    <div class="sub">last scan ${last.at ? new Date(last.at).toLocaleString() : 'never'} ·
      ${last.entries} log file(s) checked · ${last.errors} error(s) ·
      database <span class="mono">${esc(opts.dbPath)}</span> ·
      node ${esc(process.version)} · <a href="/">sessions</a></div>

    <h2>combat logs</h2>
    ${logs.length ? `<table><thead><tr><th>path</th><th>bytes</th><th>read to</th><th>layout</th>
      <th>build</th><th>unknown</th><th>state</th></tr></thead><tbody>${logRows}</tbody></table>`
      : `<div class="sub">No logs ingested yet.</div>`}

    ${installsHtml || '<div class="notice">No World of Warcraft install found. Set PORTALSTONE_WOW_DIR to the install folder.</div>'}

    <div class="notice">SavedVariables adapters are not wired up yet. This page lists what exists on
      disk so the next adapter can be chosen with evidence rather than assumption.</div>`;
  return page('Diagnostics', body, { refresh: 30 });
}

export function startServer(store: Store, installs: InstallInfo[], opts: ServerOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    let status = 200;
    let body: string;
    let type = 'text/html; charset=utf-8';

    try {
      if (url.pathname === '/api/summary') {
        const totals = store.totals();
        const last = opts.lastScan();
        body = JSON.stringify({ totals, sessions: store.listSessions(50), lastScan: last }, null, 2);
        type = 'application/json; charset=utf-8';
      } else if (url.pathname === '/runs') {
        body = renderRuns(store, opts.lastScan);
      } else if (url.pathname === '/diagnostics') {
        body = renderDiagnostics(store, installs, opts);
      } else if (url.pathname === '/session') {
        const id = Number(url.searchParams.get('id'));
        if (!Number.isInteger(id) || id <= 0) {
          status = 400;
          body = page('Bad request', '<h1>400</h1><p>session id required.</p>');
        } else {
          body = renderSession(store, id);
        }
      } else if (url.pathname === '/') {
        body = renderIndex(store, opts.lastScan);
      } else {
        status = 404;
        body = page('Not found', '<h1>404</h1><p><a href="/">Back</a></p>');
      }
    } catch (err) {
      status = 500;
      body = page('Error', `<h1>500</h1><pre class="mono">${esc((err as Error).stack ?? String(err))}</pre>`);
    }
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

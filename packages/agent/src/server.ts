/**
 * Local HTTP UI. Server-rendered HTML on purpose: no bundler, no framework, no build step, so the
 * first testable version is one command away. The JSON endpoints (`/api/*`) are the part that
 * survives a React/Vite surface replacing the pages.
 *
 * This file is only routing. The pages live in `ui/pages`, the shared chrome in `ui/shell`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InstallInfo } from './discover';
import type { Store } from './store';
import { page } from './ui/shell';
import { esc } from './ui/format';
import { resolveScope, type Ctx, type LastScan } from './ui/context';
import { renderHome } from './ui/pages/home';
import { renderSession } from './ui/pages/session';
import { renderRun } from './ui/pages/run';
import { renderRuns } from './ui/pages/runs';
import { renderPvp } from './ui/pages/pvp';
import { renderBags } from './ui/pages/bags';
import { renderDiagnostics } from './ui/pages/diagnostics';
import { renderAddons } from './ui/pages/addons';
import { renderSensor } from './ui/pages/sensor';
import { renderAddon, decodePath } from './ui/pages/addon';
import { renderTracked } from './ui/pages/tracked';
import {
  renderDashboards,
  renderDashboard,
  renderAddCard,
  renderEditCard,
  renderPreview,
  renderCardBody,
  cardValuesFrom,
} from './ui/pages/dashboard';
import { DEFAULT_SIZE, cardData, createExampleDashboard, findMetric, isCardView, viewFits } from './ui/dashboardData';
import { sampleTracked } from './tracking';
import { listAddons, readAddon } from './addons';
import { collectValues, entityOptions, pinEntity } from '../../core/src/savedvars/shape';
import { isTable } from '../../core/src/savedvars/lua';

export interface ServerOptions {
  port: number;
  dbPath: string;
  installs: InstallInfo[];
  lastScan: () => LastScan;
}

/** Form bodies are tiny (a path and a unit); anything bigger is not a form this app sends. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Grid layouts arrive as JSON; one dashboard's worth is a few kilobytes at most. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Static files served by the app: the vendored grid library and the dashboard builder.
 *
 * A release build (`npm run build`) ships them in `assets/` beside the bundle, where there is no
 * node_modules to resolve against; a dev run (tsx, straight from src) has no such folder and reads
 * them from `ui/assets` and node_modules instead. Whichever exists first wins, resolved once here.
 */
function shippedAsset(name: string): string | null {
  const beside = join(HERE, 'assets', name);
  return existsSync(beside) ? beside : null;
}

const ASSETS: Record<string, { file: string; type: string }> = {
  '/vendor/gridstack/gridstack-all.js': {
    file: shippedAsset('gridstack-all.js') ?? require.resolve('gridstack/dist/gridstack-all.js'),
    type: 'text/javascript; charset=utf-8',
  },
  '/vendor/gridstack/gridstack.min.css': {
    file: shippedAsset('gridstack.min.css') ?? require.resolve('gridstack/dist/gridstack.min.css'),
    type: 'text/css; charset=utf-8',
  },
  '/assets/dashboard.js': {
    file: shippedAsset('dashboard.js') ?? fileURLToPath(new URL('./ui/assets/dashboard.js', import.meta.url)),
    type: 'text/javascript; charset=utf-8',
  },
  '/assets/dashboard.css': {
    file: shippedAsset('dashboard.css') ?? fileURLToPath(new URL('./ui/assets/dashboard.css', import.meta.url)),
    type: 'text/css; charset=utf-8',
  },
};

function intParam(url: URL, name: string): number | null {
  const id = Number(url.searchParams.get(name));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A trimmed, length-capped text field from a form. Forms are the only input this app accepts. */
function field(form: URLSearchParams, name: string, max: number): string {
  return (form.get(name) ?? '').trim().slice(0, max);
}

function notFound(msg: string): string {
  return page(
    'Not found',
    `<h1>Not found</h1><div class="sub">${esc(msg)}</div>
     <p><a href="/">Back to sessions</a></p>`,
    { active: 'sessions' },
  );
}

/**
 * Why a request must not be served, or null when it may.
 *
 * Listening on 127.0.0.1 keeps other machines out, not other websites. Any page open in your browser
 * can send requests here, so two checks close what binding alone leaves open:
 *
 *  - Host must name this server. DNS rebinding points an attacker's hostname at 127.0.0.1, after
 *    which their page can read these pages as same-origin; its requests still carry their Host.
 *  - A write must come from these pages. A plain HTML form on any site can POST here (delete a
 *    dashboard, stop tracking), and the browser marks it with that site's Origin, or with
 *    Sec-Fetch-Site when it withholds the Origin. A request with neither is not from a browser
 *    page (curl, the install script), so it passes.
 */
export function refuseRequest(
  req: Pick<IncomingMessage, 'method' | 'headers'>,
  port: number,
): string | null {
  const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = (req.headers.host ?? '').toLowerCase();
  if (!own.has(host)) return `unexpected Host "${host}"`;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    return [...own].some((h) => origin.toLowerCase() === `http://${h}`) ? null : `cross-origin ${method} from ${origin}`;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return `cross-site ${method}`;
  return null;
}

export function startServer(store: Store, installs: InstallInfo[], opts: ServerOptions): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const refused = refuseRequest(req, opts.port);
    if (refused) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`Forbidden: ${refused}\n`);
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    const ctx: Ctx = {
      store,
      installs,
      lastScan: opts.lastScan(),
      dbPath: opts.dbPath,
      ...resolveScope(store, url.searchParams.get('char')),
    };
    const redirect = (location: string): void => {
      res.writeHead(303, { location, 'cache-control': 'no-store' });
      res.end();
    };
    let status = 200;
    let body: string | undefined;
    let type = 'text/html; charset=utf-8';

    try {
      switch (url.pathname) {
        case '/api/summary':
          body = JSON.stringify(
            {
              character: ctx.character,
              totals: store.totals(ctx.character),
              sessions: store.listSessions(50, ctx.character),
              characters: store.characters(),
              lastScan: ctx.lastScan,
            },
            null,
            2,
          );
          type = 'application/json; charset=utf-8';
          break;

        case '/api/session': {
          const id = intParam(url, 'id');
          const session = id ? store.session(id) : undefined;
          if (!id || !session) {
            status = 404;
            body = JSON.stringify({ error: 'no such session' });
          } else {
            body = JSON.stringify(
              {
                session,
                runs: store.segments(id),
                damage: store.abilities(id, 'damage'),
                healing: store.abilities(id, 'healing'),
                taken: store.abilities(id, 'taken'),
                encounters: store.encounters(id),
              },
              null,
              2,
            );
          }
          type = 'application/json; charset=utf-8';
          break;
        }

        case '/api/run': {
          const id = intParam(url, 'id');
          const run = id ? store.segment(id) : undefined;
          if (!id || !run) {
            status = 404;
            body = JSON.stringify({ error: 'no such run' });
          } else {
            body = JSON.stringify(
              {
                run,
                damage: store.segmentAbilities(id, 'damage'),
                healing: store.segmentAbilities(id, 'healing'),
                taken: store.segmentAbilities(id, 'taken'),
                history: store.runsForZone(run.zone_name, 50, run.character_guid ?? run.character_name).filter((r) => r.id !== id),
              },
              null,
              2,
            );
          }
          type = 'application/json; charset=utf-8';
          break;
        }

        case '/api/dashboards':
          body = JSON.stringify(
            store.dashboards().map((d) => ({ ...d, cards: store.dashboardCards(d.id) })),
            null,
            2,
          );
          type = 'application/json; charset=utf-8';
          break;

        case '/api/dashboard': {
          const id = intParam(url, 'id');
          const dashboard = id ? store.dashboard(id) : undefined;
          if (!id || !dashboard) {
            status = 404;
            body = JSON.stringify({ error: 'no such dashboard' });
          } else {
            body = JSON.stringify(
              {
                dashboard,
                cards: store.dashboardCards(id).map((card) => {
                  const metric = findMetric(store, card.metric);
                  if (!metric) return { ...card, metric: null, data: null };
                  const data = cardData(store, metric, card.range_minutes, Date.now(), ctx.character);
                  return {
                    ...card,
                    metric: {
                      id: metric.id,
                      label: metric.label,
                      group: metric.group,
                      shape: metric.shape,
                      unit: metric.unit,
                      description: metric.description,
                    },
                    data: {
                      rangeMinutes: card.range_minutes,
                      points: data.points,
                      total: data.total,
                      latest: data.latest,
                      previous: data.previous,
                    },
                  };
                }),
              },
              null,
              2,
            );
          }
          type = 'application/json; charset=utf-8';
          break;
        }

        case '/session': {
          const id = intParam(url, 'id');
          if (!id) {
            status = 400;
            body = page('Bad request', '<h1>400</h1><p>session id required.</p>', { active: 'sessions' });
          } else {
            const html = renderSession(ctx, id);
            if (html === null) {
              status = 404;
              body = notFound(`No session ${id}.`);
            } else body = html;
          }
          break;
        }

        case '/run': {
          const id = intParam(url, 'id');
          if (!id) {
            status = 400;
            body = page('Bad request', '<h1>400</h1><p>run id required.</p>', { active: 'sessions' });
          } else {
            const html = renderRun(ctx, id);
            if (html === null) {
              status = 404;
              body = notFound(`No run ${id}.`);
            } else body = html;
          }
          break;
        }

        case '/api/addons':
          body = JSON.stringify(
            listAddons(installs).map((f) => {
              const read = readAddon(f);
              return {
                id: f.id,
                file: f.file,
                path: f.path,
                flavor: f.flavor,
                account: f.account,
                bytes: f.bytes,
                mtimeMs: f.mtimeMs,
                provider: f.known ?? null,
                state: read.state,
                warningCount: read.warnings.length,
                globals: read.summaries.map((s) => ({
                  name: s.name,
                  paths: s.paths,
                  trackable: s.numeric.filter((n) => !n.constant).length,
                })),
              };
            }),
            null,
            2,
          );
          type = 'application/json; charset=utf-8';
          break;

        case '/api/addon': {
          const id = url.searchParams.get('f');
          const file = id ? listAddons(installs).find((f) => f.id === id) : undefined;
          if (!file) {
            status = 404;
            body = JSON.stringify({ error: 'no such addon' });
          } else {
            const read = readAddon(file);
            body = JSON.stringify(
              {
                file: { id: file.id, file: file.file, bytes: file.bytes, mtimeMs: file.mtimeMs },
                state: read.state,
                reason: read.reason ?? null,
                warnings: read.warnings,
                globals: read.summaries.map((s) => ({
                  name: s.name,
                  paths: s.paths,
                  truncated: s.truncated,
                  metrics: s.numeric.map((c) => ({
                    path: c.path,
                    formatted: c.path.join('.'),
                    instances: c.instances,
                    min: c.numeric.min,
                    max: c.numeric.max,
                    samples: c.samples,
                    constant: c.constant,
                    score: c.score,
                  })),
                  texts: s.texts.map((t) => ({ path: t.path, instances: t.instances, samples: t.samples })),
                })),
              },
              null,
              2,
            );
          }
          type = 'application/json; charset=utf-8';
          break;
        }

        /* ---------------------------------------------------------------------------------------
         * Dashboards. Creating, renaming and deleting are POSTs so a link preview or a stray reload
         * cannot change anything; each one answers with a redirect back to a page.
         * ------------------------------------------------------------------------------------- */

        case '/dashboards':
          body = renderDashboards(ctx);
          break;

        case '/dashboard': {
          const id = intParam(url, 'id');
          if (!id) {
            status = 400;
            body = page('Bad request', '<h1>400</h1><p>dashboard id required.</p>', { active: 'dashboards' });
          } else {
            const html = renderDashboard(ctx, id);
            if (html === null) {
              status = 404;
              body = notFound(`No dashboard ${id}.`);
            } else body = html;
          }
          break;
        }

        case '/dashboard/card': {
          const id = intParam(url, 'id');
          if (!id) {
            status = 400;
            body = page('Bad request', '<h1>400</h1><p>dashboard id required.</p>', { active: 'dashboards' });
          } else {
            const html = renderAddCard(ctx, id);
            if (html === null) {
              status = 404;
              body = notFound(`No dashboard ${id}.`);
            } else body = html;
          }
          break;
        }

        case '/dashboard/card/edit': {
          const id = intParam(url, 'id');
          if (!id) {
            status = 400;
            body = page('Bad request', '<h1>400</h1><p>card id required.</p>', { active: 'dashboards' });
          } else {
            const html = renderEditCard(ctx, id);
            if (html === null) {
              status = 404;
              body = notFound(`No card ${id}.`);
            } else body = html;
          }
          break;
        }

        case '/dashboard/card/preview': {
          const values = cardValuesFrom({
            metric: url.searchParams.get('metric'),
            view: url.searchParams.get('view'),
            range: url.searchParams.get('range'),
            title: url.searchParams.get('title'),
            w: url.searchParams.get('w'),
            h: url.searchParams.get('h'),
          });
          const html = renderPreview(ctx, values);
          if (html === null) {
            status = 400;
            body = '<div class="empty">That data source no longer exists.</div>';
          } else body = html;
          break;
        }

        /* After a resize the grid asks for the same card at its new cell size: charts, the pie key
         * and table row counts are chosen from w/h, so a resized card never scrolls. */
        case '/dashboard/card/body': {
          const id = intParam(url, 'id');
          const w = Number(url.searchParams.get('w'));
          const h = Number(url.searchParams.get('h'));
          const html =
            id === null
              ? null
              : renderCardBody(
                  ctx,
                  id,
                  Number.isInteger(w) && w > 0 ? w : undefined,
                  Number.isInteger(h) && h > 0 ? h : undefined,
                );
          if (html === null) {
            status = 404;
            body = '<div class="empty">No such card.</div>';
          } else body = html;
          break;
        }

        case '/dashboards/create': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to create a dashboard.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const name = field(form, 'name', 60) || 'Untitled dashboard';
          redirect(`/dashboard?id=${store.createDashboard(name)}`);
          return;
        }

        case '/dashboards/example': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to add the example dashboard.</p>', { active: 'dashboards' });
            break;
          }
          redirect(`/dashboard?id=${createExampleDashboard(store)}`);
          return;
        }

        case '/dashboard/rename': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to rename a dashboard.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const id = Number(form.get('id'));
          if (!Number.isInteger(id) || id <= 0 || !store.dashboard(id)) {
            status = 404;
            body = notFound('No such dashboard.');
            break;
          }
          const name = field(form, 'name', 60);
          if (name) store.renameDashboard(id, name);
          redirect(`/dashboard?id=${id}`);
          return;
        }

        case '/dashboard/delete': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to delete a dashboard.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const id = Number(form.get('id'));
          if (Number.isInteger(id) && id > 0) store.deleteDashboard(id);
          redirect('/dashboards');
          return;
        }

        case '/dashboard/card/add': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to add a card.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const dashboardId = Number(form.get('dashboard'));
          const dashboard =
            Number.isInteger(dashboardId) && dashboardId > 0 ? store.dashboard(dashboardId) : undefined;
          if (!dashboard) {
            status = 404;
            body = notFound('No such dashboard.');
            break;
          }
          const values = cardValuesFrom({
            metric: form.get('metric'),
            view: form.get('view'),
            range: form.get('range'),
            title: form.get('title'),
          });
          const metric = findMetric(store, values.metric);

          if (!metric) {
            status = 400;
            body = renderAddCard(ctx, dashboardId, { error: 'Choose a data source from the list.', values }) ?? '';
            break;
          }
          if (!isCardView(values.view)) {
            status = 400;
            body = renderAddCard(ctx, dashboardId, { error: 'Choose how to display the card.', values }) ?? '';
            break;
          }
          if (!viewFits(metric.shape, values.view)) {
            status = 400;
            body =
              renderAddCard(ctx, dashboardId, {
                error: `${values.view} does not fit ${metric.label}: that metric is ${
                  metric.shape === 'time' ? 'measured over time' : 'split into categories'
                }. Pick ${
                  metric.shape === 'time'
                    ? 'line, bar, static value or table'
                    : 'pie, bar, static value or table'
                }.`,
                values,
              }) ?? '';
            break;
          }
          const size = DEFAULT_SIZE[values.view];
          store.addDashboardCard({
            dashboardId,
            metric: metric.id,
            view: values.view,
            title: values.title || metric.label,
            rangeMinutes: values.rangeMinutes,
            w: size.w,
            h: size.h,
          });
          redirect(`/dashboard?id=${dashboardId}`);
          return;
        }

        case '/dashboard/card/update': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to update a card.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const id = Number(form.get('id'));
          const card = Number.isInteger(id) && id > 0 ? store.dashboardCard(id) : undefined;
          if (!card) {
            status = 404;
            body = notFound('No such card.');
            break;
          }
          const values = cardValuesFrom({
            metric: form.get('metric'),
            view: form.get('view'),
            range: form.get('range'),
            title: form.get('title'),
            w: card.w,
            h: card.h,
          });
          const metric = findMetric(store, values.metric);
          const fail = (error: string): void => {
            status = 400;
            body = renderEditCard(ctx, id, { error, values }) ?? '';
          };

          if (!metric) {
            fail('Choose a data source from the list.');
            break;
          }
          if (!isCardView(values.view)) {
            fail('Choose how to display the card.');
            break;
          }
          if (!viewFits(metric.shape, values.view)) {
            fail(
              `${values.view} does not fit ${metric.label}: that metric is ${
                metric.shape === 'time' ? 'measured over time' : 'split into categories'
              }. Pick ${
                metric.shape === 'time'
                  ? 'line, bar, static value or table'
                  : 'pie, bar, static value or table'
              }.`,
            );
            break;
          }
          store.updateDashboardCard(id, {
            title: values.title || metric.label,
            metric: metric.id,
            view: values.view,
            rangeMinutes: values.rangeMinutes,
          });
          redirect(`/dashboard?id=${card.dashboard_id}`);
          return;
        }

        case '/dashboard/layout': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST a layout to save it.</p>', { active: 'dashboards' });
            break;
          }
          let payload: unknown;
          try {
            payload = await readJson(req);
          } catch {
            status = 400;
            body = JSON.stringify({ error: 'invalid json' });
            type = 'application/json; charset=utf-8';
            break;
          }
          const body0 = (payload ?? {}) as { dashboard?: unknown; items?: unknown };
          const dashboardId = Number(body0.dashboard);
          if (!Number.isInteger(dashboardId) || dashboardId <= 0 || !store.dashboard(dashboardId)) {
            status = 404;
            body = JSON.stringify({ error: 'no such dashboard' });
            type = 'application/json; charset=utf-8';
            break;
          }
          if (!Array.isArray(body0.items)) {
            status = 400;
            body = JSON.stringify({ error: 'items must be an array' });
            type = 'application/json; charset=utf-8';
            break;
          }
          const items: { id: number; x: number; y: number; w: number; h: number }[] = [];
          for (const raw of body0.items.slice(0, 200)) {
            const item = (raw ?? {}) as Record<string, unknown>;
            const id = Number(item.id);
            const x = Number(item.x);
            const y = Number(item.y);
            const w = Number(item.w);
            const h = Number(item.h);
            if (![id, x, y, w, h].every((n) => Number.isFinite(n))) continue;
            items.push({ id, x, y, w, h });
          }
          const saved = store.saveDashboardLayout(dashboardId, items);
          body = JSON.stringify({ saved });
          type = 'application/json; charset=utf-8';
          break;
        }

        case '/dashboard/card/remove': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to remove a card.</p>', { active: 'dashboards' });
            break;
          }
          const form = await readForm(req);
          const id = Number(form.get('id'));
          const back = Number(form.get('dashboard'));
          const dashboardId = Number.isInteger(id) && id > 0 ? store.removeDashboardCard(id) : 0;
          redirect(
            dashboardId > 0
              ? `/dashboard?id=${dashboardId}`
              : Number.isInteger(back) && back > 0
                ? `/dashboard?id=${back}`
                : '/dashboards',
          );
          return;
        }

        case '/addons':
          body = renderAddons(ctx);
          break;
        case '/sensor':
          body = renderSensor(ctx);
          break;

        case '/tracked':
          body = renderTracked(ctx);
          break;

        case '/track': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to track a property.</p>', { active: 'addons' });
            break;
          }
          const form = await readForm(req);
          const file = listAddons(installs).find((f) => f.id === (form.get('f') ?? ''));
          const segments = decodePath(form.get('path')).slice(0, 24);
          if (!file || segments.length === 0) {
            status = 400;
            body = page(
              'Bad request',
              '<h1>400</h1><p>That addon or property no longer exists.</p><p><a href="/addons">Back to addons</a></p>',
              { active: 'addons' },
            );
            break;
          }
          const raw = form.get('unit') ?? 'plain';
          const unit = raw === 'copper' || raw === 'seconds' ? raw : 'plain';
          const kind = form.get('kind') === 'set' ? 'set' : 'number';
          const label = (form.get('label') || segments[segments.length - 1] || 'value').slice(0, 80);
          // A chosen entity must be one the file actually holds, or the series would be created
          // and then never sample: a typo would look like a parser bug for as long as it existed.
          const wanted = (form.get('entity') ?? '').trim().slice(0, 80);
          let entity: string | null = null;
          if (wanted) {
            const read = readAddon(file);
            const global = read.globals.find((g) => g.name === (segments[0] ?? ''));
            const rel = segments.slice(1);
            const keys =
              global && isTable(global.value)
                ? entityOptions(global.value, rel).filter(
                    (key) => collectValues(global.value, pinEntity(rel, key)).length > 0,
                  )
                : [];
            if (!keys.includes(wanted)) {
              status = 400;
              body = page(
                'Bad request',
                `<h1>400</h1><p><b>${esc(wanted)}</b> is not in <span class="mono">${esc(
                  file.file,
                )}</span> at that path. Pick one of: ${keys.map(esc).join(', ') || 'nothing — that path has no wildcard'}.</p>
                 <p><a href="/addons">Back to addons</a></p>`,
                { active: 'addons' },
              );
              break;
            }
            entity = wanted;
          }
          store.addTrackedMetric({
            addonFile: file.file,
            globalName: segments[0] ?? '',
            path: segments,
            label,
            unit,
            kind,
            entity,
          });
          // Sample immediately so the first value appears without waiting for the next flush.
          sampleTracked(store, installs);
          res.writeHead(303, { location: '/tracked', 'cache-control': 'no-store' });
          res.end();
          return;
        }

        case '/untrack': {
          if (req.method !== 'POST') {
            status = 405;
            body = page('Method not allowed', '<h1>405</h1><p>POST to stop tracking.</p>', { active: 'tracked' });
            break;
          }
          const form = await readForm(req);
          const id = Number(form.get('id'));
          if (Number.isInteger(id) && id > 0) store.removeTrackedMetric(id);
          res.writeHead(303, { location: '/tracked', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        case '/addon': {
          const html = renderAddon(ctx, url);
          if (html === null) {
            status = 404;
            body = notFound('No addon with that id. It may have been removed or renamed.');
          } else body = html;
          break;
        }

        case '/runs':
          body = renderRuns(ctx);
          break;
        case '/pvp':
          body = renderPvp(ctx);
          break;
        case '/bags':
          body = renderBags(ctx);
          break;
        case '/diagnostics':
          body = renderDiagnostics(ctx);
          break;
        case '/':
          body = renderHome(ctx);
          break;

        default: {
          const asset = ASSETS[url.pathname];
          const content = asset ? await readFile(asset.file, 'utf8').catch(() => null) : null;
          if (asset && content !== null) {
            body = content;
            type = asset.type;
          } else if (asset) {
            status = 404;
            body = 'asset not found';
            type = 'text/plain; charset=utf-8';
          } else {
            status = 404;
            body = notFound(`No page at ${url.pathname}.`);
          }
        }
      }
    } catch (err) {
      status = 500;
      body = page(
        'Error',
        `<h1>500</h1><div class="notice warn">This page failed to render.</div>
         <pre class="mono">${esc((err as Error).stack ?? String(err))}</pre>`,
        { active: 'sessions' },
      );
    }
    if (body === undefined) {
      status = 500;
      body = page('Error', '<h1>500</h1><p>This route produced no response.</p>', { active: 'sessions' });
    }
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

/**
 * Resolves once the server is listening; rejects with a readable reason when it cannot.
 *
 * The usual failure is another Portalstone already on the port (the service, while a dev run
 * starts). Knowing that before the first scan matters: a second agent that scans first writes the
 * same rows as the first, and only then discovers it has nowhere to serve them.
 */
export function listening(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is already in use — another Portalstone (the service?) is probably running. ` +
                'Stop it (serv stop portalstone) or pass --port.',
            )
          : err,
      );
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

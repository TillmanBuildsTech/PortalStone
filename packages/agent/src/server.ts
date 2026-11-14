/**
 * Local HTTP UI. Server-rendered HTML on purpose: no bundler, no framework, no build step, so the
 * first testable version is one command away. The JSON endpoints (`/api/*`) are the part that
 * survives a React/Vite surface replacing the pages.
 *
 * This file is only routing. The pages live in `ui/pages`, the shared chrome in `ui/shell`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { InstallInfo } from './discover';
import type { Store } from './store';
import { page } from './ui/shell';
import { esc } from './ui/format';
import type { Ctx, LastScan } from './ui/context';
import { renderHome } from './ui/pages/home';
import { renderSession } from './ui/pages/session';
import { renderRun } from './ui/pages/run';
import { renderRuns } from './ui/pages/runs';
import { renderBags } from './ui/pages/bags';
import { renderDiagnostics } from './ui/pages/diagnostics';
import { renderAddons } from './ui/pages/addons';
import { renderAddon, decodePath } from './ui/pages/addon';
import { renderTracked } from './ui/pages/tracked';
import { sampleTracked } from './tracking';
import { listAddons, readAddon } from './addons';

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

function intParam(url: URL, name: string): number | null {
  const id = Number(url.searchParams.get(name));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function notFound(msg: string): string {
  return page(
    'Not found',
    `<h1>Not found</h1><div class="sub">${esc(msg)}</div>
     <p><a href="/">Back to sessions</a></p>`,
    { active: 'sessions' },
  );
}

export function startServer(store: Store, installs: InstallInfo[], opts: ServerOptions): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    const ctx: Ctx = { store, installs, lastScan: opts.lastScan(), dbPath: opts.dbPath };
    let status = 200;
    let body: string;
    let type = 'text/html; charset=utf-8';

    try {
      switch (url.pathname) {
        case '/api/summary':
          body = JSON.stringify(
            { totals: store.totals(), sessions: store.listSessions(50), lastScan: ctx.lastScan },
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
                history: store.runsForZone(run.zone_name, 50).filter((r) => r.id !== id),
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

        case '/addons':
          body = renderAddons(ctx);
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
          store.addTrackedMetric({
            addonFile: file.file,
            globalName: segments[0] ?? '',
            path: segments,
            label,
            unit,
            kind,
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
        case '/bags':
          body = renderBags(ctx);
          break;
        case '/diagnostics':
          body = renderDiagnostics(ctx);
          break;
        case '/':
          body = renderHome(ctx);
          break;

        default:
          status = 404;
          body = notFound(`No page at ${url.pathname}.`);
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
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

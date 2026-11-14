/**
 * Diagnostics: the bug report.
 *
 * Everything here is about the ingest, not the gameplay: which log files were found, what layout
 * the parser calibrated to, how far it has read, and what failed. When a number looks wrong, the
 * answer is usually on this page.
 */
import { cards, metas, page, section, table } from '../shell';
import { ago, esc, num } from '../format';
import type { Ctx } from '../context';
import { itemNameConfigFromEnv, lastItemNameError } from '../../items';
import { PROVIDERS } from '../../providers';


export function renderDiagnostics(ctx: Ctx): string {
  const logs = ctx.store.logFiles();
  const last = ctx.lastScan;

  const logRows = logs.map((l) => {
    let layout = '—';
    if (l.layout) {
      try {
        const p = JSON.parse(String(l.layout)) as { mode: string; infoGuid: boolean; midBlock: number; score: number };
        layout = `${p.mode}${p.infoGuid ? '+info' : ''}${p.mode === 'afterBlock' ? `/${p.midBlock}` : ''} ${(p.score * 100).toFixed(0)}%`;
      } catch {
        layout = 'unparsed';
      }
    }
    const err = l.last_error
      ? `<span class="pill bad">${esc(l.last_error)}</span>`
      : `<span class="pill ok">ok</span>`;
    const read = Number(l.bytes) > 0 ? Math.round((Number(l.offset) / Number(l.bytes)) * 100) : 0;
    return `<tr>
      <td class="l mono">${esc(l.path)}</td>
      <td>${num(Number(l.bytes))}</td>
      <td>${num(Number(l.offset))} <span class="sub">${read}%</span></td>
      <td class="l">${esc(layout)}</td>
      <td>${esc(l.build || '—')}</td>
      <td>${num(Number(l.unknown_lines))}</td>
      <td>${err}</td>
    </tr>`;
  });

  const installsHtml = ctx.installs
    .map((i) => {
      const flavors = i.flavors
        .map((f) => {
          const accounts = f.accounts
            .map((a) => {
              const rows = a.savedVariables.map((v) => {
                const p = PROVIDERS[v.name];
                return `<tr><td class="l mono">${esc(v.name)}</td><td class="l mono">${esc(p?.id ?? '—')}</td>
                  <td class="l wrap">${esc(p?.caps.join(', ') || '—')}</td>
                  <td>${num(v.bytes)}</td>
                  <td>${p ? '<span class="pill">adapter pending</span>' : '<span class="pill">—</span>'}</td></tr>`;
              });
              return `<div class="sub" style="margin:14px 0 2px">account <b>${esc(a.name)}</b></div>
                ${table(['SavedVariables', 'provider', 'capabilities', 'size', 'state'], rows, {
                  left: [0, 1, 2],
                  empty: 'No SavedVariables files in this account.',
                })}`;
            })
            .join('');
          return `${section(
            f.name,
            `${accounts || '<div class="sub">No accounts found.</div>'}
             <div class="sub" style="margin-top:8px">${f.logs.length} combat log file(s) in this flavor</div>`,
            esc(f.dir),
          )}`;
        })
        .join('');
      return `${section(i.root, flavors || '<div class="sub">No flavors found.</div>')}`;
    })
    .join('');

  const body = `
    <h1>Diagnostics</h1>
    ${metas([
      `last scan ${last.at ? ago(last.at) : 'never'}`,
      `${num(last.entries)} log file(s) checked`,
      last.errors ? `<span class="pill bad">${num(last.errors)} error(s)</span>` : '<span class="pill ok">no errors</span>',
      `<span class="mono">${esc(ctx.dbPath)}</span>`,
      `node ${esc(process.version)}`,
    ])}
    ${cards([
      { k: 'log files', v: num(logs.length), lead: true },
      { k: 'installs', v: num(ctx.installs.length) },
      { k: 'bytes read', v: num(logs.reduce((a, l) => a + Number(l.bytes), 0)) },
      { k: 'unknown lines', v: num(logs.reduce((a, l) => a + Number(l.unknown_lines), 0)) },
      { k: 'item names cached', v: num(ctx.store.itemNameCount()) },
    ])}
    ${section(
      'combat logs',
      table(['path', 'bytes', 'read to', 'layout', 'build', 'unknown', 'state'], logRows, {
        left: [0, 3],
        empty: 'No logs ingested yet.',
      }),
      'layout is what the parser calibrated to, with its confidence',
    )}
    ${installsHtml || '<div class="notice">No World of Warcraft install found. Set PORTALSTONE_WOW_DIR to the install folder.</div>'}
    ${section(
      'item names',
      `${(() => {
        const cfg = itemNameConfigFromEnv();
        const sources = ctx.store.itemNameSources();
        const error = lastItemNameError();
        return `<ul class="plain">
         <li>cached: <b>${num(ctx.store.itemNameCount())}</b> ids${
           sources.length ? ` (${sources.map((s) => `${esc(s.source)} ${num(s.count)}`).join(', ')})` : ''
         }</li>
         <li>API endpoint: ${
           cfg.apiBase ? `<span class="mono">${esc(cfg.apiBase)}</span>` : '<span class="sub">not configured — PORTALSTONE_ITEM_API</span>'
         }</li>
         <li>local dump: ${
           cfg.file ? `<span class="mono">${esc(cfg.file)}</span>` : '<span class="sub">not configured — PORTALSTONE_ITEM_NAMES</span>'
         }</li>
         <li>Blizzard client: ${
           cfg.blizzard
             ? `<span class="mono">${esc(cfg.blizzard.region)}</span> (official game-data API)`
             : '<span class="sub">not configured — PORTALSTONE_BNET_ID + PORTALSTONE_BNET_SECRET</span>'
         }</li>
         ${error ? `<li><span class="pill bad">last error</span> ${esc(error)}</li>` : ''}
       </ul>
       <div class="sub" style="margin-top:8px">Names are optional: equipment renders item ids without them.
       Each name is fetched once and kept; an item the API does not know is not asked about again for a week,
       so private-server items cannot create a request loop. Blizzard answers 404 both for a missing item and
       for a missing token, so a rejected client is reported as an error, never as "unknown item".</div>`;
      })()}`,
    )}
    <div class="notice" style="margin-top:22px">SavedVariables files are read by the base adapter:
      <a href="/addons">open the addons page</a> to see what each installed addon actually exposes before
      a capability adapter is written for it.</div>`;
  return page('Diagnostics', body, { active: 'diagnostics', refresh: 30, ctx });
}

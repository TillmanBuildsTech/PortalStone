/**
 * One SavedVariables file, opened up.
 *
 * Three views, no JavaScript: the top level (what globals does this addon keep?), a path browser
 * (what is inside this table?), and a search across every property (where is `money`?). Numbers
 * that look trackable — they vary, they are per-entity or global, they are not 0..1 fractions —
 * are marked as such, which is the shortlist a dashboard or report would draw from.
 */
import { listAddons, readAddon, type AddonRead } from '../../addons';
import { isTable, type LuaValue } from '../../../../core/src/savedvars/lua';
import {
  flatten,
  formatPath,
  indexTree,
  introspect,
  pathKey,
  previewScalar,
  resolvePath,
  segmentLabel,
  type MetricCandidate,
  type ShapeNode,
} from '../../../../core/src/savedvars/shape';
import { cards, emptyState, metas, page, section, table } from '../shell';
import { ago, esc, num, size } from '../format';
import type { Ctx } from '../context';
import { renderAddons } from './addons';

const MAX_CHILD_ROWS = 200;
const MAX_SEARCH_ROWS = 120;

/** `/foo/bar` segments, each URL-encoded, so a key containing a slash survives the round trip. */
export function encodePath(segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

export function decodePath(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
}

export function renderAddon(ctx: Ctx, url: URL): string | null {
  const id = url.searchParams.get('f');
  const q = (url.searchParams.get('q') ?? '').trim();
  const path = decodePath(url.searchParams.get('path'));

  if (!id) {
    if (q) return renderCrossSearch(ctx, q);
    return renderAddons(ctx);
  }
  const file = listAddons(ctx.installs).find((f) => f.id === id);
  if (!file) return null;
  const read = readAddon(file);
  const globals = read.summaries.map((s) => s.name).join(' • ') || file.file;

  const head = `
    <div class="crumbs"><a href="/addons">addons</a> <span>/</span>
      ${path.length > 1 ? breadcrumb(id, path) : `<span>${esc(globals)}</span>`}</div>
    <h1>${esc(globals)}</h1>
    ${metas([
      `<span class="mono">${esc(file.file)}</span>`,
      `${esc(file.flavor)} · account ${esc(file.account)}`,
      size(file.bytes),
      `saved ${ago(file.mtimeMs)}`,
      read.state === 'ok' ? `${num(read.summaries.reduce((a, s) => a + s.paths, 0))} properties` : null,
      read.elapsedMs ? `read in ${num(read.elapsedMs)} ms` : null,
    ])}`;

  if (read.state !== 'ok') {
    return page(
      file.file,
      `${head}
      <div class="notice warn">
        <b>${esc(read.state)}</b> — ${esc(read.reason ?? 'this file could not be read')}
        ${read.warnings.length ? `<div class="sub" style="margin-top:6px">${read.warnings.map(esc).join('<br>')}</div>` : ''}
      </div>
      <p><a href="/addons">Back to addons</a></p>`,
      { active: 'addons', ctx },
    );
  }

  const body = q
    ? head + searchWithin(read, q, id)
    : path.length > 0
      ? head + nodeView(read, id, path)
      : head + overview(read, id);

  return page(globals, body, { active: 'addons', ctx });
}

function breadcrumb(id: string, path: string[]): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const label = path[i] === '*' ? '[*]' : segmentLabel(path[i]!);
    const isLast = i === path.length - 1;
    out += `${i > 0 ? '<span>/</span>' : ''}${
      isLast
        ? `<span>${esc(label)}</span>`
        : `<a href="/addon?f=${id}&path=${encodePath(path.slice(0, i + 1))}">${esc(label)}</a>`
    }`;
  }
  return out;
}

function overview(read: AddonRead, id: string): string {
  const globals = read.summaries.map((s) => s.name).join(' • ');
  const numeric = read.summaries
    .flatMap((s) => s.numeric)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  const texts = read.summaries
    .flatMap((s) => s.texts)
    .sort((a, b) => b.instances - a.instances)
    .slice(0, 20);
  const truncated = read.summaries.filter((s) => s.truncated);

  const globalRows = read.summaries.map(
    (s) => `<tr>
      <td class="l"><a href="/addon?f=${id}&path=${encodePath([s.name])}">${esc(s.name)}</a></td>
      <td>${s.type}</td>
      <td>${num(s.paths)}</td>
      <td>${num(s.numeric.filter((n) => !n.constant).length)}</td>
      <td>${num(s.texts.length)}</td>
      <td>${s.truncated ? '<span class="pill warn">partial</span>' : '<span class="pill ok">complete</span>'}</td>
    </tr>`,
  );

  const metricRows = numeric.map((c) => metricRow(id, c));

  // Tables of scalars are trackable as sets (equipment slots, attunement flags). Surfacing them on
  // the overview is what makes "track my gear" a click instead of a hunt through the tree.
  const lists = read.globals
    .flatMap((g) =>
      flatten(introspect(g.value, { rootName: g.name }).root).filter((n) => {
        if (n.type !== 'table' || (n.entries ?? 0) < 2) return false;
        const children = n.children ?? [];
        if (children.length === 0) return false;
        if (!children.every((c) => c.type !== 'table' && c.type !== 'mixed')) return false;
        // A collapsed collection has a single `[*]` child; a named map has one per key.
        return (n.collectionOf ?? 0) >= 2 || children.length >= 2;
      }),
    )
    .sort((a, b) => (b.entries ?? 0) - (a.entries ?? 0))
    .slice(0, 8);
  const listRows = lists.map((n) => {
    const metricPath = [...n.path, '*'];
    return `<tr>
      <td class="l"><a class="mono" href="/addon?f=${id}&path=${encodePath(n.path)}">${esc(formatPath(n.path))}</a></td>
      <td>${num(n.entries ?? 0)}</td>
      <td>${n.children?.[0]?.samples.slice(0, 1).map((x) => `<span class="mono">${esc(x)}</span>`).join('') || '—'}</td>
      <td><form method="post" action="/track" style="display:inline">
        <input type="hidden" name="f" value="${esc(id)}">
        <input type="hidden" name="path" value="${esc(encodePath(metricPath))}">
        <input type="hidden" name="label" value="${esc(n.segment)}">
        <input type="hidden" name="unit" value="plain">
        <input type="hidden" name="kind" value="set">
        <button type="submit" class="linkbtn">track as set</button>
      </form></td>
    </tr>`;
  });
  const textRows = texts.map(
    (t) => `<tr>
      <td class="l"><a class="mono" href="/addon?f=${id}&path=${encodePath(t.path)}">${esc(formatPath(t.path))}</a></td>
      <td>${num(t.instances)}</td>
      <td class="l wrap">${t.samples.map((s) => `<span class="mono">${esc(s)}</span>`).join(', ') || '—'}</td>
    </tr>`,
  );

  return `
    ${cards([
      { k: 'properties', v: num(read.summaries.reduce((a, s) => a + s.paths, 0)), lead: true },
      { k: 'numbers that vary', v: num(read.summaries.reduce((a, s) => a + s.numeric.filter((n) => !n.constant).length, 0)) },
      { k: 'text dimensions', v: num(read.summaries.reduce((a, s) => a + s.texts.length, 0)) },
      { k: 'globals', v: num(read.summaries.length) },
    ])}
    ${section(
      'globals in this file',
      table(['global', 'type', 'properties', 'trackable', 'text', 'indexed'], globalRows, { left: [0] }),
    )}
    ${section(
      'numbers that look trackable',
      metricRows.length
        ? table(['property', 'kind', 'range', 'seen in', 'examples', ''], metricRows, { left: [0, 4] })
        : '<div class="empty">No varying numbers in this file.</div>',
      'varies, and is either per-entity or global · click one to see it in place',
    )}
    ${section(
      'lists you can track as a set',
      listRows.length
        ? table(['property', 'members', 'example', ''], listRows, { left: [0, 2] })
        : '<div class="empty">No lists of values in this file.</div>',
      'equipment, attunements, completed quests: kept per flush and diffed',
    )}
    ${section(
      'text properties (dimensions)',
      textRows.length ? table(['property', 'instances', 'examples'], textRows, { left: [0, 2] }) : '<div class="empty">No text values.</div>',
      'names, classes, zones: what you would group a report by',
    )}
    ${
      truncated.length
        ? `<div class="notice warn" style="margin-top:20px">Large tables in
             ${truncated.map((t) => esc(t.name)).join(', ')} were indexed to a limited depth. Repeated rows
             are collapsed to <span class="mono">[*]</span>, so the property list stays readable.</div>`
        : ''
    }
    <div class="notice" style="margin-top:20px">
      <b>${esc(globals)}</b> is read as data, never executed. Nothing here is tracked yet: this page is the
      shortlist. A property marked <span class="pill">metric</span> is a number that varies across
      ${esc('entries')} — the shape a dashboard tile or report column would need. Values are what they were
      at the last SavedVariables flush (logout, <span class="mono">/reload</span>, or exit), not live.
    </div>`;
}

function metricRow(id: string, c: MetricCandidate): string {
  const range =
    c.numeric.min === c.numeric.max
      ? num(c.numeric.min)
      : `${num(c.numeric.min)} – ${num(c.numeric.max)}`;
  const kind = c.constant ? '<span class="pill">flag</span>' : '<span class="pill ok">metric</span>';
  const starAt = c.path.lastIndexOf('*');
  const where =
    c.perEntity && c.instances > 1
      ? `per entity · ${num(c.instances)} <a href="/addon?f=${id}&path=${encodePath(c.path.slice(0, starAt))}">pick one →</a>`
      : c.perEntity
        ? 'one entity'
        : 'global';
  return `<tr>
    <td class="l"><a class="mono" href="/addon?f=${id}&path=${encodePath(c.path)}">${esc(formatPath(c.path))}</a></td>
    <td>${kind}</td>
    <td>${range}</td>
    <td>${where}</td>
    <td class="l wrap">${c.samples.map((x) => `<span class="mono">${esc(x)}</span>`).join(', ') || '—'}</td>
    <td>${c.constant ? '' : trackForm(id, c.path, c.label, guessUnit(c.path, c.label))}</td>
  </tr>`;
}

/**
 * One-click tracking. The unit is guessed from the property name because the adapter cannot know
 * what a number means; the leaf page lets the user correct it.
 */
function guessUnit(path: string[], label: string): string {
  const hay = `${path.join('.')} ${label}`.toLowerCase();
  if (/money|gold|copper|price|cost|vendor|bank/.test(hay)) return 'copper';
  if (/time|seconds|duration|played|uptime|elapsed/.test(hay)) return 'seconds';
  return 'plain';
}

function trackForm(id: string, path: string[], label: string, unit: string): string {
  return `<form method="post" action="/track" style="display:inline">
      <input type="hidden" name="f" value="${esc(id)}">
      <input type="hidden" name="path" value="${esc(encodePath(path))}">
      <input type="hidden" name="label" value="${esc(label)}">
      <input type="hidden" name="unit" value="${esc(unit)}">
      <button type="submit" class="linkbtn">track</button>
    </form>`;
}

function nodeView(read: AddonRead, id: string, path: string[]): string {
  const globalName = path[0]!;
  const global = read.globals.find((g) => g.name === globalName);
  if (!global) {
    return emptyState(
      'That global is no longer in this file.',
      'The addon rewrote its SavedVariables since this page was opened. <a href="/addons">Start again</a>.',
    );
  }
  const value = resolvePath(global.value, path.slice(1));
  if (value === undefined) {
    return emptyState('That path is not in the file any more.', '<a href="/addons">Back to addons</a>.');
  }

  const shape = introspect(global.value, { rootName: globalName });
  const index = indexTree(shape.root);
  const node = index.get(pathKey(path));

  if (!isTable(value)) {
    const sample = previewScalar(value);
    return `<div class="cards">
        <div class="card lead"><div class="k">value</div><div class="v" style="font-size:16px">${esc(sample)}</div></div>
        <div class="card"><div class="k">type</div><div class="v" style="font-size:16px">${typeof value}</div></div>
        ${node?.numeric ? `<div class="card"><div class="k">range across instances</div>
          <div class="v" style="font-size:16px">${num(node.numeric.min)} – ${num(node.numeric.max)}</div></div>` : ''}
      </div>
      ${typeof value === 'number' ? trackLeafForm(id, path, value) : ''}
      <div class="sub" style="margin-top:14px">This is a leaf: a dashboard would chart it, not browse it.</div>`;
  }

  // A collapsed collection is shown as its shape (fields with instance counts), because listing
  // four thousand quest ids is not a UI.
  const collection = node?.collectionOf && node.children?.length;
  const rows = collection
    ? collectionRows(id, path, node!)
    : entryRows(id, path, value);
  const shown = collection
    ? `${num(node!.collectionOf)} entries, collapsed to ${num(node!.children!.length)} fields`
    : `${num(value.entries.length)} entr${value.entries.length === 1 ? 'y' : 'ies'}`;

  return `
    ${metas([`<span class="mono">${esc(formatPath(path))}</span>`, shown, node?.type ? `type ${node.type}` : null])}
    ${section('contents', rows, collection ? 'repeated rows are collapsed to [*]' : undefined)}
    ${trackSetForm(id, path, value)}
    <div class="sub" style="margin-top:14px">
      <a href="/addon?f=${id}&path=${encodePath(path.slice(0, -1))}">← up one level</a> ·
      <a href="/addon?f=${id}">top of this file</a>
    </div>`;
}

function trackLeafForm(id: string, path: string[], value: number): string {
  const label = path[path.length - 1] ?? 'value';
  const unit = guessUnit(path, label);
  const option = (v: string, text: string): string =>
    `<option value="${v}"${v === unit ? ' selected' : ''}>${text}</option>`;
  return `<div class="notice" style="margin-top:16px">
      <form method="post" action="/track" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="hidden" name="f" value="${esc(id)}">
        <input type="hidden" name="path" value="${esc(encodePath(path))}">
        <input type="hidden" name="label" value="${esc(label)}">
        <span>Track ${esc(label)} = <b>${esc(previewScalar(value))}</b> as</span>
        <select class="unit" name="unit">
          ${option('plain', 'a plain number')}
          ${option('copper', 'copper (shown as gold)')}
          ${option('seconds', 'seconds (shown as time)')}
        </select>
        <button type="submit" class="linkbtn">start tracking</button>
      </form>
      <div class="sub" style="margin-top:8px">Every SavedVariables flush adds a sample. History starts now.</div>
    </div>`;
}

/**
 * A table of scalars is a list: equipment slots, attunement flags, completed quest ids. Tracking it
 * keeps the members per flush and diffs them, which is the only gear history a snapshot source can
 * support — `equip[4]` changing is the event, not "one of 19 strings changed".
 */
function trackSetForm(id: string, path: string[], value: LuaValue): string {
  if (!isTable(value) || value.entries.length === 0) return '';
  if (!value.entries.every(([, v]) => !isTable(v))) return '';
  const label = path[path.length - 1] ?? 'list';
  const members = encodePath([...path, '*']);
  return `<div class="notice" style="margin-top:18px">
      <form method="post" action="/track" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="hidden" name="f" value="${esc(id)}">
        <input type="hidden" name="path" value="${esc(members)}">
        <input type="hidden" name="label" value="${esc(label)}">
        <input type="hidden" name="unit" value="plain">
        <input type="hidden" name="kind" value="set">
        <span>Track this list as a set — ${num(value.entries.length)} members, compared at every flush</span>
        <button type="submit" class="linkbtn">track ${esc(label)}</button>
      </form>
    </div>`;
}

function collectionRows(id: string, path: string[], node: ShapeNode): string {
  const rows = (node.children ?? []).map((c) => {
    const link = `/addon?f=${id}&path=${encodePath([...path, c.segment])}`;
    const label = c.segment === '*' ? '[*]' : segmentLabel(c.segment);
    const preview =
      c.type === 'table'
        ? `{${num(c.entries ?? 0)} entries}`
        : c.samples.slice(0, 2).map((s) => `<span class="mono">${esc(s)}</span>`).join(', ') || '—';
    return `<tr>
      <td class="l"><a href="${link}">${esc(label)}</a></td>
      <td>${c.type}</td>
      <td>${num(c.instances)}</td>
      <td class="l wrap">${preview}</td>
      <td>${c.type === 'table' && (c.entries ?? 0) > 0 ? `<a href="${link}">open →</a>` : ''}</td>
    </tr>`;
  });
  return table(['field', 'type', 'instances', 'example'], rows, { left: [0, 3] });
}

function entryRows(id: string, path: string[], value: LuaValue): string {
  if (!isTable(value)) return '';
  const entries = value.entries.slice(0, MAX_CHILD_ROWS);
  const rows = entries.map(([key, child]) => {
    const seg = String(key);
    const link = `/addon?f=${id}&path=${encodePath([...path, seg])}`;
    const isTbl = isTable(child);
    const preview = isTbl
      ? `{${num(child.entries.length)}}`
      : `<span class="mono">${esc(previewScalar(child as string | number | boolean))}</span>`;
    return `<tr>
      <td class="l"><a href="${link}">${esc(segmentLabel(seg))}</a></td>
      <td>${isTbl ? 'table' : typeof child}</td>
      <td>${isTbl ? num(child.entries.length) : 1}</td>
      <td class="l wrap">${preview}</td>
      <td>${isTbl && child.entries.length > 0 ? `<a href="${link}">open →</a>` : ''}</td>
    </tr>`;
  });
  const note =
    value.entries.length > entries.length
      ? `<div class="sub" style="margin-top:8px">showing ${num(entries.length)} of ${num(value.entries.length)} entries</div>`
      : '';
  return table(['key', 'type', 'entries', 'value'], rows, { left: [0, 3] }) + note;
}

function searchWithin(read: AddonRead, q: string, id: string): string {
  const needle = q.toLowerCase();
  const numeric = read.summaries
    .flatMap((s) => s.numeric)
    .filter((c) => matches(formatPath(c.path), needle) || c.samples.some((s) => s.toLowerCase().includes(needle)))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_ROWS);
  const texts = read.summaries
    .flatMap((s) => s.texts)
    .filter((t) => matches(formatPath(t.path), needle) || t.samples.some((s) => s.toLowerCase().includes(needle)))
    .slice(0, MAX_SEARCH_ROWS);

  return `
    ${searchForm(q, id)}
    ${section(
      'matching numbers',
      numeric.length
        ? table(['property', 'kind', 'range', 'seen in', 'examples', ''], numeric.map((c) => metricRow(id, c)), { left: [0, 4] })
        : `<div class="empty">No numbers match “${esc(q)}”.</div>`,
    )}
    ${section(
      'matching text',
      texts.length
        ? table(
            ['property', 'instances', 'examples'],
            texts.map(
              (t) => `<tr><td class="l"><a class="mono" href="/addon?f=${id}&path=${encodePath(t.path)}">${esc(formatPath(t.path))}</a></td>
                <td>${num(t.instances)}</td><td class="l wrap">${t.samples.map((s) => `<span class="mono">${esc(s)}</span>`).join(', ')}</td></tr>`,
            ),
            { left: [0, 2] },
          )
        : `<div class="empty">No text matches “${esc(q)}”.</div>`,
    )}`;
}

function renderCrossSearch(ctx: Ctx, q: string): string {
  const needle = q.toLowerCase();
  const hits: { file: AddonRead['file']; candidate: MetricCandidate }[] = [];
  for (const file of listAddons(ctx.installs)) {
    const read = readAddon(file);
    if (read.state !== 'ok') continue;
    for (const s of read.summaries) {
      for (const c of s.numeric) {
        if (matches(formatPath(c.path), needle) || c.samples.some((x) => x.toLowerCase().includes(needle))) {
          hits.push({ file, candidate: c });
        }
      }
    }
  }
  hits.sort((a, b) => b.candidate.score - a.candidate.score);
  const rows = hits.slice(0, MAX_SEARCH_ROWS).map(({ file, candidate }) => {
    const range =
      candidate.numeric.min === candidate.numeric.max
        ? num(candidate.numeric.min)
        : `${num(candidate.numeric.min)} – ${num(candidate.numeric.max)}`;
    return `<tr>
      <td class="l"><a class="mono" href="/addon?f=${file.id}&path=${encodePath(candidate.path)}">${esc(formatPath(candidate.path))}</a></td>
      <td class="l">${esc(file.file)}</td>
      <td>${candidate.constant ? '<span class="pill">flag</span>' : '<span class="pill ok">metric</span>'}</td>
      <td>${range}</td>
    </tr>`;
  });

  return `${searchForm(q, null)}
    ${metas([`${num(hits.length)} propert${hits.length === 1 ? 'y' : 'ies'} matching “${esc(q)}” across all addons`])}
    ${section(
      'matches',
      rows.length
        ? table(['property', 'addon', 'kind', 'range'], rows, { left: [0, 1] })
        : `<div class="empty">Nothing matches “${esc(q)}”. Try <a href="/addon?q=level">level</a> or
             <a href="/addon?q=money">money</a>.</div>`,
    )}
    ${hits.length > rows.length ? `<div class="sub" style="margin-top:8px">showing ${num(rows.length)} of ${num(hits.length)}</div>` : ''}`;
}

function searchForm(q: string, id: string | null): string {
  return `<form method="get" action="/addon" style="margin:18px 0 4px;display:flex;gap:8px;max-width:520px">
      ${id ? `<input type="hidden" name="f" value="${esc(id)}">` : ''}
      <input name="q" value="${esc(q)}" placeholder="search properties: money, level, quest…"
        aria-label="search properties"
        style="flex:1;background:#12181f;border:1px solid #222b36;color:#d5dde6;border-radius:8px;padding:8px 10px;font:inherit">
      <button type="submit" style="background:#1b2735;border:1px solid #2b3a4d;color:#cfe3ff;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer">search</button>
    </form>`;
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

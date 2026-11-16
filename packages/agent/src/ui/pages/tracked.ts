/**
 * Tracked properties: the values the user chose to keep.
 *
 * Two kinds share this page:
 *   - number  gold, level, counts — summed per flush, charted over time
 *   - set     equipment slots, attunements — the members as they were at each flush, diffed
 *
 * A series only gains a point when the addon writes its SavedVariables (logout, /reload, exit), so
 * the chart is honest about when it observed something: the x axis is flush time, and a flat line
 * means nothing moved between logins — not that the app stopped reading.
 */
import { lineChart } from '../charts';
import { cards, emptyState, metas, page, section, table } from '../shell';
import { ago, delta, esc, num, plural, quantity, quantityAxis, when } from '../format';
import { compareKeys, itemLabel, looksLikeEquipment, slotName } from '../gear';
import type { Ctx } from '../context';
import { listAddons, readAddon, type AddonFile } from '../../addons';
import { isTable } from '../../../../core/src/savedvars/lua';
import { collectValues, entityOptions, pinEntity } from '../../../../core/src/savedvars/shape';
import { diffMembers, parseMembers, parsePath, toNumber, type Member } from '../../tracking';
import { itemIdFromString } from '../../items';
import type { TrackedMetricRow, TrackedSampleRow } from '../../store';
import { encodePath } from './addon';

export function renderTracked(ctx: Ctx): string {
  const store = ctx.store;
  const metrics = store.trackedMetrics();
  const files = listAddons(ctx.installs);

  if (metrics.length === 0) {
    return page(
      'Tracked',
      `<h1>Tracked values</h1>
       ${metas(['nothing tracked yet'])}
       ${emptyState(
         'No properties are being tracked.',
         `Open <a href="/addons">addons</a>, pick the one that holds the value you care about — gold and
          equipment live in BagBrother — and press <b>track</b> on the property.`,
       )}
       <div class="notice" style="margin-top:22px">
         Numbers are summed and charted; lists (equipment slots) are stored as members and diffed at each
         flush. The app samples the property at every SavedVariables flush and keeps the series locally.
       </div>`,
      { active: 'tracked', refresh: 60, ctx },
    );
  }

  const allSamples = new Map(metrics.map((m) => [m.id, store.samples(m.id, 400)]));
  const totalSamples = [...allSamples.values()].reduce((a, list) => a + list.length, 0);
  const lastFlush = Math.max(...[...allSamples.values()].map((list) => list[list.length - 1]?.ts_ms ?? 0));

  // Names are looked up once for every item in every set sample on the page.
  const itemIds = metrics
    .filter((m) => m.kind === 'set')
    .flatMap((m) => (allSamples.get(m.id) ?? []).flatMap((s) => parseMembers(s.members).map((x) => itemIdFromString(x.v))))
    .filter((id): id is number => id !== null);
  const details = store.itemNameDetails(itemIds);
  const names = new Map([...details].map(([id, d]) => [id, d.name]));

  const bodies = metrics.map((m) => {
    const samples = allSamples.get(m.id) ?? [];
    const latest = samples[samples.length - 1];
    const file = files.find((f) => f.file === m.addon_file);
    const segments = parsePath(m.path);
    const source = file
      ? `<a href="/addon?f=${file.id}&path=${encodePath(segments)}">${esc(m.label)}</a>`
      : `<span class="pill bad">${esc(m.addon_file)} not installed</span>`;

    // A pinned series says whose it is; an unpinned one says it is a sum, because the sum of two
    // characters' money is a number neither of them can spend.
    const who = m.entity
      ? `<span class="pill sel">${esc(m.entity)}</span>`
      : segments.includes('*')
        ? '<span class="pill">all entities</span>'
        : '';
    const header = `<h2 style="margin-top:34px">${esc(m.label)} ${who}
        <span class="hint">${
          m.kind === 'set' ? 'set · members per flush' : m.unit === 'copper' ? 'copper · shown as gold' : m.unit
        }</span>
        <span style="margin-left:auto">
          <form method="post" action="/untrack" style="display:inline">
            <input type="hidden" name="id" value="${m.id}">
            <button type="submit" class="linkbtn" title="stop tracking this property">stop</button>
          </form>
        </span>
      </h2>`;

    const meta = metas([
      `from ${source} in <span class="mono">${esc(m.addon_file)}</span>`,
      plural(samples.length, 'sample'),
      latest ? `last flush ${when(latest.ts_ms)} (${ago(latest.ts_ms)})` : null,
      m.kind === 'set' || !latest || latest.instances <= 1 ? null : `sum of ${num(latest.instances)} values`,
    ]);

    return `<section>${header}${meta}${instanceChoices(m, file, segments)}${
      m.kind === 'set' ? setBody(m, samples, names, details) : numberBody(m, samples)
    }</section>`;
  });

  return page(
    'Tracked',
    `<h1>Tracked values</h1>
     ${metas([
       plural(metrics.length, 'property', 'properties'),
       plural(totalSamples, 'sample'),
       lastFlush ? `last flush ${ago(lastFlush)}` : 'no flushes yet',
       `<a href="/addons">add another</a>`,
     ])}
     ${bodies.join('')}
     <div class="notice" style="margin-top:30px">
       Samples are keyed by the moment the game wrote the file, so re-scanning cannot duplicate a point.
       To get a new point mid-session, <span class="mono">/reload</span> in game; otherwise each login and
       logout adds one. Equipment is a set of slot → item, so the page shows what changed per slot, not a
       single number.
     </div>`,
    { active: 'tracked', refresh: 60, ctx },
  );
}

/**
 * For an unpinned sum, what each entity contributed at the last flush, with a one-click way to
 * track one of them on its own.
 *
 * This is the answer to "gold says 17g but my character has 74s": the number is two wallets, and
 * here they are, named. Tracking one creates a separate series — the existing sum keeps its
 * history, because a series that changes meaning mid-chart is worse than no chart.
 */
function instanceChoices(m: TrackedMetricRow, file: AddonFile | undefined, segments: string[]): string {
  if (m.entity || m.kind === 'set' || !file || !segments.includes('*')) return '';
  const read = readAddon(file);
  const global = read.globals.find((g) => g.name === m.global_name);
  if (!global || !isTable(global.value)) return '';
  const rel = segments[0] === m.global_name ? segments.slice(1) : segments;
  // Only entities this path really resolves to a number: a guild roster folded in beside the
  // characters has nothing at `…["Origins*"].money`, and listing it would be a dead link.
  const keys = entityOptions(global.value, rel).filter(
    (key) => collectValues(global.value, pinEntity(rel, key)).length > 0,
  );
  if (keys.length === 0) return '';
  const items = keys
    .map((key) => {
      const value = collectValues(global.value, pinEntity(rel, key))
        .map(toNumber)
        .find((v): v is number => v !== null);
      if (value === undefined) return '';
      const shown = quantity(value, m.unit);
      return `<li><span>${esc(key)}</span><b>${shown}</b>
        <form method="post" action="/track" style="display:inline">
          <input type="hidden" name="f" value="${esc(file.id)}">
          <input type="hidden" name="path" value="${esc(encodePath(segments))}">
          <input type="hidden" name="label" value="${esc(`${m.label} · ${key}`)}">
          <input type="hidden" name="unit" value="${esc(m.unit)}">
          <input type="hidden" name="kind" value="${esc(m.kind)}">
          <input type="hidden" name="entity" value="${esc(key)}">
          <button type="submit" class="linkbtn" title="track this one on its own">track</button>
        </form></li>`;
    })
    .join('');
  return `<div class="sub" style="margin:10px 0 0">
      <b>this sum is ${keys.length} entities.</b> At the last flush, each was worth:
      <ul class="kv">${items}</ul>
      Each becomes its own series; this one keeps its history as the total.
    </div>`;
}

function numberBody(m: TrackedMetricRow, samples: TrackedSampleRow[]): string {
  const latest = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  const first = samples[0];
  const change = latest && previous ? latest.value - previous.value : 0;
  const overall = latest && first ? latest.value - first.value : 0;

  const chart = lineChart(
    samples.map((s) => ({ t: s.ts_ms, value: s.value })),
    {
      caption: `${m.label} over time`,
      format: (n) => quantity(n, m.unit),
      formatAxis: (n) => quantityAxis(n, m.unit),
      color: m.unit === 'copper' ? '#ffd166' : '#56d364',
    },
  );

  const recent = [...samples].reverse().slice(0, 12).map((s, i, arr) => {
    const prev = arr[i + 1];
    const diff = prev ? s.value - prev.value : null;
    return `<tr>
      <td class="l">${when(s.ts_ms)}</td>
      <td>${quantity(s.value, m.unit)}</td>
      <td>${diff === null ? '—' : `<span class="${diff > 0 ? 'up' : diff < 0 ? 'down' : 'sub'}">${delta(diff, m.unit)}</span>`}</td>
      <td>${num(s.instances)}</td>
    </tr>`;
  });

  return `
    ${cards([
      { k: 'current', v: latest ? quantity(latest.value, m.unit) : '—', lead: true },
      { k: 'since previous flush', v: previous ? delta(change, m.unit) : '—' },
      { k: 'since tracking began', v: first ? delta(overall, m.unit) : '—' },
      { k: 'samples', v: num(samples.length) },
    ])}
    ${section('series', chart, 'one point per SavedVariables flush')}
    ${section(
      'recent flushes',
      table(['when', 'value', 'change', 'values'], recent, { left: [0] }),
      'one row per SavedVariables flush · values is how many instances were summed',
    )}`;
}

function setBody(
  m: TrackedMetricRow,
  samples: TrackedSampleRow[],
  names: Map<number, string>,
  details: Map<number, { name: string; source: string }>,
): string {
  const latest = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  const current = parseMembers(latest?.members);
  const before = parseMembers(previous?.members);
  const diff = diffMembers(before, current);
  const equipment = looksLikeEquipment([...current, ...before].map((x) => x.k));
  const changedCount = diff.added.length + diff.removed.length + diff.changed.length;

  // The table lists the current set, plus anything that left since the previous flush — a piece of
  // gear that was replaced is the interesting event, and it would otherwise vanish from the page.
  const changedMap = new Map(diff.changed.map((c) => [c.k, c.from]));
  const addedKeys = new Set(diff.added.map((a) => a.k));
  const rows = [...current]
    .sort((a, b) => compareKeys(a.k, b.k))
    .map((member) => {
      const was = changedMap.get(member.k);
      // With a single sample nothing has a state yet: "new" would claim a change that did not happen.
      if (!previous) return memberRow(member, equipment, '<span class="sub">—</span>', names, details);
      const state = addedKeys.has(member.k)
        ? '<span class="pill ok">new</span>'
        : was
          ? `<span class="pill warn">was ${esc(equipment ? itemLabel(was, names) : was)}</span>`
          : '<span class="sub">same</span>';
      return memberRow(member, equipment, state, names, details);
    })
    .concat(diff.removed.map((member) => memberRow(member, equipment, '<span class="pill bad">removed</span>', names, details)));

  const recent = [...samples].reverse().slice(0, 12).map((s, i, arr) => {
    const prev = arr[i + 1];
    const d = prev ? diffMembers(parseMembers(prev.members), parseMembers(s.members)) : null;
    const summary = d
      ? [
          d.added.length ? `<span class="up">+${d.added.length}</span>` : '',
          d.changed.length ? `<span class="pill warn">~${d.changed.length}</span>` : '',
          d.removed.length ? `<span class="down">−${d.removed.length}</span>` : '',
        ]
          .filter(Boolean)
          .join(' ') || '<span class="sub">no change</span>'
      : '—';
    return `<tr>
      <td class="l">${when(s.ts_ms)}</td>
      <td>${num(parseMembers(s.members).length)}</td>
      <td class="l">${summary}</td>
    </tr>`;
  });

  return `
    ${cards([
      { k: equipment ? 'equipped' : 'members', v: latest ? num(current.length) : '—', lead: true },
      {
        k: 'changed at last flush',
        v: previous ? num(changedCount) : '—',
        hint: previous
          ? `${diff.added.length} new · ${diff.changed.length} swapped · ${diff.removed.length} gone`
          : undefined,
      },
      { k: 'samples', v: num(samples.length) },
      { k: 'last flush', v: latest ? ago(latest.ts_ms) : '—' },
    ])}
    ${section(
      equipment ? 'what is equipped' : 'current members',
      table(equipment ? ['slot', 'item', 'state'] : ['member', 'value', 'state'], rows, {
        left: [0, 1, 2],
        empty: 'Nothing in this set at the last flush.',
      }),
      previous ? 'state is compared with the previous flush' : 'no previous flush to compare with yet',
    )}
    ${section(
      'recent flushes',
      table(['when', 'members', 'change'], recent, { left: [0, 2] }),
      'one row per SavedVariables flush · + new · ~ swapped · − removed',
    )}
    ${
      equipment
        ? `<div class="sub" style="margin-top:10px">${nameCoverage(current, names)} Slot numbers are the
             client's inventory slots, so a swap is reported against the slot it happened in.</div>`
        : ''
    }`;
}

/** How many of the equipped items have a name, and what would fill the rest in. */
function nameCoverage(members: Member[], names: Map<number, string>): string {
  const ids = members.map((m) => itemIdFromString(m.v)).filter((id): id is number => id !== null);
  const named = ids.filter((id) => names.has(id)).length;
  if (ids.length === 0) return '';
  if (named === ids.length) return `All ${num(ids.length)} items named.`;
  const missing = ids.length - named;
  return `${num(named)} of ${num(ids.length)} items named (${num(missing)} unknown) — names are fetched once and
    cached. Fill the rest with <span class="mono">PORTALSTONE_ITEM_API</span> (any endpoint returning
    <span class="mono">{"name": "…"}</span> for <span class="mono">/{id}</span>) or with your own Blizzard
    client credentials: <span class="mono">PORTALSTONE_BNET_ID</span> and
    <span class="mono">PORTALSTONE_BNET_SECRET</span>.`;
}

function memberRow(
  member: Member,
  equipment: boolean,
  state: string,
  names: Map<number, string>,
  details: Map<number, { name: string; source: string }>,
): string {
  const key = equipment ? `${slotName(member.k)} <span class="sub">[${esc(member.k)}]</span>` : esc(member.k);
  const value = equipment ? itemLabel(member.v, names) : member.v;
  const id = equipment ? itemIdFromString(member.v) : null;
  const from = id === null ? undefined : details.get(id)?.source;
  const title = from ? ` title="name from ${esc(from)}"` : '';
  return `<tr><td class="l">${key}</td><td class="l mono"${title}>${esc(value)}</td><td class="l">${state}</td></tr>`;
}

/**
 * Dashboards: views the user builds for themselves.
 *
 * A dashboard page is a grid of cards (gridstack, vendored — no build step). Each card names a
 * data source (a metric from `dashboardData`), how to draw it, and how far back to look. Geometry
 * is drag-and-drop: the browser posts the grid to /dashboard/layout and the server stores it.
 *
 * Without JavaScript the page still renders every card in document order; the grid, the preview and
 * the layout persistence are enhancements layered on top of plain server-rendered HTML.
 */
import type { Ctx } from '../context';
import { columnChart, lineChart, pieChart } from '../charts';
import { emptyState, metas, page, section, table } from '../shell';
import { ago, esc, num, pct, plural } from '../format';
import type { DashboardCardRow } from '../../store';
import {
  DEFAULT_SIZE,
  GROUPS,
  RANGES,
  VIEWS,
  cardData,
  cardTier,
  defaultView,
  findMetric,
  formatUnit,
  formatUnitAxis,
  isCardView,
  isRange,
  metricCatalog,
  rangeLabel,
  viewFits,
  colorForUnit,
  type CardData,
  type CardView,
  type MetricDef,
} from '../dashboardData';

const CREATE_FORM = `
  <form method="post" action="/dashboards/create">
    <div class="field"><label for="name">name</label>
      <input type="text" id="name" name="name" maxlength="60" placeholder="e.g. levelling, raid night" required></div>
    <div style="margin-top:10px">
      <button type="submit" class="primary">create dashboard</button>
    </div>
  </form>
  <form method="post" action="/dashboards/example" style="margin-top:10px">
    <button type="submit" class="linkbtn">or start from the example</button>
  </form>`;

/**
 * The drawing area of a card in pixels, from its grid cells. The grid is ~87 px per column at the
 * page's width and 92 px per row; subtracting the header and padding gives the space the chart
 * actually has. Rendering at this aspect ratio means the SVG scales to fill the card instead of
 * letterboxing or overflowing it.
 */
function chartSize(w: number, h: number): { width: number; height: number } {
  return { width: Math.max(240, Math.round(w * 87)), height: Math.max(110, Math.round(h * 92) - 52) };
}

export function renderDashboards(ctx: Ctx): string {
  const dashboards = ctx.store.dashboards();
  const totalCards = dashboards.reduce((sum, d) => sum + d.cards, 0);

  const body = dashboards.length === 0
    ? `<h1>Dashboards</h1>
       ${metas(['none yet'])}
       ${emptyState(
         'No dashboards yet.',
         'A dashboard is a grid of cards; each card picks a piece of your data and how to draw it — a static value, bars, a pie, a line over time, or a table.',
       )}
       <div class="row" style="margin-top:20px">
         <div class="col" style="max-width:420px">${section('create one', CREATE_FORM)}</div>
         <div class="col">
           <div class="notice">The example dashboard is a starting point, not a template: it arrives with
             a damage trend, where your time went, kills per session and one more card, and every card
             can be removed, edited, dragged or resized. Your sessions are already in here — nothing
             has to be configured first.</div>
         </div>
       </div>`
    : `<h1>Dashboards</h1>
       ${metas([
         plural(dashboards.length, 'dashboard'),
         plural(totalCards, 'card'),
         'cards are editable, draggable and resizable',
       ])}
       <div class="row" style="margin-top:16px">
         <div class="col">
           ${table(
             ['name', 'cards', 'updated', ''],
             dashboards.map(
               (d) => `<tr>
                 <td class="l"><a href="/dashboard?id=${d.id}">${esc(d.name)}</a></td>
                 <td>${num(d.cards)}</td>
                 <td class="l sub">${d.updated_ms ? ago(d.updated_ms) : '—'}</td>
                 <td><form method="post" action="/dashboard/delete">
                   <input type="hidden" name="id" value="${d.id}">
                   <button type="submit" class="linkbtn" title="delete this dashboard and its cards">delete</button>
                 </form></td>
               </tr>`,
             ),
             { left: [0, 2], empty: 'No dashboards yet.' },
           )}
         </div>
         <div class="col" style="max-width:360px">${section('new dashboard', CREATE_FORM)}</div>
       </div>`;

  return page('Dashboards', body, { active: 'dashboards', ctx });
}

export function renderDashboard(ctx: Ctx, id: number): string | null {
  const dashboard = ctx.store.dashboard(id);
  if (!dashboard) return null;
  const cards = ctx.store.dashboardCards(id);

  const grid = cards.length === 0
    ? emptyState(
        'This dashboard has no cards yet.',
        `Add a <a href="/dashboard/card?id=${id}">card</a> and choose what it should show.`,
      )
    : `<div class="grid-stack" id="dash-grid" data-dashboard="${id}">
         ${cards.map((card) => renderGridCard(ctx, card)).join('')}
       </div>`;

  const body = `
    <div class="crumbs"><a href="/dashboards">dashboards</a> <span>/</span> ${esc(dashboard.name)}</div>
    <h1>${esc(dashboard.name)}</h1>
    ${metas([
      plural(cards.length, 'card'),
      `updated ${ago(dashboard.updated_ms)}`,
      `<a href="/dashboard/card?id=${id}">add a card</a>`,
    ])}
    ${
      cards.length
        ? `<div class="dash-toolbar">
             <span class="sub" id="dash-status">drag a card by <span class="grab-inline">⠿</span> to move it,
             drag its bottom-right corner to resize · the layout saves itself</span>
           </div>`
        : ''
    }
    ${grid}
    <div class="row" style="margin-top:34px">
      <div class="col">
        ${section(
          'rename',
          `<form method="post" action="/dashboard/rename">
             <input type="hidden" name="id" value="${id}">
             <div class="field"><label for="rename">dashboard name</label>
               <input type="text" id="rename" name="name" maxlength="60" value="${esc(dashboard.name)}" required></div>
             <div style="margin-top:10px"><button type="submit" class="linkbtn">save name</button></div>
           </form>`,
        )}
      </div>
      <div class="col">
        ${section(
          'delete',
          `<form method="post" action="/dashboard/delete">
             <input type="hidden" name="id" value="${id}">
             <div class="sub">Removes this dashboard and its cards. Combat history, tracked values and
               bag drops are untouched; only the arrangement goes.</div>
             <div style="margin-top:10px"><button type="submit" class="linkbtn">delete this dashboard</button></div>
           </form>`,
        )}
      </div>
    </div>`;

  return page(dashboard.name, body, {
    active: 'dashboards',
    ctx,
    styles: ['/vendor/gridstack/gridstack.min.css', '/assets/dashboard.css'],
    scripts: ['/vendor/gridstack/gridstack-all.js', '/assets/dashboard.js'],
  });
}

/* -------------------------------------------------------------------------------------------
 * Card forms: one renderer for add and edit, with a live preview.
 * ----------------------------------------------------------------------------------------- */

export interface CardFormValues {
  metric: string;
  view: string;
  rangeMinutes: number;
  title: string;
  w: number;
  h: number;
}

export interface CardFormOptions {
  error?: string;
  values?: Partial<CardFormValues>;
}

export function renderAddCard(ctx: Ctx, dashboardId: number, opts: CardFormOptions = {}): string | null {
  const dashboard = ctx.store.dashboard(dashboardId);
  if (!dashboard) return null;

  const values: CardFormValues = {
    metric: opts.values?.metric ?? '',
    view: opts.values?.view ?? 'bar',
    rangeMinutes: opts.values?.rangeMinutes ?? 0,
    title: opts.values?.title ?? '',
    w: opts.values?.w ?? 6,
    h: opts.values?.h ?? 3,
  };

  return renderCardForm(ctx, {
    heading: 'Add a card',
    crumb: `<a href="/dashboard?id=${dashboardId}">${esc(dashboard.name)}</a> <span>/</span> add a card`,
    action: '/dashboard/card/add',
    hidden: `<input type="hidden" name="dashboard" value="${dashboardId}">`,
    submit: 'add card',
    cancel: `/dashboard?id=${dashboardId}`,
    values,
    ...(opts.error ? { error: opts.error } : {}),
    dashboardId,
    mode: 'add',
  });
}

export function renderEditCard(ctx: Ctx, cardId: number, opts: CardFormOptions = {}): string | null {
  const card = ctx.store.dashboardCard(cardId);
  if (!card) return null;
  const dashboard = ctx.store.dashboard(card.dashboard_id);
  if (!dashboard) return null;

  const values: CardFormValues = {
    metric: opts.values?.metric ?? card.metric,
    view: opts.values?.view ?? card.view,
    rangeMinutes: opts.values?.rangeMinutes ?? card.range_minutes,
    title: opts.values?.title ?? card.title,
    w: opts.values?.w ?? card.w,
    h: opts.values?.h ?? card.h,
  };

  return renderCardForm(ctx, {
    heading: 'Edit card',
    crumb: `<a href="/dashboard?id=${dashboard.id}">${esc(dashboard.name)}</a> <span>/</span> edit card`,
    action: '/dashboard/card/update',
    hidden: `<input type="hidden" name="id" value="${card.id}">
             <input type="hidden" name="dashboard" value="${dashboard.id}">`,
    submit: 'save card',
    cancel: `/dashboard?id=${dashboard.id}`,
    values,
    ...(opts.error ? { error: opts.error } : {}),
    dashboardId: dashboard.id,
    mode: 'edit',
  });
}

interface CardFormPage {
  heading: string;
  crumb: string;
  action: string;
  hidden: string;
  submit: string;
  cancel: string;
  values: CardFormValues;
  error?: string;
  dashboardId: number;
  mode: 'add' | 'edit';
}

function renderCardForm(ctx: Ctx, form: CardFormPage): string {
  const catalog = metricCatalog(ctx.store);
  const byGroup = new Map<string, MetricDef[]>();
  for (const metric of catalog) byGroup.set(metric.group, [...(byGroup.get(metric.group) ?? []), metric]);

  const options = GROUPS.filter((g) => (byGroup.get(g.id)?.length ?? 0) > 0)
    .map(
      (group) => `<optgroup label="${esc(group.label)}">${(byGroup.get(group.id) ?? [])
        .map(
          (m) =>
            `<option value="${esc(m.id)}"${m.id === form.values.metric ? ' selected' : ''}>${esc(m.label)} — ${
              m.shape === 'time' ? 'over time' : 'by category'
            }</option>`,
        )
        .join('')}</optgroup>`,
    )
    .join('');

  const trackedCount = byGroup.get('tracked')?.length ?? 0;
  const preview = form.values.metric
    ? previewCard(ctx, form.values)
    : '<div class="empty" id="preview-placeholder">Pick a data source to see the card here.</div>';

  const body = `
    <div class="crumbs"><a href="/dashboards">dashboards</a> <span>/</span> ${form.crumb}</div>
    <h1>${esc(form.heading)}</h1>
    ${metas(['pick the data, the display and the window — the preview updates as you change them'])}
    ${form.error ? `<div class="notice warn">${esc(form.error)}</div>` : ''}
    <div class="card-form-layout">
      <form method="post" action="${form.action}" id="card-form" data-mode="${form.mode}"
            data-defaults="${esc(JSON.stringify(DEFAULT_SIZE))}">
        ${form.hidden}
        <input type="hidden" name="w" value="${form.values.w}">
        <input type="hidden" name="h" value="${form.values.h}">
        <div class="form" style="display:block">
          <div class="field" style="margin-bottom:12px">
            <label for="metric">data</label>
            <select id="metric" name="metric" required>
              <option value=""${form.values.metric === '' ? ' selected' : ''}>choose a data source…</option>
              ${options}
            </select>
          </div>
          <div class="field" style="margin-bottom:12px">
            <label for="view">display</label>
            <select id="view" name="view">
              ${VIEWS.map(
                (v) =>
                  `<option value="${v.id}"${v.id === form.values.view ? ' selected' : ''}>${esc(v.label)} — ${esc(v.hint)}</option>`,
              ).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:12px">
            <label for="range">time window</label>
            <select id="range" name="range">
              ${RANGES.map(
                (r) =>
                  `<option value="${r.minutes}"${r.minutes === form.values.rangeMinutes ? ' selected' : ''}>${esc(r.label)}</option>`,
              ).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:12px">
            <label for="title">title (optional)</label>
            <input type="text" id="title" name="title" maxlength="80" value="${esc(form.values.title)}"
                   placeholder="defaults to the data source">
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:14px">
          <button type="submit" class="primary">${esc(form.submit)}</button>
          <a href="${form.cancel}" class="sub">cancel</a>
        </div>
      </form>
      <div class="preview-wrap">
        <div class="preview-head">
          <span>preview</span>
          <span class="sub">updates as you change the form</span>
        </div>
        <div id="card-preview" data-dashboard="${form.dashboardId}">${preview}</div>
      </div>
    </div>
    <div class="notice" style="margin-top:24px">
      <b>line</b> only fits a metric measured over time; <b>pie</b> only fits one split into categories.
      <b>bar</b>, <b>static value</b> and <b>table</b> fit both. If the pairing does not make sense the
      card says so rather than drawing something misleading.
      The size is set by dragging the card's corner on the dashboard; a new card starts at a sensible
      size for its display.
      ${
        trackedCount === 0
          ? `<div class="sub" style="margin-top:8px">No tracked addon values yet. Track one on
               <a href="/addons">addons</a> and it appears in the list above.</div>`
          : ''
      }
    </div>`;

  return page(form.heading, body, {
    active: 'dashboards',
    ctx,
    styles: ['/assets/dashboard.css'],
    scripts: ['/assets/dashboard.js'],
  });
}

/** Normalised values from a query string or form, shared by the form and the preview endpoint. */
export function cardValuesFrom(input: {
  metric?: string | null;
  view?: string | null;
  range?: string | number | null;
  title?: string | null;
  w?: string | number | null;
  h?: string | number | null;
}): CardFormValues {
  const range = Number(input.range ?? 0);
  const w = Number(input.w ?? 0);
  const h = Number(input.h ?? 0);
  return {
    metric: (input.metric ?? '').trim().slice(0, 120),
    view: (input.view ?? '').trim(),
    rangeMinutes: Number.isInteger(range) && isRange(range) ? range : 0,
    title: (input.title ?? '').trim().slice(0, 80),
    w: Number.isInteger(w) && w >= 1 && w <= 12 ? w : 6,
    h: Number.isInteger(h) && h >= 1 && h <= 40 ? h : 3,
  };
}

/** The preview endpoint's body: one card, no tools. Null when the metric is unknown. */
export function renderPreview(ctx: Ctx, values: CardFormValues): string | null {
  if (!values.metric) return null;
  const metric = findMetric(ctx.store, values.metric);
  if (!metric) return null;
  return previewCard(ctx, values);
}

function previewCard(ctx: Ctx, values: CardFormValues): string {
  const metric = findMetric(ctx.store, values.metric);
  if (!metric) return '<div class="empty">That data source no longer exists.</div>';

  const view: CardView = isCardView(values.view) ? values.view : defaultView(metric.shape);
  const effective = viewFits(metric.shape, view) ? view : defaultView(metric.shape);
  const data = cardData(ctx.store, metric, values.rangeMinutes, Date.now(), ctx.character);
  const title = values.title || metric.label;
  const tier = cardTier(values.w, values.h);
  return `<section class="dash-card preview-card size-${tier}${values.w >= 9 ? ' wide' : ''}" style="--preview-w:${values.w}">
    <div class="dash-hd">
      <span class="t">${esc(title)}</span>
      <span class="pill view-pill">${esc(effective)}</span>
      ${values.rangeMinutes > 0 ? `<span class="pill range">${esc(rangeLabel(values.rangeMinutes, true))}</span>` : ''}
      ${view !== effective ? '<span class="pill warn">view coerced</span>' : ''}
    </div>
    <div class="dash-body">${cardBody(data, effective, values.w, values.h)}</div>
  </section>`;
}

/* -------------------------------------------------------------------------------------------
 * One card on a dashboard.
 * ----------------------------------------------------------------------------------------- */

function renderGridCard(ctx: Ctx, card: DashboardCardRow): string {
  const attrs = [
    `gs-id="${card.id}"`,
    card.x >= 0 ? `gs-x="${card.x}"` : '',
    card.y >= 0 ? `gs-y="${card.y}"` : '',
    `gs-w="${card.w}"`,
    `gs-h="${card.h}"`,
  ]
    .filter(Boolean)
    .join(' ');

  return `<div class="grid-stack-item" ${attrs} gs-min-w="2" gs-min-h="2">
      <div class="grid-stack-item-content">${renderCardSection(ctx, card, card.w, card.h)}</div>
    </div>`;
}

/**
 * One card's markup for a given cell size. The layout is chosen from w/h, not from the stored row:
 * the resize handler asks for the same card at its new size so charts and tables re-fit without a
 * page reload.
 */
export function renderCardBody(ctx: Ctx, cardId: number, w?: number, h?: number): string | null {
  const card = ctx.store.dashboardCard(cardId);
  if (!card) return null;
  const width = Math.min(12, Math.max(1, Math.round(w ?? card.w)));
  const height = Math.min(40, Math.max(1, Math.round(h ?? card.h)));
  return renderCardSection(ctx, card, width, height);
}

function renderCardSection(ctx: Ctx, card: DashboardCardRow, w: number, h: number): string {
  const metric = findMetric(ctx.store, card.metric);
  const storedView = isCardView(card.view) ? card.view : null;
  const view: CardView = storedView ?? (metric ? defaultView(metric.shape) : 'bar');
  const title = card.title || metric?.label || card.metric;
  const coerced = metric ? !viewFits(metric.shape, view) : false;
  const effective: CardView = metric && coerced ? defaultView(metric.shape) : view;
  const range = card.range_minutes > 0 ? card.range_minutes : 0;
  const tier = cardTier(w, h);

  const head = `<div class="dash-hd">
      <span class="grab" title="drag to move">⠿</span>
      <span class="t" title="${esc(metric?.description ?? card.metric)}">${esc(title)}</span>
      <span class="pill view-pill">${esc(effective)}</span>
      ${range > 0 ? `<span class="pill range" title="${esc(rangeLabel(range))}">${esc(rangeLabel(range, true))}</span>` : ''}
      <span class="dash-tools">
        <a class="linkbtn" href="/dashboard/card/edit?id=${card.id}" title="edit this card">edit</a>
        <form method="post" action="/dashboard/card/remove">
          <input type="hidden" name="id" value="${card.id}">
          <input type="hidden" name="dashboard" value="${card.dashboard_id}">
          <button type="submit" class="linkbtn" title="remove this card">remove</button>
        </form>
      </span>
    </div>`;

  let body: string;
  if (!metric) {
    body = `<div class="empty">This card reads <span class="mono">${esc(card.metric)}</span>, which no longer exists — the tracked value behind it was removed. Remove the card, or track a value again to give it a history.</div>`;
  } else {
    const data = cardData(ctx.store, metric, range, Date.now(), ctx.character);
    body = `${coerced ? `<div class="notice warn" style="margin:8px 0">${esc(view)} does not fit a ${
      metric.shape === 'time' ? 'metric measured over time' : 'metric split into categories'
    } — showing ${esc(VIEWS.find((v) => v.id === effective)?.label ?? effective)} instead.</div>` : ''}
      ${cardBody(data, effective, w, h)}`;
  }

  return `<section class="dash-card size-${tier}${w >= 9 ? ' wide' : ''}" data-w="${w}" data-h="${h}">${head}<div class="dash-body">${body}</div></section>`;
}

function cardBody(data: CardData, view: CardView, w: number, h: number): string {
  const unit = data.metric.unit;
  const { width, height } = chartSize(w, h);
  const caption = data.metric.label;

  if (data.points.length === 0) {
    return `<div class="empty">Nothing recorded${
      data.rangeMinutes > 0 ? ` in ${esc(rangeLabel(data.rangeMinutes))}` : ''
    }.</div>`;
  }

  switch (view) {
    case 'stat':
      return statBody(data);
    case 'line':
      return lineChart(
        data.points.map((p) => ({ t: p.ts ?? 0, value: p.value })),
        {
          width,
          height,
          caption,
          format: (n) => formatUnit(n, unit),
          formatAxis: (n) => formatUnitAxis(n, unit),
          color: colorForUnit(unit),
        },
      );
    case 'pie':
      return pieChart(
        data.points.map((p) => ({ label: p.label, value: p.value, kind: p.kind, title: p.title })),
        { width, height, caption, format: (n) => formatUnit(n, unit) },
      );
    case 'table':
      return tableBody(data, w, h);
    case 'bar':
    default:
      return columnChart(
        data.points.map((p) => ({
          label: shortLabel(p.label),
          value: p.value,
          kind: p.kind ?? (unit === 'healing' ? 'healing' : unit === 'damage' ? 'damage' : undefined),
          href: p.href,
          title: p.title ?? `${p.label}: ${formatUnit(p.value, unit)}`,
        })),
        { width, height, caption },
      );
  }
}

function statBody(data: CardData): string {
  const range = data.rangeMinutes > 0 ? ` · ${rangeLabel(data.rangeMinutes)}` : '';

  if (data.metric.shape === 'time') {
    const latest = data.latest ?? 0;
    const previous = data.previous;
    const change = previous === null ? null : latest - previous;
    const changeText =
      change === null
        ? ''
        : change === 0
          ? ' · no change since the previous point'
          : ` · ${change > 0 ? '+' : '−'}${formatUnit(Math.abs(change), data.metric.unit)} since the previous point`;
    return `<div class="dash-stat">${formatUnit(latest, data.metric.unit)}</div>
      <div class="sub">latest of ${plural(data.points.length, 'point')}${range}${changeText}</div>`;
  }

  const top = data.points[0]!;
  return `<div class="dash-stat">${formatUnit(data.total, data.metric.unit)}</div>
    <div class="sub">across ${plural(data.points.length, 'category', 'categories')}${range} ·
      ${esc(top.label)} is ${pct(top.value, data.total)}</div>`;
}

function tableBody(data: CardData, w: number, h: number): string {
  const time = data.metric.shape === 'time';
  // A narrow card drops the share column rather than forcing a horizontal scrollbar; a short card
  // shows fewer rows than it could ever scroll to.
  const withShare = !time && w >= 5;
  const rowBudget = Math.floor((h * 92 - 92) / 27);
  const limit = Math.max(2, Math.min(40, rowBudget));
  const shown = data.points.slice(0, limit);
  const rows = shown.map((p) => {
    const label = time ? (p.title ?? p.label) : p.label;
    return `<tr><td class="l">${
      p.href ? `<a href="${esc(p.href)}">${esc(label)}</a>` : esc(label)
    }</td><td>${formatUnit(p.value, data.metric.unit)}</td>${
      withShare ? `<td>${pct(p.value, data.total)}</td>` : ''
    }</tr>`;
  });
  const more =
    data.points.length > shown.length
      ? `<div class="sub" style="margin-top:6px">showing ${num(shown.length)} of ${num(data.points.length)} rows</div>`
      : '';
  const head = time ? ['when', 'value'] : withShare ? ['label', 'value', 'share'] : ['label', 'value'];
  return (
    table(head, rows, {
      left: [0],
      empty: 'Nothing recorded for this yet.',
    }) + more
  );
}

/** A long zone name eats a bar chart's axis; the tooltip keeps the whole thing. */
function shortLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import {
  cardData,
  cardTier,
  createExampleDashboard,
  findMetric,
  isCardView,
  metricCatalog,
  metricScope,
  rangeLabel,
  rangeStart,
  viewFits,
  viewsFor,
} from '../src/ui/dashboardData';
import {
  cardValuesFrom,
  renderAddCard,
  renderCardBody,
  renderDashboard,
  renderDashboards,
  renderEditCard,
  renderPreview,
} from '../src/ui/pages/dashboard';
import { resolveScope, type Ctx } from '../src/ui/context';
import type { BagSnapshot } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-dash-'));
const open: Store[] = [];

function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function bag(over: Partial<BagSnapshot> = {}): BagSnapshot {
  return {
    damageDone: 0,
    damageTaken: 0,
    healingDone: 0,
    overheal: 0,
    hits: 0,
    crits: 0,
    casts: 0,
    interrupts: 0,
    kills: 0,
    fieldKills: 0,
    deaths: 0,
    myDeaths: 0,
    playersDied: 0,
    durationS: 0,
    engagedS: 0,
    dps: 0,
    dpsEngaged: 0,
    hps: 0,
    topAbilities: [],
    topHealing: [],
    topDamageTaken: [],
    topCasts: [],
    misses: [],
    castFailures: [],
    topKills: [],
    pvpKills: [],
    pvpDeaths: [],
    yourDeaths: [],
    ...over,
  };
}

/** Two zone visits per session: one open-world, one dungeon, with different numbers. */
function snapshot(over: { startMs?: number; damage?: number } = {}): SessionSnapshot {
  const start = over.startMs ?? 1_000_000;
  const damage = over.damage ?? 9500;
  const zones: SessionSnapshot['zones'] = [
    {
      zoneId: 1,
      name: 'The Barrens',
      kind: 'zone',
      startMs: start,
      endMs: start + 60_000,
      ...bag({ damageDone: 500, damageTaken: 100, durationS: 60, engagedS: 40, kills: 2, myDeaths: 0 }),
    },
    {
      zoneId: 47,
      name: 'Razorfen Kraul',
      kind: 'dungeon',
      startMs: start + 60_000,
      endMs: start + 600_000,
      ...bag({
        damageDone: 9000,
        damageTaken: 2500,
        healingDone: 3000,
        durationS: 540,
        engagedS: 300,
        kills: 5,
        myDeaths: 1,
        casts: 120,
      }),
    },
  ];
  return {
    startMs: start,
    endMs: start + 600_000,
    startByte: 0,
    offsetMin: -420,
    zoneId: 47,
    zoneName: 'Razorfen Kraul',
    zones,
    open: bag({
      damageDone: damage,
      damageTaken: 2600,
      healingDone: 3000,
      durationS: 600,
      engagedS: 340,
      kills: 7,
      myDeaths: 1,
      casts: 120,
    }),
    encounters: [],
  };
}

function seed(s: Store): void {
  s.replaceSessionsFrom('/logs/a.txt', 0, [snapshot(), snapshot({ startMs: 2_000_000, damage: 5000 })], {
    guid: 'Player-1',
    name: 'Slouch',
  });
}

function ctxFor(s: Store, character: string | null = null): Ctx {
  return {
    store: s,
    installs: [],
    lastScan: { at: 0, entries: 0, errors: 0 },
    dbPath: ':memory:',
    ...resolveScope(s, character),
  };
}

describe('dashboards: storage', () => {
  it('creates, lists and renames a dashboard', () => {
    const s = store();
    const id = s.createDashboard('Farm');
    s.createDashboard('Raid night');
    expect(s.dashboards().map((d) => [d.name, d.cards])).toEqual([
      ['Farm', 0],
      ['Raid night', 0],
    ]);
    s.renameDashboard(id, 'Levelling');
    expect(s.dashboard(id)!.name).toBe('Levelling');
  });

  it('keeps cards in the order they were added, and removes them one at a time', () => {
    const s = store();
    const id = s.createDashboard('Mixed');
    const a = s.addDashboardCard({ dashboardId: id, metric: 'session_damage', title: 'one', view: 'line', span: 2 });
    const b = s.addDashboardCard({ dashboardId: id, metric: 'zone_kills', title: 'two', view: 'bar' });

    expect(s.dashboardCards(id).map((c) => [c.id, c.position, c.span])).toEqual([
      [a, 0, 2],
      [b, 1, 1],
    ]);
    expect(s.removeDashboardCard(a)).toBe(id);
    expect(s.dashboardCards(id).map((c) => c.id)).toEqual([b]);
    expect(s.removeDashboardCard(9999)).toBe(0);
  });

  it('deletes every card with its dashboard', () => {
    const s = store();
    const id = s.createDashboard('Temporary');
    s.addDashboardCard({ dashboardId: id, metric: 'session_damage', title: '', view: 'line' });
    s.deleteDashboard(id);
    expect(s.dashboard(id)).toBeUndefined();
    expect(s.dashboardCards(id)).toEqual([]);
    expect(s.dashboards()).toEqual([]);
  });
});

describe('dashboards: data', () => {
  it('adds zone visits up per zone, across sessions', () => {
    const s = store();
    seed(s);
    const zones = new Map(s.zoneAggregates().map((z) => [z.zone_name, z]));
    expect(zones.get('Razorfen Kraul')!.runs).toBe(2);
    expect(zones.get('Razorfen Kraul')!.damage_done).toBe(18_000);
    expect(zones.get('The Barrens')!.duration_s).toBe(120);
    expect(zones.get('Razorfen Kraul')!.kind).toBe('dungeon');
  });

  it('orders splits largest first and time series oldest first', () => {
    const s = store();
    seed(s);

    const byZone = cardData(s, findMetric(s, 'zone_damage')!);
    expect(byZone.points.map((p) => [p.label, p.value])).toEqual([
      ['Razorfen Kraul', 18_000],
      ['The Barrens', 1_000],
    ]);
    expect(byZone.total).toBe(19_000);

    const perSession = cardData(s, findMetric(s, 'session_damage')!);
    expect(perSession.points.map((p) => p.value)).toEqual([9500, 5000]);
    expect(perSession.latest).toBe(5000);
    expect(perSession.previous).toBe(9500);
    expect(perSession.total).toBe(14_500);
  });

  it('turns a tracked numeric property into a time series', () => {
    const s = store();
    const metricId = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BagBrother',
      path: ['money'],
      label: 'gold',
      unit: 'copper',
    });
    s.recordSample({ metricId, tsMs: 1_000, value: 100, instances: 1, minValue: null, maxValue: null, sourceFile: 'f', sourceMtimeMs: 1 });
    s.recordSample({ metricId, tsMs: 2_000, value: 250, instances: 1, minValue: null, maxValue: null, sourceFile: 'f', sourceMtimeMs: 2 });

    const metric = findMetric(s, `tracked:${metricId}`);
    expect(metric?.shape).toBe('time');
    expect(metric?.unit).toBe('copper');
    const data = cardData(s, metric!);
    expect(data.points.map((p) => p.value)).toEqual([100, 250]);
    expect(data.latest).toBe(250);
  });

  it('scopes a tracked series to the chosen character: a pinned one shows only on its own page', () => {
    const s = store();
    s.replaceSessionsFrom('/logs/main.txt', 0, [snapshot()], { guid: 'Player-1', name: 'Dead-Sadfatkid-PvP-US' });
    s.replaceSessionsFrom('/logs/alt.txt', 0, [snapshot({ startMs: 2_000_000 })], { guid: 'Player-2', name: 'Slouch-Mage-PvP-US' });
    const metricId = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', '*', 'money'],
      label: 'Gold · Dead Sadfatkid',
      unit: 'copper',
      entity: 'Dead Sadfatkid',
    });
    s.recordSample({ metricId, tsMs: 1_000, value: 4200, instances: 1, minValue: null, maxValue: null, sourceFile: 'f', sourceMtimeMs: 1 });
    const metric = findMetric(s, `tracked:${metricId}`)!;

    // Unscoped and on the owner's page the value is there; the other character's page shows nothing,
    // rather than one character's gold under another's name.
    expect(cardData(s, metric, 0, Date.now(), null).latest).toBe(4200);
    const owner = metricScope('Player-1', 'Dead-Sadfatkid-PvP-US', 'Player-1', []);
    const other = metricScope('Player-2', 'Slouch-Mage-PvP-US', 'Player-2', []);
    expect(cardData(s, metric, 0, Date.now(), owner).latest).toBe(4200);
    expect(cardData(s, metric, 0, Date.now(), other).points).toHaveLength(0);
  });

  it('leaves tracked sets out of the catalogue: a set has no single number to chart', () => {
    const s = store();
    s.addTrackedMetric({ addonFile: 'f.lua', globalName: 'G', path: ['gear'], label: 'gear', unit: 'plain', kind: 'set' });
    expect(metricCatalog(s).some((m) => m.group === 'tracked')).toBe(false);
  });

  it('only offers views that make sense for a shape', () => {
    expect(viewsFor('time')).toEqual(['stat', 'line', 'bar', 'table']);
    expect(viewsFor('split')).toEqual(['stat', 'bar', 'pie', 'table']);
    expect(viewFits('time', 'line')).toBe(true);
    expect(viewFits('time', 'pie')).toBe(false);
    expect(viewFits('split', 'pie')).toBe(true);
    expect(viewFits('split', 'line')).toBe(false);
    expect(viewFits('split', 'bar')).toBe(true);
    expect(isCardView('pie')).toBe(true);
    expect(isCardView('doughnut')).toBe(false);
  });
});

describe('dashboards: pages', () => {
  it('offers creation when no dashboard exists yet', () => {
    const s = store();
    const html = renderDashboards(ctxFor(s));
    expect(html).toContain('No dashboards yet');
    expect(html).toContain('action="/dashboards/create"');
    expect(html).toContain('action="/dashboards/example"');
  });

  it('renders every card, with the chart its view names', () => {
    const s = store();
    seed(s);
    const id = s.createDashboard('Mine');
    s.addDashboardCard({ dashboardId: id, metric: 'session_damage', title: 'damage trend', view: 'line', span: 2 });
    s.addDashboardCard({ dashboardId: id, metric: 'zone_damage', title: 'by zone', view: 'pie' });
    s.addDashboardCard({ dashboardId: id, metric: 'zone_kills', title: 'kills', view: 'bar' });
    s.addDashboardCard({ dashboardId: id, metric: 'zone_time', title: 'time', view: 'table' });
    s.addDashboardCard({ dashboardId: id, metric: 'zone_runs', title: 'runs', view: 'stat' });
    s.addDashboardCard({ dashboardId: id, metric: 'session_kills', title: 'kill trend', view: 'bar' });

    const html = renderDashboard(ctxFor(s), id)!;
    expect(html).toContain('damage trend');
    expect(html).toContain('dash-card size-md wide');
    expect(html.match(/class="slice"/g)).toHaveLength(2);
    expect(html).toContain('Razorfen Kraul');
    // the bar card links each column back to the session it came from
    expect(html).toContain('/session?id=1');
    expect(html).toContain('action="/dashboard/card/remove"');
  });

  it('renders the add-card form with both shapes and the tracked hint', () => {
    const s = store();
    const id = s.createDashboard('Mine');
    const html = renderAddCard(ctxFor(s), id)!;
    expect(html).toContain('over time');
    expect(html).toContain('by category');
    expect(html).toContain('No tracked addon values yet');
    expect(html).toContain('action="/dashboard/card/add"');
    expect(html).toContain('value="pie"');
    expect(renderAddCard(ctxFor(s), 999)).toBeNull();
  });

  it('shows a card that reads a removed tracked value instead of failing the page', () => {
    const s = store();
    const id = s.createDashboard('Mine');
    s.addDashboardCard({ dashboardId: id, metric: 'tracked:424242', title: 'gone', view: 'line' });
    const html = renderDashboard(ctxFor(s), id)!;
    expect(html).toContain('no longer exists');
    expect(html).toContain('tracked:424242');
  });

  it('coerces a view that does not fit the metric and says so', () => {
    const s = store();
    seed(s);
    const id = s.createDashboard('Mine');
    s.addDashboardCard({ dashboardId: id, metric: 'zone_kills', title: 'kills', view: 'line' });
    const html = renderDashboard(ctxFor(s), id)!;
    expect(html).toContain('does not fit');
    expect(html).not.toContain('<path d="M');
  });

  it('escapes a card title rather than injecting markup', () => {
    const s = store();
    const id = s.createDashboard('Mine');
    s.addDashboardCard({ dashboardId: id, metric: 'zone_kills', title: '<b>x</b>', view: 'bar' });
    const html = renderDashboard(ctxFor(s), id)!;
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('reports a missing dashboard as null so the router can 404 it', () => {
    expect(renderDashboard(ctxFor(store()), 123)).toBeNull();
  });
});

describe('dashboards: edits and layout', () => {
  it('edits a card in place without touching its geometry', () => {
    const s = store();
    const id = s.createDashboard('Mine');
    const cardId = s.addDashboardCard({
      dashboardId: id,
      metric: 'session_damage',
      title: 'trend',
      view: 'line',
      w: 12,
      h: 4,
      rangeMinutes: 0,
    });
    s.saveDashboardLayout(id, [{ id: cardId, x: 3, y: 2, w: 9, h: 5 }]);
    s.updateDashboardCard(cardId, {
      title: 'kills instead',
      metric: 'session_kills',
      view: 'bar',
      rangeMinutes: 1440,
    });

    const card = s.dashboardCard(cardId)!;
    expect(card).toMatchObject({
      title: 'kills instead',
      metric: 'session_kills',
      view: 'bar',
      range_minutes: 1440,
      x: 3,
      y: 2,
      w: 9,
      h: 5,
    });
    expect(s.updateDashboardCard(9999, { title: '', metric: 'x', view: 'bar', rangeMinutes: 0 })).toBe(0);
  });

  it('saves a layout only for cards that belong to that dashboard', () => {
    const s = store();
    const mine = s.createDashboard('Mine');
    const other = s.createDashboard('Other');
    const myCard = s.addDashboardCard({ dashboardId: mine, metric: 'zone_kills', title: '', view: 'bar' });
    const theirCard = s.addDashboardCard({ dashboardId: other, metric: 'zone_kills', title: '', view: 'bar' });

    const saved = s.saveDashboardLayout(mine, [
      { id: myCard, x: 6, y: 4, w: 6, h: 3 },
      { id: theirCard, x: 0, y: 0, w: 12, h: 1 },
      { id: myCard, x: 99, y: -5, w: 99, h: 0 },
    ]);
    expect(saved).toBe(2); // the same card twice, clamped
    expect(s.dashboardCard(myCard)).toMatchObject({ x: 11, y: 0, w: 12, h: 1 });
    expect(s.dashboardCard(theirCard)).toMatchObject({ x: -1, y: -1, w: 6, h: 3 });
  });

  it('renders a gridstack item with the stored geometry and an edit link', () => {
    const s = store();
    seed(s);
    const id = s.createDashboard('Mine');
    const cardId = s.addDashboardCard({
      dashboardId: id,
      metric: 'session_damage',
      title: 'trend',
      view: 'line',
      w: 12,
      h: 3,
      rangeMinutes: 10080,
    });
    s.saveDashboardLayout(id, [{ id: cardId, x: 0, y: 0, w: 12, h: 3 }]);
    const html = renderDashboard(ctxFor(s), id)!;
    expect(html).toContain('class="grid-stack"');
    expect(html).toContain('gs-w="12"');
    expect(html).toContain('gs-x="0"');
    expect(html).toContain(`/dashboard/card/edit?id=${cardId}`);
    expect(html).toContain('7d');
    expect(html).toContain('/vendor/gridstack/gridstack-all.js');
    expect(html).toContain('/assets/dashboard.js');
  });
});

describe('dashboards: time windows', () => {
  it('filters sessions to the window and keeps the newest when the window is off', () => {
    const s = store();
    const now = Date.now();
    s.replaceSessionsFrom(
      '/logs/w.txt',
      0,
      [snapshot({ startMs: now - 2 * 3_600_000 }), snapshot({ startMs: now - 10 * 60_000, damage: 5000 })],
      { guid: 'Player-1', name: 'Slouch' },
    );

    const metric = findMetric(s, 'session_damage')!;
    expect(cardData(s, metric, 0, now).points).toHaveLength(2);
    expect(cardData(s, metric, 60, now).points).toHaveLength(1);
    expect(cardData(s, metric, 60, now).rangeMinutes).toBe(60);
    expect(cardData(s, metric, 60, now).points[0]!.value).toBe(5000);
  });

  it('filters zone aggregates and tracked samples to the window', () => {
    const s = store();
    const now = Date.now();
    s.replaceSessionsFrom(
      '/logs/w.txt',
      0,
      [snapshot({ startMs: now - 2 * 3_600_000 }), snapshot({ startMs: now - 10 * 60_000 })],
      { guid: 'Player-1', name: 'Slouch' },
    );

    // the recent session visited two zones once each; the old session is outside the window
    const zones = cardData(s, findMetric(s, 'zone_runs')!, 60, now);
    expect(zones.points.map((p) => p.value)).toEqual([1, 1]);

    const metricId = s.addTrackedMetric({
      addonFile: 'BagBrother.lua',
      globalName: 'BrotherBags',
      path: ['BrotherBags', 'forever', 'Dead Sadfatkid', 'level'],
      label: 'level',
      unit: 'plain',
    });
    for (const [ts, value] of [
      [now - 2 * 3_600_000, 30],
      [now - 10 * 60_000, 31],
    ] as const) {
      s.recordSample({ metricId, tsMs: ts, value, instances: 1, minValue: null, maxValue: null, sourceFile: 'f', sourceMtimeMs: ts });
    }
    const level = cardData(s, findMetric(s, `tracked:${metricId}`)!, 60, now);
    expect(level.points.map((p) => p.value)).toEqual([31]);
    expect(level.latest).toBe(31);
  });

  it('formats the preset windows in minutes, hours and days', () => {
    expect(rangeLabel(15)).toBe('last 15 minutes');
    expect(rangeLabel(60)).toBe('last hour');
    expect(rangeLabel(60, true)).toBe('1h');
    expect(rangeLabel(1440)).toBe('last 24 hours');
    expect(rangeLabel(10080)).toBe('last 7 days');
    expect(rangeStart(0)).toBeNull();
    expect(rangeStart(60, 1_000_000)).toBe(1_000_000 - 3_600_000);
  });
});

describe('dashboards: card sizing', () => {
  it('buckets cards into xs/sm/md/lg from their cells', () => {
    expect(cardTier(3, 3)).toBe('xs');
    expect(cardTier(6, 2)).toBe('xs');
    expect(cardTier(5, 3)).toBe('sm');
    expect(cardTier(6, 3)).toBe('md');
    expect(cardTier(12, 3)).toBe('md');
    expect(cardTier(12, 5)).toBe('lg');
  });

  it('draws the chart at the size of its cells so it can fill the card', () => {
    const s = store();
    seed(s);
    const id = s.createDashboard('Mine');
    const cardId = s.addDashboardCard({
      dashboardId: id,
      metric: 'session_damage',
      title: 'trend',
      view: 'line',
      w: 3,
      h: 2,
    });
    // 3 columns × 87px, 2 rows × 92px minus the card header
    expect(renderCardBody(ctxFor(s), cardId, 3, 2)).toContain('viewBox="0 0 261 132"');
    expect(renderCardBody(ctxFor(s), cardId, 6, 6)).toContain('viewBox="0 0 522 500"');
    expect(renderCardBody(ctxFor(s), 9999)).toBeNull();
  });

  it('shows only the table rows the card height can hold, and drops share when narrow', () => {
    const s = store();
    const starts = [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000];
    s.replaceSessionsFrom(
      '/logs/t.txt',
      0,
      starts.map((startMs) => snapshot({ startMs })),
      { guid: 'Player-1', name: 'Slouch' },
    );
    const id = s.createDashboard('Mine');
    const tall = s.addDashboardCard({ dashboardId: id, metric: 'session_damage', title: 'trend', view: 'table', w: 6, h: 3 });
    const short = s.addDashboardCard({ dashboardId: id, metric: 'session_damage', title: 'trend', view: 'table', w: 6, h: 2 });
    const narrow = s.addDashboardCard({ dashboardId: id, metric: 'zone_time', title: 'time', view: 'table', w: 4, h: 3 });

    // h=3 fits 6 rows of 27px under the header: all five sessions, no elision note.
    const tallHtml = renderCardBody(ctxFor(s), tall, 6, 3)!;
    expect(tallHtml).not.toContain('showing');
    // h=2 fits 3: the rest are elided and said so.
    const shortHtml = renderCardBody(ctxFor(s), short, 6, 2)!;
    expect(shortHtml).toContain('showing 3 of 5 rows');
    // a 4-column card has no room for the share column
    const narrowHtml = renderCardBody(ctxFor(s), narrow, 4, 3)!;
    expect(narrowHtml).not.toContain('>share<');
    expect(narrowHtml).toContain('>value<');
  });
});

describe('dashboards: preview and edit form', () => {
  it('renders a preview card with the chosen window and no remove button', () => {
    const s = store();
    seed(s);
    const html = renderPreview(ctxFor(s), {
      metric: 'session_damage',
      view: 'line',
      rangeMinutes: 1440,
      title: 'my trend',
      w: 12,
      h: 3,
    })!;
    expect(html).toContain('my trend');
    expect(html).toContain('24h');
    // the fixture's sessions are in 1970, so "last 24 hours" is honestly empty
    expect(html).toContain('Nothing recorded in last 24 hours');
    expect(html).not.toContain('remove');

    const all = renderPreview(ctxFor(s), {
      metric: 'session_damage',
      view: 'line',
      rangeMinutes: 0,
      title: 'my trend',
      w: 12,
      h: 3,
    })!;
    expect(all).toContain('<svg');
    expect(renderPreview(ctxFor(s), { metric: 'nope', view: 'bar', rangeMinutes: 0, title: '', w: 6, h: 3 })).toBeNull();
  });

  it('shows the current values when editing and posts back to update', () => {
    const s = store();
    seed(s);
    const id = s.createDashboard('Mine');
    const cardId = s.addDashboardCard({
      dashboardId: id,
      metric: 'zone_kills',
      title: 'kills here',
      view: 'bar',
      rangeMinutes: 10080,
      w: 6,
      h: 4,
    });
    const html = renderEditCard(ctxFor(s), cardId)!;
    expect(html).toContain('action="/dashboard/card/update"');
    expect(html).toContain('value="kills here"');
    expect(html).toContain('<option value="10080" selected>');
    expect(html).toContain('id="card-preview"');
    expect(html).toContain('kills by zone');
    expect(renderEditCard(ctxFor(s), 9999)).toBeNull();
  });

  it('normalises form values, allowing only known windows and grid sizes', () => {
    const values = cardValuesFrom({ metric: ' session_damage ', view: 'pie', range: '60', title: ' x ', w: '12', h: '2' });
    expect(values).toMatchObject({ metric: 'session_damage', view: 'pie', rangeMinutes: 60, title: 'x', w: 12, h: 2 });
    expect(cardValuesFrom({ metric: 'm', view: 'bar', range: '7', w: '99', h: '0' })).toMatchObject({
      rangeMinutes: 0,
      w: 6,
      h: 3,
    });
  });
});

describe('dashboards: the example', () => {
  it('arrives with four cards every metric of which resolves', () => {
    const s = store();
    seed(s);
    const id = createExampleDashboard(s);
    const cards = s.dashboardCards(id);
    expect(cards).toHaveLength(4);
    expect(cards[0]!.span).toBe(2);
    for (const card of cards) expect(findMetric(s, card.metric), card.metric).toBeDefined();
    expect(renderDashboard(ctxFor(s), id)).toContain('dash-grid');
  });

  it('uses a tracked value as the fourth card when one exists', () => {
    const s = store();
    seed(s);
    const metricId = s.addTrackedMetric({ addonFile: 'f.lua', globalName: 'G', path: ['money'], label: 'gold', unit: 'copper' });
    const id = createExampleDashboard(s);
    expect(s.dashboardCards(id).some((c) => c.metric === `tracked:${metricId}`)).toBe(true);
  });
});

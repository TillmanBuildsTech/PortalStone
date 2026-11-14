/**
 * The session list: the page you open after playing.
 *
 * It answers three questions in order — when did I play, what was each session about, and how did
 * I do — with the chart carrying the trend and the table carrying the detail.
 */
import { throughput } from '../../../../core/src/throughput';
import { columnChart } from '../charts';
import { cards, emptyState, kindPill, metas, page, section, table } from '../shell';
import { dateLabel, dur, num, quantity, when } from '../format';
import type { Ctx } from '../context';

export function renderHome(ctx: Ctx): string {
  const sessions = ctx.store.listSessions(120);
  const totals = ctx.store.totals();
  const tz = sessions[0]?.offset_min ?? 0;
  const now = Date.now();

  if (sessions.length === 0) {
    return page(
      'No sessions yet',
      `<h1>Nothing recorded yet</h1>
       ${metas(['Portalstone is watching for combat logs']) }
       ${emptyState(
         'No sessions are stored, so there is nothing to chart.',
         `If you have played since installing this, open <a href="/diagnostics">diagnostics</a> — the log
          may not be found, or the file may still be empty.`,
       )}`,
      { active: 'sessions', refresh: 15, ctx },
    );
  }

  const rows = sessions.map((s) => {
    const t = throughput({
      damage: s.damage_done,
      healing: s.healing_done,
      engagedS: s.engaged_s,
      activeS: s.active_s,
      durationS: s.duration_s,
    });
    return { s, t, live: now - (s.end_ms ?? 0) < 5 * 60_000 };
  });
  const maxRate = Math.max(...rows.map((r) => r.t.rate), 1);

  // Oldest left: a trend reads left to right, and the newest session is the one on the right.
  const chart = columnChart(
    [...rows].reverse().map(({ s, t }) => ({
      label: dateLabel(s.start_ms, s.offset_min),
      value: t.total,
      kind: t.kind,
      href: `/session?id=${s.id}`,
      title: `${when(s.start_ms, s.offset_min)} — ${s.zone_name || 'unknown'}: ${num(t.total)} ${
        t.kind === 'healing' ? 'healing' : 'damage'
      } over ${dur(t.basisS)}`,
    })),
    { caption: 'output per session', unit: '' },
  );

  const body = `
    <h1>Sessions</h1>
    ${metas([
      `${num(totals.sessions)} session${totals.sessions === 1 ? '' : 's'}`,
      `${dur(totals.durationS)} played`,
      `${dur(totals.engagedS)} in combat`,
      `first recorded ${when(totals.firstMs, tz)}`,
    ])}
    ${cards([
      { k: 'damage done', v: num(totals.damage), lead: true },
      { k: 'healing done', v: num(totals.healing) },
      { k: 'kills', v: num(totals.kills) },
      { k: 'your deaths', v: num(totals.myDeaths) },
      { k: 'sessions', v: num(totals.sessions), hint: dur(totals.durationS) },
      ...ctx.store.trackedMetrics().slice(0, 2).map((m) => {
        const latest = ctx.store.latestSample(m.id);
        return { k: m.label.toLowerCase(), v: latest ? quantity(latest.value, m.unit) : '—' };
      }),
    ])}
    ${section('output per session', chart, 'bar height is the metric that dominated each session — damage or healing')}
    ${section(
      'all sessions',
      table(
        ['when', 'zone', 'length', 'in combat', 'rate', 'output', 'taken', 'kills', 'your deaths', 'casts', 'fights'],
        rows.map(({ s, t, live }) => {
          const href = `/session?id=${s.id}`;
          return `<tr class="${live ? 'live' : ''}">
            <td class="l"><a href="${href}">${when(s.start_ms, s.offset_min)}</a></td>
            <td class="l"><a href="${href}">${s.zone_name || '—'}</a>${
              s.zones_count > 1 ? ` <span class="pill">+${s.zones_count - 1}</span>` : ''
            }</td>
            <td>${dur(s.duration_s)}</td>
            <td>${dur(s.engaged_s)}</td>
            <td>${num(t.rate)} <span class="sub">${t.kind === 'healing' ? 'hps' : 'dps'}</span>
              <span class="meter"><i style="width:${((t.rate / maxRate) * 100).toFixed(1)}%;background:${
                t.kind === 'healing' ? '#56d364' : '#6ea8fe'
              }"></i></span></td>
            <td>${num(t.total)} <span class="sub">${t.kind === 'healing' ? 'heal' : 'dmg'}</span></td>
            <td>${num(s.damage_taken)}</td>
            <td>${num(s.kills)}</td>
            <td>${num(s.field_kills)}</td>
            <td>${num(s.my_deaths)}</td>
            <td>${num(s.casts)}</td>
            <td>${s.encounters > 0 ? num(s.encounters) : '—'}</td>
          </tr>`;
        }),
      ),
      'newest first · click a row to open the session',
    )}`;
  return page('Sessions', body, { active: 'sessions', refresh: 20, ctx });
}

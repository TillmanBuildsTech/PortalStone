/**
 * The session list: the page you open after playing.
 *
 * It answers three questions in order — when did I play, what was each session about, and how did
 * I do — with the chart carrying the trend and the table carrying the detail.
 *
 * With more than one character the page is scoped to one of them (`?char=`) or to all of them. A
 * level-36 paladin's damage and a level-15 mage's are not the same measurement, so the totals name
 * the character they belong to instead of quietly adding two people together.
 */
import { throughput } from '../../../../core/src/throughput';
import { columnChart } from '../charts';
import { cards, characterBar, emptyState, metas, page, section, table, withCharacter } from '../shell';
import { dateLabel, dur, esc, num, quantity, when } from '../format';
import type { Ctx } from '../context';
import { sameCharacter } from '../../characters';

/**
 * Which tracked values belong on this page.
 *
 * Unscoped, the first couple of series are a glance at the world (gold, level). Scoped, only the
 * series pinned to *this* character apply: an unpinned one is a sum over every wallet, and a series
 * pinned to someone else is someone else's number. The label always carries the entity, so even a
 * near-miss name match shows you what the figure is about.
 */
function trackedCards(ctx: Ctx, character: string | null): { k: string; v: string }[] {
  return ctx.store
    .trackedMetrics()
    .filter((m) => !character || (m.entity !== null && sameCharacter(m.entity, character)))
    .slice(0, character ? 4 : 2)
    .map((m) => {
      const latest = ctx.store.latestSample(m.id);
      // A label that already names the character ("Level · Slouch Mage") is not repeated: the
      // entity is added only when the label does not say which one this series is about.
      const named = m.entity !== null && m.label.toLowerCase().includes(m.entity.toLowerCase());
      return {
        k: m.entity && !named ? `${m.label.toLowerCase()} · ${m.entity}` : m.label.toLowerCase(),
        v: latest ? quantity(latest.value, m.unit) : '—',
      };
    });
}

export function renderHome(ctx: Ctx): string {
  const character = ctx.character;
  const sessions = ctx.store.listSessions(120, character);
  const totals = ctx.store.totals(character);
  const roster = ctx.store.characters();
  const tz = sessions[0]?.offset_min ?? 0;
  const now = Date.now();

  if (sessions.length === 0) {
    return page(
      'No sessions yet',
      `<h1>Nothing recorded yet</h1>
       ${metas(['Portalstone is watching for combat logs']) }
       ${character ? `<div class="notice">No sessions for <b>${character}</b>. <a href="/">Show every character</a></div>` : ''}
       ${emptyState(
         'No sessions are stored, so there is nothing to chart.',
         `If you have played since installing this, open <a href="/diagnostics">diagnostics</a> — the log
          may not be found, or the file may still be empty.`,
       )}`,
      { active: 'sessions', refresh: 15, ctx, scope: true },
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
  // Unscoped, every row has to name its character: otherwise two people's evenings read as one
  // person's. Scoped, the switcher above already says whose they are.
  const showCharacter = character === null && roster.length > 1;

  // Oldest left: a trend reads left to right, and the newest session is the one on the right.
  const chart = columnChart(
    [...rows].reverse().map(({ s, t }) => ({
      label: dateLabel(s.start_ms, s.offset_min),
      value: t.total,
      kind: t.kind,
      href: `/session?id=${s.id}`,
      title: `${when(s.start_ms, s.offset_min)} — ${s.zone_name || 'unknown'}: ${num(t.total)} ${
        t.kind === 'healing' ? 'healing' : 'damage'
      } over ${dur(t.basisS)}${showCharacter && s.character_name ? ` · ${s.character_name}` : ''}`,
    })),
    { caption: 'output per session', unit: '' },
  );

  // Short headers, because a 13-column list has to fit a laptop: "in combat" and "your deaths"
  // cost two characters each and say nothing the tooltip and the session page do not.
  const head = [
    'when',
    ...(showCharacter ? ['character'] : []),
    'zone',
    'length',
    'combat',
    'rate',
    'output',
    'taken',
    'kills',
    'field',
    'deaths',
    'casts',
    'fights',
  ];

  const body = `
    <h1>Sessions${character ? ` · ${character}` : ''}</h1>
    ${metas([
      `${num(totals.sessions)} session${totals.sessions === 1 ? '' : 's'}`,
      `${dur(totals.durationS)} played`,
      `${dur(totals.engagedS)} in combat`,
      `${num(totals.kills)} kills`,
      `first recorded ${when(totals.firstMs, tz)}`,
      !character && roster.length > 1 ? `${num(roster.length)} characters` : null,
    ])}
    ${characterBar(ctx, '/')}
    ${
      character && trackedCards(ctx, character).length === 0
        ? `<div class="sub" style="margin-top:8px">No tracked value is tied to ${esc(character)} yet.
            The <a href="/">all characters</a> view shows the totals, and
            <a href="/tracked">tracked</a> can add one per character.</div>`
        : ''
    }
    ${cards([
      { k: 'damage done', v: num(totals.damage), lead: true },
      { k: 'healing done', v: num(totals.healing) },
      { k: 'kills', v: num(totals.kills) },
      { k: 'your deaths', v: num(totals.myDeaths) },
      { k: 'sessions', v: num(totals.sessions), hint: dur(totals.durationS) },
      ...trackedCards(ctx, character),
    ])}
    ${section(
      'output per session',
      chart,
      `bar height is the metric that dominated each session — damage or healing, ${
        character ? `${character} only` : 'every character'
      }`,
    )}
    ${section(
      'all sessions',
      table(
        head,
        rows.map(({ s, t, live }) => {
          const href = `/session?id=${s.id}`;
          const who = showCharacter
            ? `<td class="l"><a href="${withCharacter('/', s.character_name)}">${s.character_name || '—'}</a></td>`
            : '';
          return `<tr class="${live ? 'live' : ''}">
            <td class="l"><a href="${href}">${when(s.start_ms, s.offset_min)}</a></td>${who}
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
        { dense: true },
      ),
      'newest first · click a row to open the session · field = creatures and players that died around you',
    )}`;
  return page('Sessions', body, { active: 'sessions', refresh: 20, ctx, scope: true });
}

/**
 * One session: what the evening cost, and where it went.
 *
 * The timeline is the map (every zone visit, sized by the clock) and the runs table underneath is
 * the same thing numerically, each row a link into that run's own page.
 */
import { throughput } from '../../../../core/src/throughput';
import { timelineChart } from '../charts';
import { cards, emptyState, kindPill, metas, page, section, table } from '../shell';
import { dayLabel, delta, dur, esc, num, pct, quantity, when } from '../format';
import { abilityTable, castsByRankTable } from '../parts';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';
import { changesAcrossSessions } from '../../tracking';
import { itemLabel, slotName } from '../gear';

export function renderSession(ctx: Ctx, id: number): string | null {
  const store = ctx.store;
  const s = store.session(id);
  if (!s) return null;

  const segments = store.segments(id);
  const encounters = store.encounters(id);
  const abil = {
    damage: store.abilities(id, 'damage'),
    healing: store.abilities(id, 'healing'),
    taken: store.abilities(id, 'taken'),
    cast: store.abilities(id, 'cast', 40),
  };
  // Average effect per spell id, so a rank's size is visible next to its cast count.
  const averages = store.spellAverages(id);
  const t = throughputFrom(s);
  const dtps = t.basisS > 0 ? Math.round(s.damage_taken / t.basisS) : 0;

  // Gold (or any tracked property) across this session: the balance at the last flush before it
  // began and at the first flush after it ended. No bracket means unknown, never zero.
  const tracked = store.trackedMetrics();
  const trackedChanges = tracked.length
    ? (changesAcrossSessions(
        tracked,
        new Map(tracked.map((m) => [m.id, store.samples(m.id, 1000)])),
        store.listSessions(500).map((row) => ({ id: row.id, start_ms: row.start_ms, end_ms: row.end_ms })),
      ).get(id) ?? [])
    : [];
  const runs = segments.map((seg) => ({ seg, st: throughputFrom(seg) }));
  const maxRate = Math.max(...runs.map((r) => r.st.rate), 1);

  const chart = timelineChart(
    segments.map((seg) => ({
      label: seg.zone_name,
      start: seg.start_ms,
      end: seg.end_ms,
      kind: seg.kind,
      href: `/run?id=${seg.id}`,
      title: `${seg.zone_name} · ${dur(seg.duration_s)} · ${dur(seg.engaged_s)} in combat · ${pct(
        seg.damage_done + seg.healing_done,
        s.damage_done + s.healing_done,
      )} of the session`,
    })),
    {
      from: s.start_ms,
      to: s.end_ms ?? segments[segments.length - 1]?.end_ms ?? s.start_ms,
      offsetMin: s.offset_min,
      caption: 'session timeline: one bar per zone visit',
    },
  );

  const runRows = runs.map(({ seg, st }) => {
    const href = `/run?id=${seg.id}`;
    return `<tr>
      <td class="l"><a href="${href}">${seg.zone_name}</a>${kindPill(seg.kind)}</td>
      <td>${when(seg.start_ms, s.offset_min)} → ${when(seg.end_ms, s.offset_min)}</td>
      <td>${dur(seg.duration_s)}</td>
      <td>${dur(seg.engaged_s)}</td>
      <td>${num(st.rate)} <span class="sub">${st.kind === 'healing' ? 'hps' : 'dps'}</span>
        <span class="meter"><i style="width:${((st.rate / maxRate) * 100).toFixed(1)}%;background:${
          st.kind === 'healing' ? '#56d364' : '#6ea8fe'
        }"></i></span></td>
      <td>${num(seg.damage_done)}</td>
      <td>${num(seg.healing_done)}</td>
      <td>${num(seg.damage_taken)}</td>
      <td>${num(seg.kills)}</td>
      <td>${num(seg.field_kills)}</td>
      <td>${perHourLabel(seg.field_kills, seg.duration_s)}</td>
      <td>${perHourLabel(seg.field_kills, seg.engaged_s)}</td>
      <td>${num(seg.my_deaths)}</td>
      <td>${num(seg.field_deaths)}</td>
    </tr>`;
  });

  const encRows = encounters.map((e) => {
    const len = Number(e.duration_s);
    const ft = throughput({
      damage: Number(e.damage_done),
      healing: Number(e.healing_done),
      engagedS: len,
      activeS: len,
      durationS: len,
    });
    const bold = (v: number, mirrored: boolean): string =>
      mirrored === (ft.kind === 'damage') ? `<strong>${num(v)}</strong>` : num(v);
    return `<tr><td class="l">${e.boss_name}</td>
       <td>${e.success === 1 ? 'kill' : e.success === 0 ? 'wipe' : 'open'}</td>
       <td>${dur(len)}</td>
       <td>${bold(Number(e.damage_done), true)}</td>
       <td>${bold(Number(e.healing_done), false)}</td>
       <td>${num(ft.kind === 'damage' ? ft.rate : Math.round(Number(e.damage_done) / Math.max(len, 1)))}</td>
       <td>${num(ft.kind === 'healing' ? ft.rate : Math.round(Number(e.healing_done) / Math.max(len, 1)))}</td>
       <td>${num(Number(e.deaths))}</td></tr>`;
  });

  // Order by what the session was about: a healer should not scroll past a damage table to reach
  // their own. Same rule the throughput module applies to the headline number.
  const damageSection = abilityTable({
    title: 'damage by ability',
    kind: 'damage',
    rows: abil.damage,
    total: s.damage_done,
    empty: 'No outgoing damage recorded in this session.',
    hint: 'merged by spell name · ranks of one spell are one line',
  });
  const healingSection = abilityTable({
    title: 'healing by ability',
    kind: 'healing',
    rows: abil.healing,
    total: s.healing_done,
    empty: 'No healing recorded in this session.',
    hint: 'merged by spell name · overheal is excluded from the totals',
  });
  const takenSection = abilityTable({
    title: 'damage taken by ability',
    kind: 'taken',
    rows: abil.taken,
    total: s.damage_taken,
    empty: 'No damage taken recorded in this session.',
  });
  const castsSection = abil.cast.length
    ? section(
        'casts by spell and rank',
        castsByRankTable({
          rows: abil.cast,
          averages,
          empty: 'No casts recorded in this session.',
        }),
        'ranks share a name in the log but not an id — one row per id, so rank 3 and rank 5 stay separate',
      )
    : '';
  const abilitySections =
    (t.kind === 'healing' ? healingSection + damageSection + takenSection : damageSection + healingSection + takenSection) +
    castsSection;

  const trackedRows = trackedChanges.map((c) => {
    const setDetail =
      c.setChange && c.metric.kind === 'set'
        ? [
            ...c.setChange.added.map((m) => `+ ${slotName(m.k)} ${itemLabel(m.v)}`),
            ...c.setChange.changed.map((m) => `~ ${slotName(m.k)} ${itemLabel(m.from)} → ${itemLabel(m.to)}`),
            ...c.setChange.removed.map((m) => `− ${slotName(m.k)} ${itemLabel(m.v)}`),
          ].join(' · ')
        : '';
    const changeCell =
      c.metric.kind === 'set'
        ? c.setChange
          ? `<span class="sub">${c.setChange.added.length + c.setChange.changed.length + c.setChange.removed.length === 0 ? 'no change' : setDetail}</span>${
              c.shared > 1 ? ` <span class="pill warn">shared across ${c.shared}</span>` : ''
            }`
          : `<span class="sub">${c.before ? 'no flush since this session ended' : 'no flush before this session began'}</span>`
        : c.change === null
          ? `<span class="sub">${c.before ? 'no flush since this session ended' : 'no flush before this session began'}</span>`
          : `${delta(c.change, c.metric.unit)}${
              c.shared > 1 ? ` <span class="pill warn">shared across ${c.shared} sessions</span>` : ''
            }`;
    return `<tr>
      <td class="l"><a href="/tracked">${esc(c.metric.label)}</a></td>
      <td>${c.before ? (c.metric.kind === 'set' ? `${num(c.before.value)}` : quantity(c.before.value, c.metric.unit)) : '—'}</td>
      <td>${c.after ? (c.metric.kind === 'set' ? `${num(c.after.value)}` : quantity(c.after.value, c.metric.unit)) : '—'}</td>
      <td>${changeCell}</td>
      <td class="l sub">${
        c.before && c.after ? `${when(c.before.ts_ms, s.offset_min)} → ${when(c.after.ts_ms, s.offset_min)}` : ''
      }</td>
    </tr>`;
  });
  const trackedSection = trackedChanges.length
    ? section(
        'tracked values over this session',
        table(['value', 'before', 'after', 'change', 'flushes'], trackedRows, { left: [0, 4] }),
        'SavedVariables are balances, not transactions: the change is the gap between two flushes',
      )
    : '';

  const body = `
    <div class="crumbs"><a href="/">sessions</a> <span>/</span> <span>${esc(
      s.zone_name || 'session',
    )}</span></div>
    <h1>${s.zone_name || 'Unknown zone'}</h1>
    ${metas([
      `${dayLabel(s.start_ms, s.offset_min)} ${when(s.start_ms, s.offset_min)} → ${when(s.end_ms, s.offset_min)}`,
      dur(s.duration_s),
      s.character_name ? esc(s.character_name) : null,
      `<span class="pill">${t.mixed ? 'mixed' : `${t.kind}-led`}</span>`,
      `${num(segments.length)} zone visit${segments.length === 1 ? '' : 's'}`,
    ])}
    ${cards([
      { k: `${t.kind} per second`, v: num(t.rate), hint: 'per second in combat', lead: true },
      { k: `${t.kind} done`, v: num(t.total) },
      { k: `${t.otherKind} done`, v: num(t.otherTotal) },
      { k: 'damage taken', v: num(s.damage_taken) },
      { k: 'dtps', v: num(dtps) },
      { k: 'in combat', v: dur(s.engaged_s), hint: `of ${dur(s.duration_s)}` },
      { k: 'field kills', v: num(s.field_kills), hint: "everyone's" },
      { k: 'your kills', v: num(s.kills), hint: 'last hit' },
      { k: 'kills / hr', v: perHourLabel(s.field_kills, s.duration_s), hint: 'wall clock' },
      { k: 'kills / combat hr', v: perHourLabel(s.field_kills, s.engaged_s), hint: 'in combat' },
      { k: 'your deaths', v: num(s.my_deaths) },
      { k: 'field deaths', v: num(s.deaths), hint: `${num(s.players_died)} players` },
      { k: 'casts', v: num(s.casts) },
      { k: 'interrupts', v: num(s.interrupts) },
    ])}
    ${trackedSection}
    ${
      segments.length
        ? section('where the session went', chart, 'bar length is time in that zone · click a bar to open the run')
        : emptyState('No zone visits recorded in this session.')
    }
    ${
      segments.length
        ? section(
            'runs in this session',
            table(
              [
                'zone',
                'when',
                'length',
                'in combat',
                'rate',
                'damage',
                'healing',
                'taken',
                'your kills',
                'field kills',
                'kills / hr',
                'kills / combat hr',
                'your deaths',
                'field deaths',
              ],
              runRows,
              { empty: 'No zone visits recorded in this session.' },
            ),
            'one row per zone entry: dungeons, battlegrounds and zones are separated here',
          )
        : ''
    }
    ${
      encounters.length
        ? section(
            'fights',
            table(
              ['boss', 'result', 'length', 'damage', 'healing', 'dps', 'hps', 'deaths'],
              encRows,
            ),
          )
        : ''
    }
    ${abilitySections}`;

  return page(s.zone_name || 'Session', body, { active: 'sessions', ctx });
}

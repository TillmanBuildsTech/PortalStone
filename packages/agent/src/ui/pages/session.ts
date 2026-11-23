/**
 * One session: what the evening cost, and where it went.
 *
 * The timeline is the map (every zone visit, sized by the clock) and the runs table underneath is
 * the same thing numerically, each row a link into that run's own page.
 */
import { throughput } from '../../../../core/src/throughput';
import { distribution, timelineChart } from '../charts';
import { cards, emptyState, kindPill, metas, page, section, specPill, table } from '../shell';
import { compact, dayLabel, delta, dur, esc, num, pct, quantity, when } from '../format';
import { abilityTable, castsByRankTable, deathSummary } from '../parts';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';
import { sessionCompare, MIN_ZONE, type Basis, type SessionCompare } from './sessionCompare';
import { changesAcrossSessions, changesAfterSession, type SessionChange } from '../../tracking';
import { itemLabel, slotName } from '../gear';
import { sessionSpecLine, specForSession, specTitle } from '../specInfo';

export function renderSession(ctx: Ctx, id: number, opts: { basis?: Basis | null } = {}): string | null {
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
  // began and at the first flush after it ended. No bracket means unknown, never zero. Flushes that
  // follow with no later session to claim them are shown separately: play after the last combat
  // event writes nothing to the combat log, but it does change these values.
  const tracked = store.trackedMetrics();
  const samplesByMetric = new Map(tracked.map((m) => [m.id, store.samples(m.id, 1000)]));
  const allSessions = store
    .listSessions(500)
    .map((row) => ({ id: row.id, start_ms: row.start_ms, end_ms: row.end_ms }));
  const trackedChanges = tracked.length
    ? (changesAcrossSessions(tracked, samplesByMetric, allSessions).get(id) ?? [])
    : [];
  const nextSession = allSessions
    .filter((row) => row.start_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)[0];
  const afterChanges = tracked.length
    ? changesAfterSession(
        tracked,
        samplesByMetric,
        { id: s.id, start_ms: s.start_ms, end_ms: s.end_ms },
        nextSession?.start_ms ?? null,
      )
    : [];
  const runs = segments.map((seg) => ({ seg, st: throughputFrom(seg) }));
  const maxRate = Math.max(...runs.map((r) => r.st.rate), 1);

  // When an evening holds a dungeon (or raid, or battleground) alongside questing before and after
  // it, the headline numbers below are the whole night, not the instance. This callout links
  // straight to each instance's own run page — that run on its own, nothing before or after — so the
  // dungeon can be read in isolation. Shown only when there is other zone time to separate it from.
  const instances = segments.filter(
    (seg) => seg.kind === 'dungeon' || seg.kind === 'raid' || seg.kind === 'battleground',
  );
  const instancesCallout =
    instances.length && segments.length > instances.length
      ? `<div class="notice">Instances in this session —
          ${instances
            .map(
              (seg) =>
                `<a href="/run?id=${seg.id}">${esc(seg.zone_name)}</a>${kindPill(seg.kind)} <span class="sub">${dur(
                  seg.duration_s,
                )}</span>`,
            )
            .join(' · ')}.
          Open one to see just that run, with nothing from before or after it.</div>`
      : '';
  // What the abilities say about the build. A session that straddles a respec reads "mixed" on
  // throughput, which is true and useless; the phases date the switch instead.
  const spec = specForSession(store, segments);
  const specLine = sessionSpecLine(spec, s.offset_min);

  // How this session sat against your own history — the one thing only this app can say, which the
  // session page (unlike the run page) did not use. Scoped to this character: an alt's night is a
  // different measurement, so it must not become the median the main is judged against.
  const history = store.listSessions(500, s.character_guid ?? s.character_name);
  const compare = sessionCompare(s, history, opts.basis ?? null);

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
    const guess = spec.bySegment.get(seg.id) ?? null;
    return `<tr>
      <td class="l"><a href="${href}">${seg.zone_name}</a>${kindPill(seg.kind)}${
        specPill(guess?.spec, guess ? specTitle(guess) : '')
      }</td>
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

  const trackedSection = trackedChanges.length
    ? section(
        'tracked values over this session',
        trackedChangesTable(trackedChanges, s.offset_min),
        'SavedVariables are balances, not transactions: the change is the gap between two flushes',
      )
    : '';
  const afterSection = afterChanges.length
    ? section(
        'after this session',
        trackedChangesTable(afterChanges, s.offset_min),
        nextSession
          ? 'flushes between the end of this session and the start of the next one · no session covers them'
          : `flushes after this session ended, with no later session to claim them · the combat log recorded nothing after ${when(
              s.end_ms,
              s.offset_min,
            )}, so a play sitting that produced no combat leaves no session behind`,
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
      specLine,
      `${num(segments.length)} zone visit${segments.length === 1 ? '' : 's'}`,
    ])}
    ${instancesCallout}
    ${cards([
      { k: `${t.kind} per second`, v: num(t.rate), hint: 'per second in combat', lead: true },
      { k: `${t.kind} done`, v: num(t.total) },
      { k: 'in combat', v: dur(s.engaged_s), hint: `of ${dur(s.duration_s)}` },
      { k: 'field kills', v: num(s.field_kills), hint: "everyone's" },
      { k: 'kills / hr', v: perHourLabel(s.field_kills, s.duration_s), hint: 'wall clock' },
    ])}
    ${compareSection(compare, s.id)}
    ${cards([
      { k: `${t.otherKind} done`, v: num(t.otherTotal) },
      { k: 'damage taken', v: num(s.damage_taken) },
      { k: 'dtps', v: num(dtps) },
      { k: 'your kills', v: num(s.kills), hint: 'last hit' },
      { k: 'kills / combat hr', v: perHourLabel(s.field_kills, s.engaged_s), hint: 'in combat' },
      { k: 'your deaths', v: num(s.my_deaths) },
      { k: 'field deaths', v: num(s.deaths), hint: `${num(s.players_died)} players` },
      { k: 'casts', v: num(s.casts) },
      { k: 'interrupts', v: num(s.interrupts) },
    ])}
    ${trackedSection}${afterSection}
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
    ${deathSummary(store.deaths(id), s.offset_min)}
    ${abilitySections}`;

  return page(s.zone_name || 'Session', body, { active: 'sessions', ctx });
}

/** A metric's value in the metric's own unit. */
function compareValue(key: string, v: number, rateUnit: string): string {
  if (key === 'rate') return `${num(v)} ${rateUnit}`;
  if (key === 'killsPerHour') return `${num(v)}/hr`;
  return `${num(v)} dtps`;
}

/**
 * "How this session stacked up" — the run page's comparison, raised to the whole session, with the
 * basis named and switchable. Null means there is nothing yet to compare against, which the page
 * says plainly rather than hiding the feature.
 */
function compareSection(c: SessionCompare | null, id: number): string {
  if (!c) {
    return `<h2>how this session stacked up<span class="hint">the first comparable session on this character</span></h2>
      <div class="empty">Nothing to compare against yet — once you have more sessions, this shows where a night sits against your own median and best.</div>`;
  }

  const onChar = c.characterName ? ` on ${esc(c.characterName)}` : '';
  const inBasis =
    c.basis === 'zone' && c.zoneName
      ? `in ${esc(c.zoneName)}`
      : 'across your sessions';
  const compared =
    c.basis === 'zone' && c.zoneName
      ? `your ${c.zoneCount} other ${esc(c.zoneName)} session${c.zoneCount === 1 ? '' : 's'}${onChar}`
      : c.allCount === 1
        ? `your only other session${onChar}`
        : `all ${c.allCount} of your other sessions${onChar}`;
  const thin =
    c.basis === 'all' && c.zoneName && c.zoneCount < MIN_ZONE
      ? ` · not enough ${esc(c.zoneName)} history yet`
      : '';

  const rows = c.metrics.map(
    (m) => `<tr>
      <td class="l">${esc(m.label)}</td>
      <td><strong>${compareValue(m.key, m.value, c.rateUnit)}</strong></td>
      <td>${compareValue(m.key, m.median, c.rateUnit)}</td>
      <td>${compareValue(m.key, m.best, c.rateUnit)}</td>
    </tr>`,
  );

  const rate = c.metrics.find((m) => m.key === 'rate');
  const verb = c.rateUnit === 'hps' ? 'more healing than' : 'faster than';
  const plot = rate
    ? `${distribution(rate.dots, {
        current: c.currentIndex,
        format: (n) => `${compact(n)} ${c.rateUnit}`,
      })}
       <div class="sub">each dot is one session ${inBasis}; yours is highlighted${
         rate.percentile === null
           ? ''
           : ` — ${rate.value >= rate.median ? 'above' : 'below'} your median, ${verb} ${Math.round(
               rate.percentile * 100,
             )}% of them`
       }.</div>`
    : '';

  // The toggle only appears when both bases actually have something to show.
  const toggle =
    c.zoneCount > 0 && c.allCount > 0 && c.zoneName
      ? `<div class="sub" style="margin-top:6px">compare against:
         ${
           c.basis === 'zone'
             ? `<strong>${esc(c.zoneName)}</strong>`
             : `<a href="/session?id=${id}&basis=zone">${esc(c.zoneName)}</a>`
         } ·
         ${c.basis === 'all' ? '<strong>all sessions</strong>' : `<a href="/session?id=${id}&basis=all">all sessions</a>`}</div>`
      : '';

  return section(
    'how this session stacked up',
    `<div class="row">
       <div class="col">${table(['', 'this session', 'your median', 'your best'], rows, { left: [0] })}</div>
       <div class="col" style="min-width:260px">${plot}${toggle}</div>
     </div>`,
    `compared against ${compared}${thin}`,
  );
}

/** The tracked-value table, used both for the session bracket and for the flushes after it. */
function trackedChangesTable(changes: SessionChange[], offsetMin: number): string {
  return table(
    ['value', 'before', 'after', 'change', 'flushes'],
    changes.map((c) => trackedChangeRow(c, offsetMin)),
    { left: [0, 4] },
  );
}

function trackedChangeRow(c: SessionChange, offsetMin: number): string {
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
        : c.change === 0
          ? '<span class="sub">no change</span>'
          : `${delta(c.change, c.metric.unit)}${
              c.shared > 1 ? ` <span class="pill warn">shared across ${c.shared} sessions</span>` : ''
            }`;

  // A wildcard path such as `forever.*.money` sums one value per character. Without saying so, the
  // number reads as a single wallet — and a spend on one character can be masked by another.
  const instances = c.metric.kind === 'set' ? 0 : (c.after ?? c.before)?.instances ?? 0;
  const sumHint =
    instances > 1
      ? ` <span class="sub" title="the tracked path matched ${num(instances)} values at this flush — one per character, for example">sum of ${num(instances)}</span>`
      : '';

  return `<tr>
    <td class="l"><a href="/tracked">${esc(c.metric.label)}</a>${sumHint}</td>
    <td>${c.before ? (c.metric.kind === 'set' ? `${num(c.before.value)}` : quantity(c.before.value, c.metric.unit)) : '—'}</td>
    <td>${c.after ? (c.metric.kind === 'set' ? `${num(c.after.value)}` : quantity(c.after.value, c.metric.unit)) : '—'}</td>
    <td>${changeCell}</td>
    <td class="l sub">${
      c.before && c.after ? `${when(c.before.ts_ms, offsetMin)} → ${when(c.after.ts_ms, offsetMin)}` : ''
    }</td>
  </tr>`;
}

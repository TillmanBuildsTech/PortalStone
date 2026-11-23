/**
 * One zone visit — the drill-in.
 *
 * This is the page that answers "how did I actually do in that run": the rate, the abilities that
 * produced it, what hit back, and how it compares with your other runs in the same place. The
 * comparison is the part only this app can offer, because it has every run you have ever logged.
 */
import { columnChart, distribution } from '../charts';
import { cards, kindPill, metas, page, section, specPill } from '../shell';
import { compact, dateLabel, dur, esc, num, pct, when } from '../format';
import { abilityTable, castsByRankTable, deathSummary } from '../parts';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';
import { runTrend } from './runCompare';
import { specEvidenceText, specForRun, specTitle } from '../specInfo';

export function renderRun(ctx: Ctx, id: number): string | null {
  const store = ctx.store;
  const seg = store.segment(id);
  if (!seg) return null;
  const session = store.session(seg.session_id);
  const siblings = store.segments(seg.session_id);
  const index = siblings.findIndex((s) => s.id === seg.id);
  const prev = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  const t = throughputFrom(seg);
  const dtps = t.basisS > 0 ? Math.round(seg.damage_taken / t.basisS) : 0;
  // What this run's abilities say about the build. Null when no talent-locked ability appears,
  // which is the honest answer for a build whose tree leaves no trace in the log.
  const specGuess = specForRun(store, seg.id);
  const sessionTotal = session ? session.damage_done + session.healing_done : 0;
  const runTotal = seg.damage_done + seg.healing_done;

  // Comparison basis: the same zone on this character, this run excluded. Naming the character is
  // the whole point: an alt leveling through the same zone would otherwise become the median the
  // main is measured against, which is a comparison between two different characters.
  const others = store
    .runsForZone(seg.zone_name, 200, seg.character_guid ?? seg.character_name)
    .filter((r) => r.id !== seg.id)
    .map((r) => ({ row: r, t: throughputFrom(r) }));
  // Only runs that led with the same metric and actually fought are one measurement with this one.
  const comparable = others.filter(({ t: o }) => o.kind === t.kind && o.rate > 0 && o.total > 0);
  const rates = comparable.map(({ t: o }) => o.rate).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)]! : 0;
  const best = rates.length ? rates[rates.length - 1]! : 0;
  const unit = t.kind === 'healing' ? 'hps' : 'dps';
  const verb = t.kind === 'healing' ? 'more healing than' : 'faster than';

  // Percentile and the over-time trend: the two things the median alone cannot say.
  const trend = runTrend(
    { startMs: seg.start_ms, rate: t.rate, id: seg.id },
    comparable.map(({ row, t: o }) => ({ startMs: row.start_ms, rate: o.rate, id: row.id })),
  );
  const pctSentence =
    trend.percentile === null
      ? `${t.rate >= median ? 'above' : 'below'} your median`
      : `${t.rate >= median ? 'above' : 'below'} your median, ${verb} ${Math.round(trend.percentile * 100)}% of them`;

  // The trend chart and verdict, only once there is enough history for a direction to mean anything.
  const trendBlock =
    trend.trend === null
      ? ''
      : (() => {
          const { direction, earlierMedian, laterMedian } = trend.trend;
          const word =
            direction === 'up'
              ? t.kind === 'healing'
                ? 'climbing'
                : 'speeding up'
              : direction === 'down'
                ? t.kind === 'healing'
                  ? 'slipping'
                  : 'slowing down'
                : 'holding steady';
          const verdict =
            direction === 'flat'
              ? `Your rate here is <strong>holding steady</strong> — recent runs around ${num(laterMedian)} ${unit}, about where they were.`
              : `Your rate here is <strong>${word}</strong> — the later half of your runs median ${num(
                  laterMedian,
                )} ${unit} against ${num(earlierMedian)} ${unit} earlier.`;
          return `<div style="margin-top:14px">
             ${columnChart(
               trend.series.map((p) => ({
                 label: dateLabel(p.startMs, session?.offset_min ?? 0),
                 value: p.rate,
                 kind: t.kind,
                 href: `/run?id=${p.id}`,
                 title: `${dateLabel(p.startMs, session?.offset_min ?? 0)}: ${num(p.rate)} ${unit}${
                   p.isCurrent ? ' · this run' : ''
                 }`,
               })),
               { caption: `${t.kind} per second here over time`, height: 150, unit: ` ${unit}` },
             )}
             <div class="sub">one bar per run here, oldest left; this run is the last. ${verdict}</div>
           </div>`;
        })();

  const compare =
    comparable.length === 0
      ? ''
      : section(
          'against your other runs here',
          `<div class="row"><div class="col">
             <ul class="kv">
               <li><span>this run</span><b>${num(t.rate)} ${unit}</b></li>
               <li><span>your median in ${seg.zone_name}</span><b>${num(median)} ${unit}</b></li>
               <li><span>your best in ${seg.zone_name}</span><b>${num(best)} ${unit}</b></li>
               <li><span>runs compared</span><b>${num(comparable.length + 1)}</b></li>
             </ul>
           </div>
           <div class="col" style="min-width:260px">
             ${distribution(
               [...comparable.map(({ t: o }) => ({ value: o.rate, title: `${num(o.rate)} ${unit}` })), { value: t.rate }],
               {
                 current: comparable.length,
                 format: (n) => `${compact(n)} ${unit}`,
               },
             )}
             <div class="sub">each dot is one run in this zone; yours is highlighted — ${pctSentence}.</div>
           </div></div>
           ${trendBlock}`,
          `${comparable.length} other run${comparable.length === 1 ? '' : 's'} of this zone logged${
            seg.character_name ? ` on ${seg.character_name}` : ''
          }`,
        );

  const takenSection = abilityTable({
    title: 'damage taken by ability',
    kind: 'taken',
    rows: store.segmentAbilities(seg.id, 'taken'),
    total: seg.damage_taken,
    empty: 'Nothing hit back in this run.',
  });
  const damageSection = abilityTable({
    title: 'damage by ability',
    kind: 'damage',
    rows: store.segmentAbilities(seg.id, 'damage'),
    total: seg.damage_done,
    empty: 'No damage recorded in this run.',
    hint: 'this run only',
  });
  const healingSection = abilityTable({
    title: 'healing by ability',
    kind: 'healing',
    rows: store.segmentAbilities(seg.id, 'healing'),
    total: seg.healing_done,
    empty: 'No healing recorded in this run.',
    hint: 'this run only',
  });
  const castRows = store.segmentAbilities(seg.id, 'cast', 40);
  const averages = store.segmentSpellAverages(seg.id);
  const castsSection = castRows.length
    ? section(
        'casts by spell and rank',
        castsByRankTable({ rows: castRows, averages, empty: 'No casts recorded in this run.' }),
        'one row per spell id: ranks of one spell are separate ids in the log',
      )
    : '';
  const abilitySections =
    (t.kind === 'healing' ? healingSection + damageSection + takenSection : damageSection + healingSection + takenSection) +
    castsSection;

  const sessionLink = session ? `<a href="/session?id=${session.id}">${esc(session.zone_name)}</a>` : 'session';

  const body = `
    <div class="crumbs"><a href="/">sessions</a> <span>/</span> ${sessionLink}
      <span>/</span> <span>run ${index + 1} of ${siblings.length}</span></div>
    <h1>${seg.zone_name}${kindPill(seg.kind)}${
      specGuess ? specPill(specGuess.spec, specTitle(specGuess)) : ''
    }</h1>
    ${metas([
      `${when(seg.start_ms, session?.offset_min ?? 0)} → ${when(seg.end_ms, session?.offset_min ?? 0)}`,
      dur(seg.duration_s),
      `${dur(seg.engaged_s)} in combat`,
      session ? `run ${index + 1} of ${siblings.length} in this session` : null,
      session ? `${pct(runTotal, sessionTotal, 0)} of the session's output` : null,
      specGuess ? `spec inferred from ${specEvidenceText(specGuess)}` : null,
    ])}
    ${cards([
      { k: `${t.kind} per second`, v: num(t.rate), hint: unit, lead: true },
      { k: `${t.kind} done`, v: num(t.total) },
      { k: `${t.otherKind} done`, v: num(t.otherTotal) },
      { k: 'damage taken', v: num(seg.damage_taken) },
      { k: 'dtps', v: num(dtps) },
      { k: 'field kills', v: num(seg.field_kills), hint: "everyone's" },
      { k: 'your kills', v: num(seg.kills), hint: 'last hit' },
      { k: 'kills / hr', v: perHourLabel(seg.field_kills, seg.duration_s), hint: 'wall clock' },
      { k: 'kills / combat hr', v: perHourLabel(seg.field_kills, seg.engaged_s), hint: 'in combat' },
      { k: 'your deaths', v: num(seg.my_deaths) },
      { k: 'field deaths', v: num(seg.field_deaths), hint: `${num(seg.players_died)} players` },
      { k: 'casts', v: num(seg.casts) },
    ])}
    ${compare}
    ${deathSummary(store.segmentDeaths(seg.id), session?.offset_min ?? 0)}
    ${abilitySections}
    <div class="pager">
      <span>${prev ? `<a href="/run?id=${prev.id}">← ${esc(prev.zone_name)}</a>` : ''}</span>
      <span>${session ? `<a href="/session?id=${session.id}">all runs in this session</a>` : ''}</span>
      <span class="next">${next ? `<a href="/run?id=${next.id}">${esc(next.zone_name)} →</a>` : ''}</span>
    </div>`;

  return page(`${seg.zone_name}`, body, { active: 'sessions', ctx });
}


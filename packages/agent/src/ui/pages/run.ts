/**
 * One zone visit — the drill-in.
 *
 * This is the page that answers "how did I actually do in that run": the rate, the abilities that
 * produced it, what hit back, and how it compares with your other runs in the same place. The
 * comparison is the part only this app can offer, because it has every run you have ever logged.
 */
import { distribution } from '../charts';
import { cards, kindPill, metas, page, section } from '../shell';
import { compact, dur, esc, num, pct, when } from '../format';
import { abilityTable, castsByRankTable } from '../parts';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';

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
  const sessionTotal = session ? session.damage_done + session.healing_done : 0;
  const runTotal = seg.damage_done + seg.healing_done;

  // Comparison basis: the same zone on this character, this run excluded.
  const others = store
    .runsForZone(seg.zone_name, 200)
    .filter((r) => r.id !== seg.id)
    .map((r) => throughputFrom(r));
  const comparable = others.filter((o) => o.kind === t.kind && o.rate > 0 && o.total > 0);
  const rates = comparable.map((o) => o.rate).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)]! : 0;
  const best = rates.length ? rates[rates.length - 1]! : 0;
  const unit = t.kind === 'healing' ? 'hps' : 'dps';

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
               [...comparable.map((o) => ({ value: o.rate, title: `${num(o.rate)} ${unit}` })), { value: t.rate }],
               {
                 current: comparable.length,
                 format: (n) => `${compact(n)} ${unit}`,
               },
             )}
             <div class="sub">each dot is one run in this zone; yours is highlighted — ${
               t.rate >= median ? 'above' : 'below'
             } your median.</div>
           </div></div>`,
          `${comparable.length} other run${comparable.length === 1 ? '' : 's'} of this zone logged`,
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
    <h1>${seg.zone_name}${kindPill(seg.kind)}</h1>
    ${metas([
      `${when(seg.start_ms, session?.offset_min ?? 0)} → ${when(seg.end_ms, session?.offset_min ?? 0)}`,
      dur(seg.duration_s),
      `${dur(seg.engaged_s)} in combat`,
      session ? `run ${index + 1} of ${siblings.length} in this session` : null,
      session ? `${pct(runTotal, sessionTotal, 0)} of the session's output` : null,
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
    ${abilitySections}
    <div class="pager">
      <span>${prev ? `<a href="/run?id=${prev.id}">← ${esc(prev.zone_name)}</a>` : ''}</span>
      <span>${session ? `<a href="/session?id=${session.id}">all runs in this session</a>` : ''}</span>
      <span class="next">${next ? `<a href="/run?id=${next.id}">${esc(next.zone_name)} →</a>` : ''}</span>
    </div>`;

  return page(`${seg.zone_name}`, body, { active: 'sessions', ctx });
}


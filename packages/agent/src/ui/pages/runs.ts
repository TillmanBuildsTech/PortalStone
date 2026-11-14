/**
 * Every zone visit, newest first, across all sessions.
 *
 * A session is an evening; a run is one dungeon, battleground or stretch of a zone. This page is the
 * flat list of runs, and every row opens that run's own performance page.
 */
import { cards, kindPill, metas, page, section, table } from '../shell';
import { dur, num, when } from '../format';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';
import type { SegmentRow } from '../../store';

export function renderRuns(ctx: Ctx): string {
  const runs = ctx.store.recentRuns(120);
  const byKind = countKinds(runs);
  const maxRate = Math.max(...runs.map((r) => throughputFrom(r).rate), 1);

  const rows = runs.map((r) => {
    const t = throughputFrom(r);
    const off = ctx.store.session(r.session_id)?.offset_min ?? 0;
    return `<tr>
      <td class="l"><a href="/run?id=${r.id}">${r.zone_name}</a>${kindPill(r.kind)}</td>
      <td class="l">${when(r.start_ms, off)}</td>
      <td>${dur(r.duration_s)}</td>
      <td>${dur(r.engaged_s)}</td>
      <td>${num(t.rate)} <span class="sub">${t.kind === 'healing' ? 'hps' : 'dps'}</span>
        <span class="meter"><i style="width:${((t.rate / maxRate) * 100).toFixed(1)}%;background:${
          t.kind === 'healing' ? '#56d364' : '#6ea8fe'
        }"></i></span></td>
      <td>${num(r.damage_done)}</td>
      <td>${num(r.healing_done)}</td>
      <td>${num(r.damage_taken)}</td>
      <td>${num(r.kills)}</td>
      <td>${num(r.field_kills)}</td>
      <td>${perHourLabel(r.field_kills, r.duration_s)}</td>
      <td>${perHourLabel(r.field_kills, r.engaged_s)}</td>
      <td>${num(r.my_deaths)}</td>
      <td>${num(r.field_deaths)}</td>
      <td><a href="/session?id=${r.session_id}">session</a></td>
    </tr>`;
  });

  const body = `
    <h1>Runs</h1>
    ${metas([
      `${num(runs.length)} zone visit${runs.length === 1 ? '' : 's'}`,
      `${num(byKind.instance)} in instances`,
      'newest first',
    ])}
    ${cards([
      { k: 'dungeons', v: num(byKind.dungeon), lead: true },
      { k: 'raids', v: num(byKind.raid) },
      { k: 'battlegrounds', v: num(byKind.battleground) },
      { k: 'open world', v: num(byKind.zone + byKind.city) },
    ])}
    ${
      runs.length === 0
        ? section('runs', '<div class="empty">No zone visits recorded yet.</div>')
        : section(
            'zone visits',
            table(
              ['zone', 'when', 'length', 'in combat', 'rate', 'damage', 'healing', 'taken', 'your kills', 'field kills', 'kills / hr', 'kills / combat hr', 'your deaths', 'field deaths', 'session'],
              rows,
            ),
            'each row opens that run · field deaths are everyone\'s, not just yours',
          )
    }`;
  return page('Runs', body, { active: 'runs', refresh: 30, ctx });
}

function countKinds(runs: SegmentRow[]): { dungeon: number; raid: number; battleground: number; zone: number; city: number; instance: number } {
  const out = { dungeon: 0, raid: 0, battleground: 0, zone: 0, city: 0, instance: 0 };
  for (const r of runs) {
    if (r.kind === 'dungeon') out.dungeon++;
    else if (r.kind === 'raid') out.raid++;
    else if (r.kind === 'battleground') out.battleground++;
    else if (r.kind === 'city') out.city++;
    else out.zone++;
  }
  out.instance = out.dungeon + out.raid + out.battleground;
  return out;
}

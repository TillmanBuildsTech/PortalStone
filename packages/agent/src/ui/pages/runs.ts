/**
 * Every zone visit, newest first, across all sessions.
 *
 * A session is an evening; a run is one dungeon, battleground or stretch of a zone. This page is the
 * flat list of runs, and every row opens that run's own performance page.
 */
import { cards, characterBar, kindPill, metas, page, section, table, withCharacter } from '../shell';
import { dur, esc, num, when } from '../format';
import type { Ctx } from '../context';
import { perHourLabel, throughputFrom } from './sessionStats';
import type { SegmentRow } from '../../store';

export function renderRuns(ctx: Ctx): string {
  const character = ctx.character;
  const runs = ctx.store.recentRuns(120, character);
  const roster = ctx.store.characters();
  // Two characters in one flat list needs a column saying which is which: a level-15 mage's Durotar
  // run and a level-36 paladin's Hillsbrad run are not rows you can read against each other.
  const showCharacter = character === null && roster.length > 1;
  const byKind = countKinds(runs);
  const maxRate = Math.max(...runs.map((r) => throughputFrom(r).rate), 1);

  const rows = runs.map((r) => {
    const t = throughputFrom(r);
    const off = ctx.store.session(r.session_id)?.offset_min ?? 0;
    const who = showCharacter
      ? `<td class="l"><a href="${withCharacter('/runs', r.character_guid ?? r.character_name)}">${esc(r.character_name || '—')}</a></td>`
      : '';
    return `<tr>
      <td class="l"><a href="/run?id=${r.id}">${r.zone_name}</a>${kindPill(r.kind)}</td>${who}
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
    <h1>Runs${character ? ` · ${esc(ctx.characterName ?? character)}` : ''}</h1>
    ${metas([
      `${num(runs.length)} zone visit${runs.length === 1 ? '' : 's'}`,
      `${num(byKind.instance)} in instances`,
      !character && roster.length > 1 ? `${num(roster.length)} characters` : null,
      'newest first',
    ])}
    ${characterBar(ctx, '/runs')}
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
              [
                'zone',
                ...(showCharacter ? ['character'] : []),
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
                'session',
              ],
              rows,
              { dense: true },
            ),
            'each row opens that run · field deaths are everyone\'s, not just yours',
          )
    }`;
  return page('Runs', body, { active: 'runs', refresh: 30, ctx, scope: true });
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

/**
 * Player-versus-player: who you killed, and — the question this page exists for — who keeps
 * killing you.
 *
 * A combat log records every death with the last hit that caused it, so "who killed me" is not an
 * inference: it is the attacker on the killing blow. Two consequences shape the page:
 *
 *   - the opponent is a *person*, never a mob and never a spell. The ability is shown beside the
 *     name as evidence, because "Shadow Bolt" tells you what to interrupt next time.
 *   - one event is one row. Counting opponents rather than events is what lets the page say
 *     "this one has killed you four times", which a per-session counter can never answer.
 *
 * Everything here comes from the log alone. No score, no rating, no "skill" — just the exchanges.
 */
import { cards, characterBar, emptyState, metas, page, section, table } from '../shell';
import { esc, num, when } from '../format';
import type { Ctx } from '../context';
import type { PvpOpponentRow } from '../../store';

export function renderPvp(ctx: Ctx): string {
  const character = ctx.character;
  const store = ctx.store;
  const summary = store.pvpSummary(character);
  const killed = store.pvpOpponents('kill', character, 60);
  const killers = store.pvpOpponents('death', character, 60);
  const recent = store.pvpEvents(character, 80);
  // Times are shown on the clock of the character's own log, so a death reads on the same clock
  // as the session it happened in.
  const tz = store.listSessions(1, character)[0]?.offset_min ?? 0;

  const repeatKillers = killers.filter((k) => k.times > 1);
  const worst = killers[0];

  if (summary.kills + summary.deaths === 0) {
    return page(
      'PvP',
      `<h1>PvP${character ? ` · ${character}` : ''}</h1>
       ${metas(['nothing recorded'])}
       ${characterBar(ctx, '/pvp')}
       ${emptyState(
         'No player has killed or been killed by you in the logs on this machine.',
         `Player deaths are only counted when the combat log names a player on both sides of the
          killing blow. A death to a creature is PvE and belongs on the session page. If you have
          been fighting players since the last scan, wait for the next pass.`,
       )}`,
      { active: 'pvp', refresh: 30, ctx, scope: true },
    );
  }

  const body = `
    <h1>PvP${character ? ` · ${character}` : ''}</h1>
    ${metas([
      `${num(summary.kills)} player kill${summary.kills === 1 ? '' : 's'}`,
      `${num(summary.deaths)} death${summary.deaths === 1 ? '' : 's'} to players`,
      summary.lastMs ? `last exchange ${when(summary.lastMs, tz)}` : null,
      !character ? 'every character' : null,
    ])}
    ${characterBar(ctx, '/pvp')}
    ${cards([
      { k: 'player kills', v: num(summary.kills), lead: true },
      { k: 'killed by players', v: num(summary.deaths) },
      { k: 'k/d', v: summary.deaths === 0 ? '—' : (summary.kills / summary.deaths).toFixed(2) },
      { k: 'players you killed', v: num(summary.opponents) },
      { k: 'players who killed you', v: num(summary.killers) },
      {
        k: 'came back for more',
        v: num(summary.repeatKillers),
        hint: summary.repeatKillers === 1 ? '1 killer, 2+ deaths' : 'killers with 2+ deaths',
      },
    ])}
    ${
      worst && worst.times > 1
        ? `<div class="notice warn">
             <b>${esc(worst.opponent_name)}</b> has killed you ${worst.times} times${
               worst.spell ? ` — the last one with <span class="mono">${esc(worst.spell)}</span>` : ''
             }, from ${when(worst.first_ms, tz)} to ${when(worst.last_ms, tz)}${
               worst.zones > 1 ? ` across ${worst.zones} zones` : ''
             }.
           </div>`
        : ''
    }
    ${section(
      'who killed you',
      table(
        ['player', 'deaths', 'first', 'last', 'zones', 'last hit by'],
        killers.map((k) => row(k, tz)),
        { empty: 'No player has landed a killing blow on you.' },
      ),
      'landed the killing blow · most frequent first',
    )}
    ${
      repeatKillers.length
        ? section(
            'killed you more than once',
            table(
              ['player', 'deaths', 'first', 'last', 'zones', 'last hit by'],
              repeatKillers.map((k) => row(k, tz)),
            ),
            'the same player, more than once — the list worth remembering before you go back',
          )
        : ''
    }
    ${section(
      'who you killed',
      table(
        ['player', 'kills', 'first', 'last', 'zones', 'your last hit with'],
        killed.map((k) => row(k, tz)),
        { empty: 'You have not landed a killing blow on another player yet.' },
      ),
      'your killing blows on players only · creatures are on the session page',
    )}
    ${section(
      'every exchange',
      table(
        ['when', 'who', 'what happened', 'where', 'last hit by'],
        recent.map(
          (e) => `<tr>
            <td class="l">${when(e.ts_ms, tz)}</td>
            <td class="l">${esc(e.opponent_name)}</td>
            <td class="l">${
              e.direction === 'kill'
                ? '<span class="pill ok">you killed them</span>'
                : '<span class="pill bad">they killed you</span>'
            }</td>
            <td class="l">${esc(e.zone_name || '—')}${
              e.zone_kind && e.zone_kind !== 'zone' ? ` <span class="pill ${esc(e.zone_kind)}">${esc(e.zone_kind)}</span>` : ''
            }</td>
            <td class="l"><span class="mono">${esc(e.spell || '—')}</span></td>
          </tr>`,
        ),
        { empty: 'Nothing recorded yet.' },
      ),
      'newest first · one row per death, so the counts add up to the cards above',
    )}`;
  return page('PvP', body, { active: 'pvp', refresh: 30, ctx, scope: true });
}

function row(k: PvpOpponentRow, tz: number): string {
  return `<tr>
    <td class="l">${esc(k.opponent_name)}${k.times > 1 ? ` <span class="pill warn">×${k.times}</span>` : ''}</td>
    <td>${num(k.times)}</td>
    <td class="l">${when(k.first_ms, tz)}</td>
    <td class="l">${when(k.last_ms, tz)}</td>
    <td>${num(k.zones)}</td>
    <td class="l"><span class="mono">${esc(k.spell || '—')}</span></td>
  </tr>`;
}

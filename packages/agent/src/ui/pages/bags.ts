/**
 * Bag drops: one row per "Unroll Bag" cast — who, when, where.
 *
 * This page shows nothing inferred. The camp buffs a bag hands out are applied per player with no
 * link to the bag, so "who shared it" is not knowable from a combat log — only the drops are.
 */
import { cards, metas, page, section, table } from '../shell';
import { ago, num, when } from '../format';
import type { Ctx } from '../context';

export function renderBags(ctx: Ctx): string {
  const drops = ctx.store.bagDrops(300);
  const stats = ctx.store.bagDropStats();

  const rows = drops.map(
    (d) => `<tr>
      <td class="l">${when(d.ts_ms)}</td>
      <td class="l">${d.mine ? `<strong>${d.name ?? 'you'}</strong>` : (d.name ?? 'unknown')}</td>
      <td class="l">${d.zone_name || '—'}</td>
      <td>${d.x === null || d.y === null ? '—' : `${d.x.toFixed(0)}, ${d.y.toFixed(0)}`}</td>
    </tr>`,
  );

  const people = stats.droppers.map((p) => `${p.mine ? `<strong>${p.name}</strong> (you)` : p.name} — ${p.count}`);
  const zones = stats.zones.map((z) => `${z.zone_name} — ${z.count}`);

  const body = `
    <h1>Bags</h1>
    ${metas([
      `${num(stats.total)} drop${stats.total === 1 ? '' : 's'}`,
      `${num(stats.mine)} yours`,
      `${num(stats.droppers.length)} player${stats.droppers.length === 1 ? '' : 's'}`,
      drops[0] ? `last drop ${ago(drops[0].ts_ms)}` : null,
    ])}
    ${cards([
      { k: 'drops', v: num(stats.total), lead: true },
      { k: 'yours', v: num(stats.mine) },
      { k: 'players', v: num(stats.droppers.length) },
      { k: 'places', v: num(stats.zones.length) },
    ])}
    ${
      stats.total === 0
        ? `<div class="notice">No bag drops recorded yet. Unroll a bag in game and the next scan will
             pick it up.</div>`
        : `<div class="row">
            <div class="col">${section(
              'who drops bags',
              `<ul class="plain">${people.map((p) => `<li>${p}</li>`).join('')}</ul>`,
            )}</div>
            <div class="col">${section(
              'where',
              `<ul class="plain">${zones.map((z) => `<li>${z}</li>`).join('')}</ul>`,
            )}</div>
          </div>
          ${section('every drop', table(['when', 'who', 'zone', 'position'], rows), 'position is the log\'s map coordinate')}`
    }
    <div class="notice" style="margin-top:20px">
      A drop is the "Unroll Bag" cast: the only sleeping-bag event in the log. The buffs a bag gives
      (Well-Rested, Camp Benefits, Boosted Rest) are applied to each player by themselves and never
      name the bag that caused them, so who shared a bag is not recorded and is not guessed at here.
    </div>`;
  return page('Bags', body, { active: 'bags', refresh: 30, ctx });
}

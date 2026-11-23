/**
 * Pieces shared between the session page and the run page.
 *
 * The ability table merges by name on purpose: spell ranks share a name (Holy Light appears twice
 * with separate ids), and a player recognises one line per spell. The ids stay in the store.
 */
import type { AbilityRow, DeathSummaryRow } from '../store';
import { meter } from './charts';
import { esc, num, pct, when } from './format';
import { section } from './shell';

export interface AbilityTableOptions {
  title: string;
  kind: 'damage' | 'healing' | 'taken';
  rows: AbilityRow[];
  /** the denominator for the share column: damage done, healing done, damage taken */
  total: number;
  empty: string;
  hint?: string;
  limit?: number;
}

export function abilityTable(opts: AbilityTableOptions): string {
  const merged = mergeByName(opts.rows).slice(0, opts.limit ?? 12);
  if (merged.length === 0) return section(opts.title, `<div class="empty">${esc(opts.empty)}</div>`, opts.hint);
  const rows = merged.map(
    (a) => `<tr>
      <td class="l">${esc(a.name)}</td>
      <td>${num(a.amount)}</td>
      <td>${num(a.hits)}</td>
      <td>${num(a.hits ? Math.round(a.amount / a.hits) : 0)}</td>
      <td>${pct(a.amount, opts.total)}${meter(a.amount / Math.max(opts.total, 1), opts.kind)}</td>
    </tr>`,
  );
  return section(
    opts.title,
    `<div class="scroll"><table><thead><tr><th class="l">ability</th><th>total</th><th>hits</th>
      <th>avg</th><th>share</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
    opts.hint,
  );
}

export function mergeByName(rows: AbilityRow[]): AbilityRow[] {
  const byName = new Map<string, AbilityRow>();
  for (const a of rows) {
    const cur = byName.get(a.name);
    if (cur) {
      cur.amount += a.amount;
      cur.hits += a.hits;
    } else {
      byName.set(a.name, { spell_id: a.spell_id, name: a.name, amount: a.amount, hits: a.hits });
    }
  }
  return [...byName.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Casts, one row per spell id.
 *
 * Two ranks of one spell are indistinguishable by name in the log, and the rank number is not
 * written down at all — only the id differs. So this table is the honest form of "rank 3 vs rank 5":
 * same spell, separate ids, separate cast counts, and the average effect of each id where the
 * damage or healing table knows it.
 */
export function castsByRankTable(opts: {
  rows: AbilityRow[];
  /** spell id -> average amount per hit, from the damage/healing tables */
  averages: Map<number, number>;
  empty: string;
  limit?: number;
}): string {
  const rows = opts.rows.slice(0, opts.limit ?? 24);
  if (rows.length === 0) return `<div class="empty">${esc(opts.empty)}</div>`;

  // Group by name, biggest spell first, then within a spell by how often each id was cast.
  const groups = new Map<string, AbilityRow[]>();
  for (const row of rows) {
    const list = groups.get(row.name) ?? [];
    list.push(row);
    groups.set(row.name, list);
  }
  const ordered = [...groups.entries()]
    .map(([name, list]) => ({ name, list: [...list].sort((a, b) => b.amount - a.amount), total: list.reduce((a, r) => a + r.amount, 0) }))
    .sort((a, b) => b.total - a.total);

  const body = ordered.flatMap(({ name, list, total }) =>
    list.map(
      (r) => `<tr>
        <td class="l">${esc(name)}</td>
        <td>${num(r.spell_id)}</td>
        <td>${num(r.amount)}</td>
        <td>${pct(r.amount, total)}${meter(r.amount / Math.max(total, 1), 'damage')}</td>
        <td>${opts.averages.has(r.spell_id) ? num(opts.averages.get(r.spell_id)!) : '—'}</td>
      </tr>`,
    ),
  );

  return `<div class="scroll"><table><thead><tr><th class="l">spell</th><th>id</th><th>casts</th>
    <th>share of spell</th><th>avg</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}

/**
 * What killed you — grouped by killer and finishing blow.
 *
 * The log names only the last hit, so a hunter's pet or a fall is what shows; it is the honest
 * answer to "what killed you", not a full recap of the seconds before (the log is aggregated to
 * counts, so those seconds are not kept). Empty renders nothing: a deathless session says nothing
 * rather than an empty table.
 */
export function deathSummary(rows: DeathSummaryRow[], offsetMin: number): string {
  if (rows.length === 0) return '';
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const body = rows.map((r) => {
    const killer = r.killer && r.killer !== 'unknown' ? esc(r.killer) : '<span class="sub">unknown</span>';
    const player = r.killer_player ? ' <span class="pill">player</span>' : '';
    return `<tr>
      <td class="l">${killer}${player}</td>
      <td>${r.n > 1 ? `×${num(r.n)}` : num(r.n)}</td>
      <td>${r.spell ? esc(r.spell) : '<span class="sub">—</span>'}</td>
      <td>${when(r.last_ms, offsetMin)}</td>
    </tr>`;
  });
  return section(
    'what killed you',
    `<div class="scroll"><table><thead><tr><th class="l">killer</th><th>deaths</th>
      <th>finishing blow</th><th>last</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`,
    `${num(total)} death${total === 1 ? '' : 's'} · the last hit on you — a pet or a fall can land it, so it is the finisher, not the whole story`,
  );
}

/** "Judgement of Fury 41%" — the one-line answer under a headline number. */
export function topAbilityLine(rows: AbilityRow[], total: number, label: string): string {
  const top = mergeByName(rows)[0];
  if (!top || total <= 0) return '';
  return `${esc(top.name)} was ${pct(top.amount, total)} of your ${label}`;
}

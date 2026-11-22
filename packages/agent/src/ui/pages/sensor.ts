/**
 * The sensor page: what our own addon knows that the combat log does not.
 *
 * The point of the page is not decoration, it is provenance. A spec chip on a session is an
 * inference from abilities; here the same character's tree is the tree the client reported, with
 * the timestamp of the observation. Keeping the two visible side by side is how a reader learns to
 * trust the chip when the log has evidence and to distrust it when it does not.
 */
import { dur, esc, num, quantity, when } from '../format';
import { emptyState, metas, page, section, table } from '../shell';
import type { Ctx } from '../context';
import { sameCharacter } from '../../characters';
import { readSensor, SENSOR_FILE, type SensorCharacter } from '../../sensor';

export function renderSensor(ctx: Ctx): string {
  const read = readSensor(ctx.installs);

  if (read.file === null) {
    return page(
      'Sensor',
      `
      <h1>Sensor</h1>
      ${metas(["the addon that records what the combat log can't"])}
      ${emptyState(
        `Not installed. ${SENSOR_FILE} is the one addon this project controls: it writes spec and
         talent build, gear and item level, professions, lockouts, played time and group composition
         to its own SavedVariables file, and this page reads it.`,
        `<div class="sub" style="margin-top:10px">Install with <span class="mono">npm run addon:install</span>,
          then <span class="mono">/reload</span> in game. Data appears after the next logout or reload flush.</div>`,
      )}`,
      { active: 'sensor', ctx },
    );
  }

  const chars = read.chars.filter((c) => (ctx.character ? sameCharacter(c.key, ctx.character) : true));

  const head = `
    <div class="crumbs"><a href="/">sessions</a> <span>/</span> <span>sensor</span></div>
    <h1>Sensor</h1>
    ${metas([
      esc(SENSOR_FILE),
      read.files.length > 1
        ? `${num(read.files.length)} accounts · last flush ${when(read.files[0]!.mtimeMs, 0)}`
        : read.file
          ? `flushed ${when(read.file.mtimeMs, 0)}`
          : null,
      `${num(read.chars.length)} character${read.chars.length === 1 ? '' : 's'}`,
      ctx.character ? `scoped to ${esc(ctx.character)}` : null,
    ])}`;

  if (read.state !== 'ok') {
    return page(
      'Sensor',
      `${head}${emptyState(
        read.state === 'empty'
          ? 'The addon is installed but has written nothing yet: /reload in game to flush it.'
          : `The file could not be read: ${read.reason ?? 'unknown reason'}.`,
      )}`,
      { active: 'sensor', ctx },
    );
  }

  if (chars.length === 0) {
    return page('Sensor', `${head}${emptyState('No character in this flush matches the current scope.')}`, {
      active: 'sensor',
      ctx,
    });
  }

  // Account labels only earn their space when there is more than one account to tell apart.
  const showAccount = read.files.length > 1;
  const body = `${head}
    ${read.skipped.length > 0 ? `<div class="sub">not shown: ${read.skipped.map(esc).join('<br>')}</div>` : ''}
    ${chars.map((c) => characterSection(c, showAccount)).join('\n')}
    ${section(
      'what this buys the rest of the app',
      `<div class="sub">Spec chips on sessions and runs are inferred from abilities, because the combat
        log has no talent event. With the sensor writing, a character's build has a recorded answer
        with a timestamp, and the two can be read against each other.</div>`,
    )}`;

  return page('Sensor', body, { active: 'sensor', ctx });
}

function characterSection(c: SensorCharacter, showAccount: boolean): string {
  const spec = c.spec;
  const specLabel = spec?.name
    ? `${spec.name}${spec.build ? ` <span class="sub">${esc(spec.build)}</span>` : ''}`
    : '<span class="sub">not recorded</span>';

  const top = section(
    // section() escapes its title, so this is plain text: markup here would print as tags.
    [c.key, c.meta.realm, showAccount ? `account ${c.account}` : null].filter(Boolean).join(' · '),
    `<div class="cards">
      ${card('level', c.meta.level === null ? '—' : num(c.meta.level), [c.meta.race, c.meta.class].filter(Boolean).join(' ') || undefined)}
      ${card('spec', specLabel, spec?.role ? spec.role.toLowerCase() : spec?.points ? `${spec.points} points` : undefined)}
      ${card('item level', c.gear?.ilvl === null || !c.gear ? '—' : num(c.gear.ilvl), c.gear?.equipped ? `${c.gear.equipped} slots` : undefined)}
      ${card('played', c.played?.total === null || !c.played ? '—' : dur(c.played.total), c.played?.atLevel ? `${dur(c.played.atLevel)} at level` : undefined)}
      ${card('gold', c.money === null ? '—' : quantity(c.money, 'copper'))}
      ${card('zone', esc(c.meta.zone ?? '—'), c.meta.guild ? esc(c.meta.guild) : undefined)}
    </div>`,
    c.meta.updatedMs ? `observed ${when(c.meta.updatedMs, 0)} · SavedVariables flush, not live` : undefined,
  );

  const tabs = spec?.tabs.length
    ? table(
        ['tree', 'points'],
        spec.tabs.map((t) => `<tr><td class="l">${esc(t.name)}</td><td>${num(t.points)}</td></tr>`),
        { left: [0] },
      )
    : '';

  const history = c.history.length
    ? table(
        ['observed', 'spec', 'build', 'points'],
        [...c.history].reverse().map(
          (h) =>
            `<tr><td class="l">${h.atMs ? when(h.atMs, 0) : '—'}</td><td>${esc(h.spec ?? '—')}</td>
             <td>${esc(h.build ?? '—')}</td><td>${num(h.points ?? 0)}</td></tr>`,
        ),
        { left: [0, 1, 2] },
      )
    : '';

  const specSection = spec
    ? section(
        'spec and talents',
        (tabs ? `<div class="sub" style="margin-bottom:8px">talent points per tree, as the client reported them</div>${tabs}` : '') +
          (history
            ? `<div class="sub" style="margin:12px 0 8px">every change the addon saw, newest first — a respec between two logouts leaves no other trace</div>${history}`
            : '<div class="sub">No change recorded yet: this is the first observation.</div>'),
        spec.updatedMs ? `recorded ${when(spec.updatedMs, 0)}${spec.group ? ` · talent group ${spec.group}` : ''}` : undefined,
      )
    : '';

  const stats = Object.entries(c.stats);
  const statsSection = stats.length
    ? section(
        'paper doll',
        table(
          ['stat', 'value'],
          stats
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, v]) => `<tr><td class="l">${esc(k)}</td><td>${num(v)}</td></tr>`),
          { left: [0] },
        ),
        'whatever this client could answer; a missing stat is an absent API, not a zero',
      )
    : '';

  const professions = c.professions.length
    ? section(
        'professions',
        table(
          ['profession', 'skill', 'max'],
          c.professions.map(
            (p) => `<tr><td class="l">${esc(p.name)}</td><td>${num(p.skill ?? 0)}</td><td>${num(p.max ?? 0)}</td></tr>`,
          ),
          { left: [0] },
        ),
      )
    : '';

  const gear = c.gear && c.gear.slots.length
    ? section(
        'equipped',
        table(
          ['slot', 'item', 'ilvl'],
          c.gear.slots.map(
            (s) =>
              `<tr><td class="l">${slotName(s.slot)}</td><td>${esc(s.name ?? String(s.id ?? '—'))}</td><td>${num(s.ilvl ?? 0)}</td></tr>`,
          ),
          { left: [0, 1] },
        ),
        'item ids are what benchmarks need; names are what the client had cached',
      )
    : '';

  const lockouts = c.lockouts.length
    ? section(
        'saved instances',
        table(
          ['raid', 'difficulty', 'state'],
          c.lockouts.map(
            (l) =>
              `<tr><td class="l">${esc(l.name)}</td><td>${l.difficulty === null ? '—' : num(l.difficulty)}</td>
               <td>${l.extended ? 'extended' : l.locked ? 'locked' : 'open'}</td></tr>`,
          ),
          { left: [0] },
        ),
        'the only local evidence a reset has been spent',
      )
    : '';

  const group = c.group.length
    ? section(
        'group',
        table(
          ['name', 'class', 'level', 'role'],
          c.group.map(
            (g) =>
              `<tr><td class="l">${esc(g.name)}</td><td>${esc(g.class ?? '—')}</td>
               <td>${g.level === null ? '—' : num(g.level)}</td><td>${esc(g.role ?? '—')}</td></tr>`,
          ),
          { left: [0] },
        ),
        'who was there at the last flush: the only way to normalise a run by who ran it',
      )
    : '';

  return `${top}${specSection}${statsSection}${professions}${gear}${lockouts}${group}`;
}

/** Local card markup: the shell's `cards()` takes a plain value, these carry inline markup. */
function card(k: string, v: string, hint?: string): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${v}${
    hint ? ` <small>${esc(hint)}</small>` : ''
  }</div></div>`;
}

const SLOT_NAMES: Record<number, string> = {
  0: 'ammo',
  1: 'head',
  2: 'neck',
  3: 'shoulder',
  4: 'shirt',
  5: 'chest',
  6: 'waist',
  7: 'legs',
  8: 'feet',
  9: 'wrist',
  10: 'hands',
  11: 'ring 1',
  12: 'ring 2',
  13: 'trinket 1',
  14: 'trinket 2',
  15: 'back',
  16: 'main hand',
  17: 'off hand',
  18: 'ranged',
  19: 'tabard',
};

function slotName(slot: number): string {
  return SLOT_NAMES[slot] ?? `slot ${slot}`;
}

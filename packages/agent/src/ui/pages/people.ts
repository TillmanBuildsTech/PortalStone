/**
 * People: who you have played with.
 *
 * Not a social network — a record. Every combat-log line stamps each unit with its affiliation,
 * and a party or raid bit means "grouped with me". Fold those sightings over every session and you
 * get the one thing only this app can tell you: the people you actually keep grouping with, ranked
 * by how many evenings you have shared, with a profile for each that lists those evenings.
 *
 * Everything here is grouped by guid, a player's stable identity, so the same person across a year
 * of sessions is one row — never split by a name they share with someone on another realm.
 */
import { cards, emptyState, metas, page, section, table, withCharacter } from '../shell';
import { ago, dur, esc, num, when } from '../format';
import type { Ctx } from '../context';
import type { CompanionRow, CompanionPresenceRow, CompanionSessionRow } from '../../store';

/** A party / raid context chip, matching the zone-kind colours used elsewhere. */
function contextPill(inParty: number, inRaid: number): string {
  if (inParty && inRaid) return '<span class="pill">party &amp; raid</span>';
  if (inRaid) return '<span class="pill raid">raid</span>';
  if (inParty) return '<span class="pill dungeon">party</span>';
  return '<span class="pill">grouped</span>';
}

/** Link to a companion's profile, keeping the chosen character in scope. */
function personHref(ctx: Ctx, guid: string): string {
  return withCharacter(`/person?guid=${encodeURIComponent(guid)}`, ctx.character);
}

/**
 * The "grouped with" roster for one session or run, shared by both pages. Returns '' when nobody
 * was grouped — solo play is the common case and an empty section would only be noise. Names link
 * to the person's all-time profile, scoped to the character whose run this was.
 */
export function companionRoster(
  title: string,
  companions: CompanionPresenceRow[],
  opts: { tz: number; char: string | null; hint?: string },
): string {
  if (companions.length === 0) return '';
  const href = (guid: string): string =>
    withCharacter(`/person?guid=${encodeURIComponent(guid)}`, opts.char);
  const rows = companions.map(
    (c) => `<tr>
      <td class="l"><a href="${href(c.guid)}">${esc(c.name)}</a></td>
      <td class="l">${contextPill(c.in_party, c.in_raid)}</td>
      <td>${num(c.events)}</td>
      <td class="l">${when(c.first_ms, opts.tz)} → ${when(c.last_ms, opts.tz)}</td>
    </tr>`,
  );
  return section(
    title,
    table(['player', 'context', 'interactions', 'while grouped'], rows),
    opts.hint ?? `${companions.length} player${companions.length === 1 ? '' : 's'} grouped · click a name for every time you have grouped`,
  );
}

export function renderPeople(ctx: Ctx): string {
  const { store, character } = ctx;
  const summary = store.companionSummary(character);
  const people = store.companions(character, 200);
  const tz = store.listSessions(1, character)[0]?.offset_min ?? 0;
  const who = character ? ` · ${esc(ctx.characterName ?? character)}` : '';

  if (summary.people === 0) {
    return page(
      'People',
      `<h1>People${who}</h1>
       ${metas(['nobody recorded yet'])}
       ${emptyState(
         'No grouped players found in the logs on this machine yet.',
         `A player is counted here only when the combat log marks them as a party or raid member —
          that is what "grouped with you" means. Quest, run a dungeon or play a battleground with
          other people, and they will appear here after the next scan.`,
       )}`,
      { active: 'people', refresh: 60, ctx, scope: true },
    );
  }

  const top = people[0];
  const body = `
    <h1>People${who}</h1>
    ${metas([
      `${num(summary.people)} ${summary.people === 1 ? 'person' : 'people'}`,
      `across ${num(summary.sessions)} session${summary.sessions === 1 ? '' : 's'}`,
      summary.lastMs ? `last grouped ${ago(summary.lastMs)}` : null,
      !character ? 'every character' : null,
    ])}
    ${cards([
      { k: 'people grouped with', v: num(summary.people), lead: true },
      { k: 'sessions with company', v: num(summary.sessions) },
      { k: 'most-played-with', v: top ? esc(top.name) : '—', hint: top ? `${top.sessions} session${top.sessions === 1 ? '' : 's'}` : '' },
    ])}
    ${
      top && top.sessions > 1
        ? `<div class="notice">You have grouped with <b>${esc(top.name)}</b> across ${top.sessions} session${
            top.sessions === 1 ? '' : 's'
          }${top.runs ? ` and ${top.runs} instanced run${top.runs === 1 ? '' : 's'}` : ''}, from ${when(
            top.first_ms,
            tz,
          )} to ${when(top.last_ms, tz)}. <a href="${personHref(ctx, top.guid)}">See every time.</a></div>`
        : ''
    }
    ${section(
      'everyone you have grouped with',
      table(
        ['player', 'sessions together', 'runs', 'zones', 'context', 'first', 'last'],
        people.map((p) => peopleRow(ctx, p, tz)),
        { empty: 'Nobody recorded yet.' },
      ),
      'most sessions together first · a session is one evening, however long · click a name for every time',
    )}`;
  return page('People', body, { active: 'people', refresh: 60, ctx, scope: true });
}

function peopleRow(ctx: Ctx, p: CompanionRow, tz: number): string {
  return `<tr>
    <td class="l"><a href="${personHref(ctx, p.guid)}">${esc(p.name)}</a>${
      p.sessions > 1 ? ` <span class="pill warn">×${p.sessions}</span>` : ''
    }</td>
    <td>${num(p.sessions)}</td>
    <td>${num(p.runs)}</td>
    <td>${num(p.zones)}</td>
    <td class="l">${contextPill(p.in_party, p.in_raid)}</td>
    <td class="l">${when(p.first_ms, tz)}</td>
    <td class="l">${when(p.last_ms, tz)}</td>
  </tr>`;
}

/** One companion's profile: their totals, and every session you shared with them. */
export function renderPerson(ctx: Ctx, guid: string): string | null {
  const { store, character } = ctx;
  const comp = store.companion(guid, character);
  if (!comp) return null;
  const sessions = store.companionSessions(guid, character, 200);
  const tz = sessions[0]?.offset_min ?? store.listSessions(1, character)[0]?.offset_min ?? 0;
  const who = character ? ` on ${esc(ctx.characterName ?? character)}` : '';

  const body = `
    <div class="crumbs"><a href="${withCharacter('/people', character)}">people</a> <span>/</span> <span>${esc(
      comp.name,
    )}</span></div>
    <h1>${esc(comp.name)} ${contextPill(comp.in_party, comp.in_raid)}</h1>
    ${metas([
      `grouped${who}`,
      `${num(comp.sessions)} session${comp.sessions === 1 ? '' : 's'} together`,
      `${when(comp.first_ms, tz)} → ${when(comp.last_ms, tz)}`,
    ])}
    ${cards([
      { k: 'sessions together', v: num(comp.sessions), lead: true },
      { k: 'instanced runs', v: num(comp.runs), hint: 'dungeon · raid · bg' },
      { k: 'zones', v: num(comp.zones) },
      { k: 'interactions', v: num(comp.events), hint: 'events seen together' },
    ])}
    ${section(
      'every time you grouped',
      table(
        ['when', 'session', 'character', 'context', 'interactions'],
        sessions.map((s) => personSessionRow(s, tz)),
        { empty: 'No shared sessions recorded.' },
      ),
      'newest first · one row per evening you were grouped',
    )}`;
  return page(comp.name, body, { active: 'people', ctx });
}

function personSessionRow(s: CompanionSessionRow, tz: number): string {
  return `<tr>
    <td class="l">${when(s.start_ms, s.offset_min || tz)}</td>
    <td class="l"><a href="/session?id=${s.session_id}">${esc(s.zone_name || 'session')}</a>
      <span class="sub">${dur((s.end_ms ?? s.start_ms) - s.start_ms >= 0 ? ((s.end_ms ?? s.start_ms) - s.start_ms) / 1000 : 0)}</span></td>
    <td class="l">${s.character_name ? esc(s.character_name) : '—'}</td>
    <td class="l">${contextPill(s.in_party, s.in_raid)}</td>
    <td>${num(s.events)}</td>
  </tr>`;
}

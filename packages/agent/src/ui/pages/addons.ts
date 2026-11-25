/**
 * Which addons PortalStone is set up to read, and which are still only candidates.
 *
 * "Configured" is about the app, not the addon: an addon is configured when at least one tracked
 * value reads from it. Everything else with readable data is available to configure — one link away
 * from picking a property. Freshness is a separate column (`in use` / `idle`), and an addon with a
 * folder but no SavedVariables is `no saved data` rather than "missing".
 *
 * One flavor only for now: Forever.
 */
import { ADDONS_FLAVOR, listAddonEntries, readAddon, type AddonEntry, type AddonStatus } from '../../addons';
import { cards, emptyState, metas, page, section, table } from '../shell';
import { ago, esc, num, plural, size } from '../format';
import type { Ctx } from '../context';

const STATUS_LABEL: Record<AddonStatus, string> = {
  'in-use': 'in use',
  idle: 'idle',
  empty: 'no data',
  unreadable: 'unreadable',
  'no-data': 'no saved data',
};

function statusPill(status: AddonStatus): string {
  const tone = status === 'in-use' ? 'ok' : status === 'idle' ? 'warn' : status === 'unreadable' ? 'bad' : '';
  return `<span class="pill ${tone}">${STATUS_LABEL[status]}</span>`;
}

/** Addon name, with the SavedVariables file underneath when they differ. */
function addonCell(e: AddonEntry): string {
  const globals = e.file ? readAddon(e.file).summaries.map((s) => s.name).join(', ') : '';
  const label = globals ? `<a href="/addon?f=${e.file!.id}">${esc(globals)}</a>` : esc(e.name);
  return `<td class="l">${label}<div class="sub mono">${esc(e.name)}${e.installed ? '' : ' · folder gone'}</div></td>`;
}

export function renderAddons(ctx: Ctx): string {
  const tracked = ctx.store.trackedMetrics().map((m) => ({ addonFile: m.addon_file, label: m.label }));
  const entries = listAddonEntries(ctx.installs, { flavor: ADDONS_FLAVOR, tracked });
  const addons = entries.filter((e) => !e.builtIn);
  const configured = addons.filter((e) => e.configured);
  // Available = readable, but nothing tracked from it yet.
  const available = addons.filter((e) => !e.configured && (e.status === 'in-use' || e.status === 'idle'));
  const noData = addons.filter((e) => e.status === 'no-data');
  const unreadable = addons.filter((e) => e.status === 'unreadable');
  const builtIns = entries.filter((e) => e.builtIn);
  const trackedCount = configured.reduce((a, e) => a + e.tracked.length, 0);

  if (entries.length === 0) {
    return page(
      'Addons',
      `<h1>Addons</h1>
       ${metas([`${ADDONS_FLAVOR} only`])}
       ${emptyState(
         'No Forever install found.',
         'Set <span class="mono">PORTALSTONE_WOW_DIR</span> to the World of Warcraft folder, or run with <span class="mono">--install</span>.',
       )}`,
      { active: 'addons', refresh: 60, ctx },
    );
  }

  const configuredRows = configured.map(
    (e) => `<tr>
      ${addonCell(e)}
      <td class="l">${e.tracked.map((t) => `<a href="/tracked"><span class="pill ok">${esc(t)}</span></a>`).join(' ')}</td>
      <td class="l">${statusPill(e.status)}</td>
      <td class="l" title="${esc(e.lastSavedMs ? new Date(e.lastSavedMs).toISOString() : '')}">${
        e.lastSavedMs ? ago(e.lastSavedMs) : '—'
      }</td>
      <td>${num(e.globals)}</td>
      <td>${e.file ? size(e.file.bytes) : '—'}</td>
    </tr>`,
  );

  const availableRows = available.map(
    (e) => `<tr>
      ${addonCell(e)}
      <td class="l">${statusPill(e.status)}</td>
      <td class="l">${e.lastSavedMs ? ago(e.lastSavedMs) : '—'}</td>
      <td>${num(e.trackable)}</td>
      <td>${e.file ? size(e.file.bytes) : '—'}</td>
      <td><a href="/addon?f=${e.file?.id ?? ''}">choose values →</a></td>
    </tr>`,
  );

  const body = `
    <h1>Addons</h1>
    ${metas([
      `<span class="pill">${ADDONS_FLAVOR}</span>`,
      `${num(configured.length)} configured`,
      `${num(available.length)} available to configure`,
      `${num(noData.length)} without saved data`,
      unreadable.length ? `<span class="pill bad">${num(unreadable.length)} unreadable</span>` : null,
    ])}
    ${cards([
      { k: 'configured', v: num(configured.length), hint: plural(trackedCount, 'tracked value'), lead: true },
      { k: 'available', v: num(available.length), hint: 'readable, nothing tracked' },
      { k: 'no saved data', v: num(noData.length), hint: 'installed only' },
      { k: 'unreadable', v: num(unreadable.length) },
    ])}
    ${section(
      'configured for tracking',
      table(['addon', 'tracked values', 'data', 'last saved', 'globals', 'file'], configuredRows, {
        left: [0, 1, 2, 3],
        empty: 'No addon is configured yet. Pick one below and track a value from it.',
      }),
      'an addon is configured when at least one tracked value reads from it',
    )}
    ${section(
      'available to configure',
      table(['addon', 'data', 'last saved', 'trackable', 'file', ''], availableRows, {
        left: [0, 1, 2],
        empty: 'Every addon with data is already configured.',
      }),
      'has readable data and numbers that vary — open it and press track',
    )}
    ${
      noData.length
        ? section(
            'installed but never saved',
            `<ul class="plain">${noData.map((e) => `<li>${esc(e.name)}</li>`).join('')}</ul>`,
            `${plural(noData.length, 'addon')} · no SavedVariables at all; some of these are data packs or libraries for another addon`,
          )
        : ''
    }
    ${
      builtIns.length
        ? section(
            'Blizzard built-ins',
            `<div class="sub">${builtIns.map((e) => esc(e.name)).join(' · ')}</div>`,
            `${plural(builtIns.length, 'file')} — the game's own UI settings, not user addons`,
          )
        : ''
    }
    <div class="notice" style="margin-top:24px">
      Showing <b>${ADDONS_FLAVOR}</b> only, for now. <b>Configured</b> means a tracked value reads from
      the addon — not that the addon is installed. <b>Data</b> is the file's own state: <b>in use</b> saved
      within the last week, <b>idle</b> configured but not written lately. SavedVariables are only written
      when the game flushes them: on logout, <span class="mono">/reload</span>, or exit.
    </div>`;
  return page('Addons', body, { active: 'addons', refresh: 60, ctx });
}

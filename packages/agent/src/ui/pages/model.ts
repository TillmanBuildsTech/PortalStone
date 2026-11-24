/**
 * The 3D model page: one character, dressed in the gear the addon recorded.
 *
 * This is the one page that reaches outside the machine. Everything else here reads your own files;
 * rendering a body means loading Wowhead's model engine and its assets from wow.zamimg.com, because
 * nobody else hosts vanilla character models. The item ids come from your capture; only the display
 * ids (resolved and cached) and the model geometry come from the network.
 *
 * A model is inherently about one character, so this page is driven by a sensor character key
 * (`?who=`), not the `?char=` scope the adding-up pages share. The sensor page links here per card.
 */
import { esc, num, when } from '../format';
import { emptyState, metas, page, section } from '../shell';
import { slotName } from '../gear';
import type { Ctx } from '../context';
import { readSensor, SENSOR_FILE, type SensorCharacter } from '../../sensor';
import { equippedItemIds, refreshDisplayIds } from '../../displayIds';
import { genderFromSex, genderIsGuess, isRenderableSlot, raceId } from '../../model';

export interface ModelQuery {
  who?: string | null;
  acct?: string | null;
}

export async function renderModel(ctx: Ctx, q: ModelQuery): Promise<string> {
  const read = readSensor(ctx.installs);

  if (read.file === null || read.state !== 'ok') {
    return page(
      '3D model',
      `${header(null)}${emptyState(
        `A model is built from what ${SENSOR_FILE} records — race, gender and equipped items. The addon
         is not installed or has written nothing yet, so there is nothing to dress.`,
      )}`,
      { active: 'sensor', ctx },
    );
  }

  const target = q.who
    ? read.chars.find((c) => c.key === q.who && (!q.acct || c.account === q.acct))
    : undefined;

  if (!target) {
    return page('3D model', `${header(null)}${chooser(read.chars)}`, { active: 'sensor', ctx });
  }

  const rid = raceId(target.meta.race);
  const gender = genderFromSex(target.meta.sex);
  const genderGuessed = genderIsGuess(target.meta.sex);
  const slots = (target.gear?.slots ?? []).filter((s) => s.id && s.id > 0);

  // Resolve display ids for the renderable, equipped items. Cached; this only hits the network for
  // ids not seen before, and is bounded per call, so a first view is quick and later ones instant.
  const renderable = slots.filter((s) => isRenderableSlot(s.slot));
  const renderableIds = equippedItemIds(renderable);
  let resolveError: string | null = null;
  if (renderableIds.length > 0) {
    try {
      await refreshDisplayIds(ctx.store, renderableIds);
    } catch (err) {
      resolveError = (err as Error).message;
    }
  }
  const display = ctx.store.itemDisplayIds(renderableIds);

  const items = renderable
    .filter((s) => display.has(s.id as number))
    .map((s) => [s.slot, display.get(s.id as number)] as [number, number]);

  const body = `${header(target)}
    ${metas([
      esc(target.meta.name),
      [target.meta.race, target.meta.class].filter(Boolean).map(esc).join(' ') || null,
      target.meta.level !== null ? `level ${num(target.meta.level)}` : null,
      target.gear?.ilvl ? `ilvl ${num(target.gear.ilvl)}` : null,
      target.meta.updatedMs ? `gear seen ${when(target.meta.updatedMs, 0)}` : null,
    ])}
    ${stage(target, rid, gender, genderGuessed, items, slots, display, resolveError)}`;

  return page('3D model', body, { active: 'sensor', ctx });
}

function header(target: SensorCharacter | null): string {
  const crumb = target ? esc(target.meta.name) : '3D model';
  return `
    <div class="crumbs"><a href="/">sessions</a> <span>/</span> <a href="/sensor">sensor</a> <span>/</span> <span>${crumb}</span></div>
    <h1>3D model</h1>`;
}

function chooser(chars: SensorCharacter[]): string {
  if (chars.length === 0) return emptyState('No character in the sensor data to model yet.');
  const withGear = chars.filter((c) => (c.gear?.slots?.length ?? 0) > 0);
  const list = (withGear.length > 0 ? withGear : chars)
    .map(
      (c) =>
        `<li><a href="/model?who=${encodeURIComponent(c.key)}&amp;acct=${encodeURIComponent(c.account)}">${esc(
          c.meta.name,
        )}</a> <span class="sub">${[c.meta.race, c.meta.class].filter(Boolean).map(esc).join(' ')}${
          c.gear?.equipped ? ` · ${num(c.gear.equipped)} equipped` : ' · no gear captured'
        }</span></li>`,
    )
    .join('');
  return section('Pick a character', `<ul class="plain">${list}</ul>`);
}

/** The viewer itself, plus the equipment table and status — and the honest empty states. */
function stage(
  c: SensorCharacter,
  rid: number | null,
  gender: 0 | 1,
  genderGuessed: boolean,
  items: [number, number][],
  slots: { slot: number; id: number | null; name: string | null }[],
  display: Map<number, number>,
  resolveError: string | null,
): string {
  const rows = slots
    .sort((a, b) => a.slot - b.slot)
    .map((s) => {
      const id = s.id as number;
      const did = display.get(id);
      const note = !isRenderableSlot(s.slot) ? '<span class="sub">not rendered</span>' : did ? `<code>${did}</code>` : '<span class="sub">unresolved</span>';
      return `<tr><td class="l">${esc(slotName(String(s.slot)))}</td><td class="l">${esc(
        s.name ?? `#${id}`,
      )}</td><td><code>${id}</code></td><td>${note}</td></tr>`;
    })
    .join('');

  const table = slots.length
    ? `<table class="model-items"><thead><tr><th class="l">slot</th><th class="l">item</th><th>item id</th><th>display id</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="sub">No gear captured for this character yet. Log in on this character and the addon writes its equipment on the next flush.</div>';

  if (rid === null) {
    return section(
      'model',
      emptyState(
        `This character's race (${esc(c.meta.race ?? 'unknown')}) is not one the model engine knows, so a body
         cannot be drawn. The equipment is still listed below.`,
        table,
      ),
    );
  }

  const data = JSON.stringify({ race: rid, gender, items }).replace(/</g, '\\u003c');
  const genderNote = genderGuessed
    ? '<div class="sub">gender was not captured for this character yet — showing male; re-log to record it, or toggle above</div>'
    : '';

  const viewer = `
<style>
  #ps-model { width: 100%; height: 560px; max-width: 520px; background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); overflow: hidden; }
  .model-wrap { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .model-side { flex: 1 1 280px; min-width: 260px; }
  .model-items { width: 100%; border-collapse: collapse; }
  .model-row { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  #ps-model-status { font-size: 13px; color: var(--ink-dim); white-space: pre-wrap; margin-top: 10px; }
  #ps-model-status.bad { color: var(--bad); }
</style>
<div class="model-wrap">
  <div><div id="ps-model"></div></div>
  <div class="model-side">
    <div class="model-row">
      <label>gender
        <select id="ps-gender">
          <option value="1"${gender === 1 ? ' selected' : ''}>male</option>
          <option value="0"${gender === 0 ? ' selected' : ''}>female</option>
        </select>
      </label>
      <button type="button" id="ps-rerender">re-render</button>
    </div>
    ${genderNote}
    ${table}
    <div id="ps-model-status">loading model engine…</div>
    ${resolveError ? `<div class="sub bad">display-id lookup had trouble: ${esc(resolveError)}</div>` : ''}
    <div class="sub" style="margin-top:10px">Model and assets come from wow.zamimg.com (Wowhead's Classic engine);
      item ids are your capture, display ids were resolved from Wowhead's Classic item data and cached locally.</div>
  </div>
</div>
<script>
  window.CONTENT_PATH = 'https://wow.zamimg.com/modelviewer/classic/';
  window.WOTLK_TO_RETAIL_DISPLAY_ID_API = undefined;
  (function () {
    var MODEL = ${data};
    var statusEl = document.getElementById('ps-model-status');
    function setStatus(msg, bad) { statusEl.className = bad ? 'bad' : ''; statusEl.textContent = msg; }
    var viewer = null;
    async function render() {
      try {
        if (!MODEL.items.length) { setStatus('No renderable gear resolved yet — nothing to dress the model with.'); return; }
        setStatus('building model…');
        if (viewer && viewer.destroy) { try { viewer.destroy(); } catch (e) {} }
        var mod = await import('https://cdn.jsdelivr.net/npm/wow-model-viewer@1.5.3/+esm');
        var character = {
          race: MODEL.race,
          gender: Number(document.getElementById('ps-gender').value),
          skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialStyle: 0,
          items: MODEL.items,
        };
        viewer = await mod.generateModels(1, '#ps-model', character, 'classic');
        setStatus('rendered — ' + MODEL.items.length + ' equipped item(s) from your capture');
      } catch (err) {
        setStatus('render failed: ' + (err && err.message ? err.message : err) +
          '\\nThe resolved data is still correct; the failure is in the Wowhead engine.', true);
        console.error(err);
      }
    }
    document.getElementById('ps-rerender').addEventListener('click', render);
    function boot(tries) {
      if (window.jQuery && window.ZamModelViewer) return render();
      if (tries <= 0) return setStatus('model engine did not load (is wow.zamimg.com reachable?)', true);
      setTimeout(function () { boot(tries - 1); }, 300);
    }
    function load(src, cb) { var s = document.createElement('script'); s.src = src; s.onload = cb; s.onerror = function () { setStatus('could not load ' + src, true); }; document.head.appendChild(s); }
    load('https://code.jquery.com/jquery-3.5.1.min.js', function () {
      load('https://wow.zamimg.com/modelviewer/classic/viewer/viewer.min.js', function () { boot(40); });
    });
  })();
</script>`;

  return section('model', viewer);
}

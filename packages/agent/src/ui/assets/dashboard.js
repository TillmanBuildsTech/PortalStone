/**
 * Dashboard builder. Two enhancements over the server-rendered page:
 *
 *   1. gridstack turns the cards into a drag/resize grid and posts the layout back;
 *   2. the card form fetches a server-rendered preview as the fields change.
 *
 * No build step: this file is served as-is. Everything degrades to the static page when JS is off.
 */
(() => {
  const status = document.getElementById('dash-status');
  const gridEl = document.getElementById('dash-grid');

  if (gridEl && window.GridStack) {
    const dashboardId = Number(gridEl.dataset.dashboard || 0);
    const grid = window.GridStack.init(
      {
        column: 12,
        cellHeight: 92,
        margin: 8,
        float: false,
        minRow: 1,
        handle: '.grab',
        resizable: { handles: 'se' },
      },
      gridEl,
    );

    let timer = null;
    const setStatus = (text, bad = false) => {
      if (!status) return;
      status.textContent = text;
      status.classList.toggle('down', bad);
    };

    const save = async () => {
      const nodes = (grid.engine && grid.engine.nodes) || [];
      const items = nodes
        .map((n) => ({
          id: Number(n.el.getAttribute('gs-id')),
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
        }))
        .filter((item) => Number.isInteger(item.id) && item.id > 0);
      if (items.length === 0) return;

      setStatus('saving layout…');
      try {
        const res = await fetch('/dashboard/layout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dashboard: dashboardId, items }),
        });
        setStatus(res.ok ? 'layout saved' : 'layout not saved', !res.ok);
      } catch {
        setStatus('layout not saved — the server is not answering', true);
      }
    };

    grid.on('change', () => {
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    });

    /**
     * A resize changes the space the chart has, so ask the server for the card at its new cell
     * size. The layout (pie key beside or below, label density, table rows) is chosen from w/h.
     *
     * Only the body is swapped. GridStack binds its drag listeners to the handle element it found
     * when it set the card up, so replacing the whole card — handle included — leaves the new
     * handle with no listeners and the card can never be dragged again. Keeping the header node
     * alive keeps the card movable.
     */
    const applyCard = (content, html) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.querySelector('.dash-card');
      const card = content.querySelector('.dash-card');
      const freshBody = fresh && fresh.querySelector('.dash-body');
      const body = card && card.querySelector('.dash-body');
      if (!fresh || !card || !freshBody || !body) {
        // Unexpected markup (a card type from an older page, say): fall back rather than show
        // nothing, and accept that this card may need a reload to drag again.
        content.innerHTML = html;
        return;
      }
      body.innerHTML = freshBody.innerHTML;
      card.className = fresh.className;
      const view = fresh.getAttribute('data-view');
      const pill = card.querySelector('.view-pill');
      if (pill && view) pill.textContent = view;
    };

    const rerender = async (el) => {
      const content = el && el.querySelector('.grid-stack-item-content');
      if (!content) return;
      const id = Number(el.getAttribute('gs-id'));
      const node = el.gridstackNode || {};
      const w = Number(node.w || el.getAttribute('gs-w') || 0);
      const h = Number(node.h || el.getAttribute('gs-h') || 0);
      if (!Number.isInteger(id) || id <= 0 || !w || !h) return;
      try {
        const res = await fetch(`/dashboard/card/body?id=${id}&w=${w}&h=${h}`);
        if (!res.ok) return;
        applyCard(content, await res.text());
      } catch {
        /* keep the old rendering rather than blanking the card */
      }
    };
    grid.on('resizestop', (_event, el) => {
      if (el) setTimeout(() => rerender(el), 60);
    });
  }

  const form = document.getElementById('card-form');
  const preview = document.getElementById('card-preview');
  if (form && preview) {
    const field = (name) => form.querySelector('[name="' + name + '"]');
    const defaults = (() => {
      try {
        return JSON.parse(form.dataset.defaults || '{}');
      } catch {
        return {};
      }
    })();
    const placeholder = () =>
      '<div class="empty" id="preview-placeholder">Pick a data source to see the card here.</div>';
    let timer = null;
    let seq = 0;

    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const metric = field('metric')?.value || '';
        if (!metric) {
          preview.innerHTML = placeholder();
          return;
        }
        const view = field('view')?.value || 'bar';
        const mode = form.dataset.mode || 'edit';
        // A new card takes the default size for its view; an edited card keeps its geometry.
        const size = mode === 'add' && defaults[view] ? defaults[view] : {
          w: Number(field('w')?.value || 6),
          h: Number(field('h')?.value || 3),
        };
        const params = new URLSearchParams({
          metric,
          view,
          range: field('range')?.value || '0',
          title: field('title')?.value || '',
          w: String(size.w),
          h: String(size.h),
        });
        const mine = ++seq;
        try {
          const res = await fetch('/dashboard/card/preview?' + params.toString());
          if (mine !== seq) return;
          preview.innerHTML = res.ok
            ? await res.text()
            : '<div class="empty">Preview failed.</div>';
        } catch {
          if (mine === seq) preview.innerHTML = '<div class="empty">Preview failed.</div>';
        }
      }, 180);
    };

    for (const name of ['metric', 'view', 'range', 'title']) {
      const el = field(name);
      if (!el) continue;
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    }
  }
})();

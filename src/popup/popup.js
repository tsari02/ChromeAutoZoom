// Toolbar popup (engineering doc v3 §7). No inline scripts/handlers.
// Reads state through GET_POPUP_STATE, sends one message per control, and
// re-renders on chrome.storage.onChanged so it stays live.
//
// States: FirstRun (onboardingCompleted=false → rows + "Accept and start"),
// Normal, Paused (header toggle off → label "Paused").
import { MSG } from '../lib/constants.js';
import { nearestStepIndex, factorAtStep, formatPercent, formatDelta, ZOOM_LADDER } from '../lib/zoom-ladder.js';
import { prettyHost } from '../lib/url-rules.js';

const QUICK_PRESETS = [1.0, 1.1, 1.25, 1.5];

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'),
  footer: $('footer'),
  error: $('error'),
  enabledSwitch: $('enabled-switch'),
  enabled: $('enabled'),
  enabledLabel: $('enabled-label'),
  firstRun: $('first-run'),
  firstRunRows: $('first-run-rows'),
  accept: $('accept'),
  screenNameLine: $('screen-name-line'),
  screenName: $('screen-name'),
  screenRename: $('screen-rename'),
  screenNameInput: $('screen-name-input'),
  screenSub: $('screen-sub'),
  screenPill: $('screen-pill'),
  screenZoom: $('screen-zoom'),
  screenDown: $('screen-down'),
  screenUp: $('screen-up'),
  screenQuick: $('screen-quick'),
  siteHost: $('site-host'),
  siteSub: $('site-sub'),
  sitePill: $('site-pill'),
  siteExclude: $('site-exclude'),
  siteExcludeRow: $('site-exclude-row'),
  screensList: $('screens-list'),
  screensCount: $('screens-count'),
  clearExceptions: $('clear-exceptions'),
  restore: $('restore'),
  screenRowTemplate: $('screen-row-template'),
  firstRunRowTemplate: $('first-run-row-template'),
};

let ctx = { tabId: null, windowId: null };
let view = null;

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error ?? 'No response from AutoZoom');
  return res.result;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

const sizeText = (s) => (s?.width && s?.height ? `${s.width}×${s.height}` : '');

function fillSelect(select, factor) {
  if (select.options.length !== ZOOM_LADDER.length) {
    select.replaceChildren(
      ...ZOOM_LADDER.map((f) => {
        const opt = document.createElement('option');
        opt.value = String(f);
        opt.textContent = formatPercent(f);
        return opt;
      }),
    );
  }
  select.value = String(factorAtStep(nearestStepIndex(factor)));
}

// --- Inline rename (shared by the current-screen card and the saved-screens rows)

/** True while the `.name-input` inside `line` is open; renders must not clobber it. */
const isEditing = (line) => line?.querySelector('.name-input')?.dataset.editing === '1';

function startRename(line, key, currentName) {
  const nameEl = line.querySelector('.name');
  const btn = line.querySelector('.icon-btn');
  const input = line.querySelector('.name-input');
  if (!input || input.dataset.editing === '1') return;
  input.dataset.editing = '1';
  input.value = currentName ?? '';
  nameEl.hidden = true;
  btn.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();

  // Enter → commit, Esc → cancel, blur → commit. Hiding the input fires a blur,
  // so the guard above (`editing`) makes the second call a no-op: one message.
  const finish = async (commit) => {
    if (input.dataset.editing !== '1') return;
    input.dataset.editing = '0';
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    const value = input.value;
    input.hidden = true;
    nameEl.hidden = false;
    btn.hidden = false;
    if (commit && value.trim() !== String(currentName ?? '')) {
      await act({ type: MSG.RENAME_SCREEN, key, name: value });
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}

// --- Rendering --------------------------------------------------------------

function renderFirstRun(v) {
  const rows = v.firstRun?.rows ?? [];
  els.firstRunRows.replaceChildren(
    ...rows.map((r) => {
      const node = els.firstRunRowTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.name').textContent = r.name;
      // Line 2: logical size only ("1728×1117"). The recommendation is what the
      // selector starts at; it is not labelled (1.1.0 polish, D26).
      node.querySelector('.sub').textContent = sizeText(r);
      const select = node.querySelector('.zoom-select');
      fillSelect(select, r.zoomFactor ?? r.recommended);
      select.dataset.key = r.key;
      return node;
    }),
  );
  els.accept.disabled = rows.length === 0;
}

function renderScreen(v) {
  const s = v.screen;
  if (!s) {
    els.screenName.textContent = 'Screen not detected';
    els.screenSub.textContent = 'Move or focus a window on a screen to detect it.';
    els.screenPill.textContent = '';
    els.screenRename.hidden = true;
    els.screenZoom.disabled = true;
    els.screenDown.disabled = true;
    els.screenUp.disabled = true;
    els.screenQuick.replaceChildren();
    return;
  }
  if (!isEditing(els.screenNameLine)) {
    els.screenName.textContent = s.name;
    els.screenName.title = s.name;
    els.screenRename.hidden = false;
  }
  // Line 2: logical size only ("2560×1440"). The recommendation is what the
  // selector starts at; it is not labelled (1.1.0 polish, D26).
  els.screenSub.textContent = sizeText(s) || 'Default zoom for every site on this screen';
  els.screenPill.textContent = s.isInternal ? 'Built-in' : s.connected ? 'External' : 'Not connected';
  els.screenPill.className = `pill ${s.isInternal ? 'blue' : ''}`;
  fillSelect(els.screenZoom, s.zoomFactor);
  const idx = nearestStepIndex(s.zoomFactor);
  els.screenZoom.disabled = false;
  els.screenDown.disabled = idx <= 0;
  els.screenUp.disabled = idx >= ZOOM_LADDER.length - 1;

  els.screenQuick.replaceChildren(
    ...QUICK_PRESETS.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${nearestStepIndex(f) === idx ? ' active' : ''}`;
      b.textContent = formatPercent(f);
      b.dataset.factor = String(f);
      return b;
    }),
  );
}

function renderSite(v) {
  const site = v.site;
  if (!site?.manageable) {
    els.siteHost.textContent = 'Not available on this page';
    els.siteSub.textContent = 'Chrome pages and the Web Store can\'t be zoomed by extensions.';
    els.sitePill.textContent = '';
    els.siteExcludeRow.hidden = true;
    return;
  }
  els.siteExcludeRow.hidden = false;
  els.siteHost.textContent = prettyHost(site.host);
  els.siteHost.title = site.host;
  els.siteExclude.checked = site.excluded;
  if (site.excluded) {
    els.sitePill.textContent = 'Excluded';
    els.sitePill.className = 'pill amber';
    els.siteSub.textContent = 'Using Chrome\'s own zoom for this site.';
    return;
  }
  const expected = Number.isFinite(site.expected) ? formatPercent(site.expected) : null;
  if (site.delta) {
    els.sitePill.textContent = formatDelta(site.delta);
    els.sitePill.className = 'pill blue';
    const origin = site.inherited && site.sourceName ? `inherited from ${site.sourceName}` : 'on this screen';
    const sep = site.inherited && site.sourceName ? ' · ' : ' ';
    els.siteSub.textContent = `${formatDelta(site.delta)}${sep}${origin}${expected ? ` → ${expected}` : ''}`;
  } else {
    els.sitePill.textContent = '';
    els.siteSub.textContent = expected ? `Uses screen default (${expected})` : 'Uses screen default';
  }
}

function renderScreens(v) {
  const list = v.screens ?? [];
  els.screensCount.textContent = String(list.length);
  if ([...els.screensList.querySelectorAll('.name-line')].some(isEditing)) return; // keep the open editor
  els.screensList.replaceChildren(
    ...list.map((s) => {
      const node = els.screenRowTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.key = s.key;
      node.dataset.name = s.name ?? '';
      node.querySelector('.name').textContent = s.name;
      node.querySelector('.name').title = s.name ?? '';
      const meta = [];
      const size = sizeText(s);
      if (size) meta.push(size);
      meta.push(s.isInternal ? 'Built-in' : 'External');
      if (s.current) meta.push('current');
      else if (!s.connected) meta.push('not connected');
      node.querySelector('.meta').textContent = meta.join(' · ');
      const select = node.querySelector('.zoom-select');
      fillSelect(select, s.zoomFactor);
      select.dataset.key = s.key;
      return node;
    }),
  );
}

function render(v) {
  view = v;
  const firstRun = !v.onboardingCompleted;
  els.firstRun.hidden = !firstRun;
  els.main.hidden = firstRun;
  els.footer.hidden = firstRun;
  els.enabledSwitch.hidden = firstRun;
  if (firstRun) {
    renderFirstRun(v);
    return;
  }
  els.enabled.checked = v.enabled;
  els.enabledLabel.textContent = v.enabled ? 'On' : 'Paused';
  els.main.classList.toggle('paused', !v.enabled);
  renderScreen(v);
  renderSite(v);
  renderScreens(v);
  els.clearExceptions.disabled = !v.exceptionCount;
  els.clearExceptions.textContent = v.exceptionCount
    ? `Clear all site exceptions (${v.exceptionCount})`
    : 'Clear all site exceptions';
  els.main.setAttribute('aria-busy', 'false');
}

async function refresh() {
  try {
    const v = await send({ type: MSG.GET_POPUP_STATE, tabId: ctx.tabId, windowId: ctx.windowId });
    render(v);
    showError('');
  } catch (err) {
    showError(`AutoZoom isn't responding: ${err.message}`);
  }
}

async function act(message) {
  try {
    showError('');
    await send(message);
    await refresh();
  } catch (err) {
    showError(err.message);
  }
}

// --- Wiring ---------------------------------------------------------------

els.enabled.addEventListener('change', () => act({ type: MSG.SET_ENABLED, enabled: els.enabled.checked }));

els.accept.addEventListener('click', async () => {
  const screens = {};
  for (const select of els.firstRunRows.querySelectorAll('select[data-key]')) screens[select.dataset.key] = Number(select.value);
  els.accept.disabled = true;
  await act({ type: MSG.CONFIRM_SETUP, screens });
  els.accept.disabled = false;
});

const setScreenZoom = (factor) => {
  if (!view?.screen) return;
  return act({ type: MSG.SET_SCREEN_ZOOM, key: view.screen.key, factor });
};
els.screenZoom.addEventListener('change', () => setScreenZoom(Number(els.screenZoom.value)));
els.screenDown.addEventListener('click', () => {
  if (view?.screen) setScreenZoom(factorAtStep(nearestStepIndex(view.screen.zoomFactor) - 1));
});
els.screenUp.addEventListener('click', () => {
  if (view?.screen) setScreenZoom(factorAtStep(nearestStepIndex(view.screen.zoomFactor) + 1));
});
els.screenQuick.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setScreenZoom(Number(chip.dataset.factor));
});
els.screenRename.addEventListener('click', () => {
  if (view?.screen) startRename(els.screenNameLine, view.screen.key, view.screen.name);
});

els.siteExclude.addEventListener('change', () => {
  if (view?.site?.host) act({ type: MSG.SET_EXCLUDED, host: view.site.host, excluded: els.siteExclude.checked });
});

els.screensList.addEventListener('change', (e) => {
  const select = e.target.closest('select[data-key]');
  if (select) act({ type: MSG.SET_SCREEN_ZOOM, key: select.dataset.key, factor: Number(select.value) });
});
els.screensList.addEventListener('click', (e) => {
  const btn = e.target.closest('.icon-btn.rename');
  if (!btn) return;
  const row = btn.closest('.screen-row');
  startRename(row.querySelector('.name-line'), row.dataset.key, row.dataset.name);
});

els.clearExceptions.addEventListener('click', () => act({ type: MSG.CLEAR_SITE_EXCEPTIONS }));

// One click: pause + hand every tab back to Chrome's own zoom (RELEASE_ALL →
// engine.restoreChromeZoom). No confirmation dialog (1.1.0 polish, D24): the
// header flipping to "Paused" is the feedback, and the switch turns it back on.
els.restore.addEventListener('click', async () => {
  els.restore.disabled = true;
  try {
    await act({ type: MSG.RELEASE_ALL });
  } finally {
    els.restore.disabled = false;
  }
});

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') refresh();
});

// --- Boot -----------------------------------------------------------------

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ctx = { tabId: tab?.id ?? null, windowId: tab?.windowId ?? null };
  } catch {
    ctx = { tabId: null, windowId: null };
  }
  await refresh();
})();

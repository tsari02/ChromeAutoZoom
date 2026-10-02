// Toolbar popup (engineering doc §8). No inline scripts/handlers.
// Reads state through GET_POPUP_STATE, sends one message per control, and
// re-renders on chrome.storage.onChanged so it stays live.
import { MSG } from '../lib/constants.js';
import { nearestStepIndex, factorAtStep, formatPercent, formatDelta, ZOOM_LADDER } from '../lib/zoom-ladder.js';
import { prettyHost } from '../lib/url-rules.js';

const QUICK_PRESETS = [1.0, 1.1, 1.25, 1.5];

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'),
  error: $('error'),
  enabled: $('enabled'),
  enabledLabel: $('enabled-label'),
  onboardingBanner: $('onboarding-banner'),
  openOnboarding: $('open-onboarding'),
  screenName: $('screen-name'),
  screenSub: $('screen-sub'),
  screenPill: $('screen-pill'),
  screenZoom: $('screen-zoom'),
  screenDown: $('screen-down'),
  screenUp: $('screen-up'),
  screenQuick: $('screen-quick'),
  siteHost: $('site-host'),
  siteSub: $('site-sub'),
  sitePill: $('site-pill'),
  siteReset: $('site-reset'),
  siteExclude: $('site-exclude'),
  siteExcludeRow: $('site-exclude-row'),
  screensList: $('screens-list'),
  screensCount: $('screens-count'),
  clearExceptions: $('clear-exceptions'),
  restore: $('restore'),
  restoreDialog: $('restore-dialog'),
  screenRowTemplate: $('screen-row-template'),
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

function renderScreen(v) {
  const s = v.screen;
  if (!s) {
    els.screenName.textContent = 'Screen not detected';
    els.screenSub.textContent = 'Move or focus a window on a screen to detect it.';
    els.screenPill.textContent = '';
    els.screenZoom.disabled = true;
    els.screenDown.disabled = true;
    els.screenUp.disabled = true;
    els.screenQuick.replaceChildren();
    return;
  }
  els.screenName.textContent = s.name;
  els.screenSub.textContent = 'Default zoom for every site on this screen';
  els.screenPill.textContent = s.isInternal ? 'Built-in' : 'External';
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
    els.siteReset.hidden = true;
    els.siteExcludeRow.hidden = true;
    return;
  }
  els.siteExcludeRow.hidden = false;
  els.siteHost.textContent = prettyHost(site.host);
  els.siteExclude.checked = site.excluded;
  if (site.excluded) {
    els.sitePill.textContent = 'Excluded';
    els.sitePill.className = 'pill amber';
    els.siteSub.textContent = 'Using Chrome\'s own zoom for this site.';
    els.siteReset.hidden = true;
    return;
  }
  const expected = site.expected;
  if (site.delta) {
    els.sitePill.textContent = formatDelta(site.delta);
    els.sitePill.className = 'pill blue';
    els.siteSub.textContent = `${formatPercent(expected)} on this screen · ${formatDelta(site.delta)} from the screen default`;
    els.siteReset.hidden = false;
  } else {
    els.sitePill.textContent = '';
    els.siteSub.textContent = expected ? `${formatPercent(expected)} · screen default` : 'Screen default';
    els.siteReset.hidden = true;
  }
}

function renderScreens(v) {
  const list = v.screens ?? [];
  els.screensCount.textContent = String(list.length);
  els.screensList.replaceChildren(
    ...list.map((s) => {
      const node = els.screenRowTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.name').textContent = s.name;
      const meta = [s.isInternal ? 'Built-in' : 'External'];
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
  els.enabled.checked = v.enabled;
  els.enabledLabel.textContent = v.enabled ? 'On' : 'Paused';
  els.main.classList.toggle('paused', !v.enabled);
  els.onboardingBanner.hidden = v.onboardingCompleted;
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
els.openOnboarding.addEventListener('click', async () => {
  await act({ type: MSG.OPEN_ONBOARDING });
  window.close();
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

els.siteReset.addEventListener('click', () => {
  if (view?.site?.host) act({ type: MSG.CLEAR_SITE_DELTA, host: view.site.host });
});
els.siteExclude.addEventListener('change', () => {
  if (view?.site?.host) act({ type: MSG.SET_EXCLUDED, host: view.site.host, excluded: els.siteExclude.checked });
});

els.screensList.addEventListener('change', (e) => {
  const select = e.target.closest('select[data-key]');
  if (select) act({ type: MSG.SET_SCREEN_ZOOM, key: select.dataset.key, factor: Number(select.value) });
});

els.clearExceptions.addEventListener('click', () => act({ type: MSG.CLEAR_SITE_EXCEPTIONS }));

els.restore.addEventListener('click', () => {
  if (typeof els.restoreDialog.showModal === 'function') els.restoreDialog.showModal();
});
els.restoreDialog.addEventListener('close', () => {
  if (els.restoreDialog.returnValue === 'confirm') act({ type: MSG.RELEASE_ALL });
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

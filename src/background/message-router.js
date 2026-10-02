// runtime.onMessage handlers (engineering doc §7 / §8).
// Every handler runs in an async IIFE and the listener returns `true` to keep
// the response channel open.
import { MSG, SETUP_MODE, ZOOM_LADDER, INTERNAL_KEY } from '../lib/constants.js';
import * as storage from '../lib/storage.js';
import { getDisplays } from '../lib/display-cache.js';
import { matchSavedScreen, buildKey, isInternalDisplay } from '../lib/screen-keys.js';
import { hostOf } from '../lib/url-rules.js';
import { isManageable, safeCall } from '../lib/tab-zoom.js';
import { expectedZoom } from '../lib/zoom-ladder.js';
import * as engine from '../lib/zoom-engine.js';
import { openOnboarding } from '../lib/setup-window.js';

/** Pseudo-key for the "external monitors you plug in later" onboarding row. */
export const EXTERNAL_DEFAULT_ROW = '__external_default__';

async function connectedKeyMap() {
  const displays = await getDisplays();
  const state = await storage.getState();
  const map = new Map(); // key → display
  for (const d of displays) {
    const key = matchSavedScreen(d, state.screens, displays)?.key ?? buildKey(d, displays);
    map.set(key, d);
  }
  return { map, displays, state };
}

async function getSetupData({ mode, key }) {
  await engine.syncDisplays();
  const { map, displays, state } = await connectedKeyMap();
  const session = await storage.getSession();
  const rows = [];

  if (mode === SETUP_MODE.NEW_DISPLAY) {
    const keys = [...new Set([key, ...session.pendingSetupKeys].filter(Boolean))];
    for (const k of keys) {
      const s = state.screens[k];
      if (!s) continue;
      rows.push({
        key: k,
        name: s.name,
        isInternal: s.isInternal,
        zoomFactor: s.confirmed ? s.zoomFactor : state.defaults.external,
        connected: map.has(k),
      });
    }
  } else {
    for (const [k, d] of map) {
      const s = state.screens[k];
      rows.push({
        key: k,
        name: s?.name ?? d.name,
        isInternal: s?.isInternal ?? isInternalDisplay(d),
        zoomFactor: s?.confirmed ? s.zoomFactor : s?.isInternal ? state.defaults.internal : state.defaults.external,
        connected: true,
      });
    }
    rows.sort((a, b) => Number(b.isInternal) - Number(a.isInternal));
    const hasInternal = displays.some(isInternalDisplay);
    const hasExternal = displays.some((d) => !isInternalDisplay(d));
    if (!hasInternal) {
      rows.push({
        key: INTERNAL_KEY,
        name: state.screens[INTERNAL_KEY]?.name ?? 'Built-in display',
        isInternal: true,
        zoomFactor: state.screens[INTERNAL_KEY]?.zoomFactor ?? state.defaults.internal,
        connected: false,
      });
    }
    if (!hasExternal) {
      rows.push({
        key: EXTERNAL_DEFAULT_ROW,
        name: 'External monitors you plug in later',
        isInternal: false,
        zoomFactor: state.defaults.external,
        connected: false,
      });
    }
  }

  return {
    mode,
    rows,
    ladder: [...ZOOM_LADDER],
    defaults: state.defaults,
    onboardingCompleted: state.onboardingCompleted,
  };
}

async function confirmSetup(payload) {
  const chosen = { ...(payload?.screens ?? {}) };
  const defaults = { ...(payload?.defaults ?? {}) };
  if (EXTERNAL_DEFAULT_ROW in chosen) {
    defaults.external = chosen[EXTERNAL_DEFAULT_ROW];
    delete chosen[EXTERNAL_DEFAULT_ROW];
  }
  if (INTERNAL_KEY in chosen && !Number.isFinite(defaults.internal)) defaults.internal = chosen[INTERNAL_KEY];
  const keys = await engine.confirmSetup({ screens: chosen, defaults });
  return keys;
}

/** Normalize each confirmed screen in the background (never awaited by the UI). */
async function normalizeAfterConfirm(keys) {
  try {
    for (const key of keys) await engine.normalizeScreen(key);
    await engine.resyncAllWindows('confirm');
  } catch (err) {
    console.warn('[AutoZoom] post-confirm normalization failed:', err?.message ?? err);
  }
}

async function getPopupState({ tabId, windowId }) {
  const state = await storage.getState();
  const tab = Number.isInteger(tabId) ? await safeCall(() => chrome.tabs.get(tabId), 'tabs.get') : null;
  const wid = Number.isInteger(windowId) ? windowId : tab?.windowId;
  const screen = Number.isInteger(wid) ? await engine.screenForWindow(wid, state) : null;
  const { map } = await connectedKeyMap();

  let site = { manageable: false, host: null };
  if (tab && isManageable(tab)) {
    const host = hostOf(tab.url);
    const delta = state.siteStepDeltas[host] ?? 0;
    site = {
      manageable: true,
      host,
      delta,
      excluded: Boolean(state.excludedHosts[host]),
      expected: screen ? expectedZoom(screen.zoomFactor, delta) : null,
      currentZoom: (await safeCall(() => chrome.tabs.getZoom(tab.id), 'tabs.getZoom')) ?? null,
    };
  }

  const screens = Object.values(state.screens)
    .map((s) => ({ ...s, connected: map.has(s.key), current: s.key === screen?.key }))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(b.isInternal) - Number(a.isInternal) || String(a.name ?? '').localeCompare(String(b.name ?? '')));

  return {
    enabled: state.enabled,
    onboardingCompleted: state.onboardingCompleted,
    ladder: [...ZOOM_LADDER],
    screen: screen ? { ...screen, connected: map.has(screen.key) } : null,
    site,
    screens,
    exceptionCount: Object.keys(state.siteStepDeltas).length,
    excludedCount: Object.keys(state.excludedHosts).length,
  };
}

async function dispatch(message) {
  const { type } = message ?? {};
  switch (type) {
    case MSG.GET_SETUP_DATA:
      return getSetupData(message);
    case MSG.CONFIRM_SETUP: {
      const keys = await confirmSetup(message);
      // Respond immediately; normalize in the background (doc §7).
      normalizeAfterConfirm(keys);
      return { ok: true, keys };
    }
    case MSG.GET_POPUP_STATE:
      return getPopupState(message);
    case MSG.SET_ENABLED:
      return engine.setEnabled(Boolean(message.enabled));
    case MSG.SET_SCREEN_ZOOM:
      return engine.setScreenZoom(String(message.key), Number(message.factor));
    case MSG.SET_EXCLUDED:
      return engine.setExcluded(String(message.host), Boolean(message.excluded));
    case MSG.CLEAR_SITE_DELTA:
      return engine.clearSiteDelta(String(message.host));
    case MSG.CLEAR_SITE_EXCEPTIONS:
      return engine.clearSiteExceptions();
    case MSG.RELEASE_ALL:
      return engine.setEnabled(false);
    case MSG.OPEN_ONBOARDING:
      return { windowId: await openOnboarding() };
    default:
      throw new Error(`Unknown message type: ${String(type)}`);
  }
}

/** Top-level listener. Registered synchronously by service-worker.js. */
export function handleMessage(message, sender, sendResponse) {
  (async () => {
    try {
      const result = await dispatch(message);
      sendResponse({ ok: true, result });
    } catch (err) {
      console.warn('[AutoZoom] message failed:', message?.type, err?.message ?? err);
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    }
  })();
  return true; // keep the channel open for the async response
}

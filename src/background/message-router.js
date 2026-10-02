// runtime.onMessage handlers (engineering doc v3 §8).
// Every handler runs in an async IIFE and the listener returns `true` to keep
// the response channel open.
import { MSG, ZOOM_LADDER } from '../lib/constants.js';
import * as storage from '../lib/storage.js';
import { getDisplays } from '../lib/display-cache.js';
import { matchSavedScreen, buildKey } from '../lib/screen-keys.js';
import { hostOf } from '../lib/url-rules.js';
import { isManageable, safeCall } from '../lib/tab-zoom.js';
import { expectedZoom } from '../lib/zoom-ladder.js';
import { recommendedZoom } from '../lib/zoom-map.js';
import { resolveDelta } from '../lib/site-deltas.js';
import * as engine from '../lib/zoom-engine.js';

/** key → connected display, for the screens that are plugged in right now. */
async function connectedKeyMap(state) {
  const displays = await getDisplays();
  const map = new Map();
  for (const d of displays) {
    const key = matchSavedScreen(d, state.screens, displays)?.key ?? buildKey(d, displays);
    map.set(key, d);
  }
  return map;
}

/**
 * Popup view of a screen profile. `recommended` is what the map says for this
 * screen (learned overrides included, doc §7) — computed from the live display
 * when connected (exact current size) and from the stored size otherwise.
 */
function screenView(screen, map, state) {
  const display = map.get(screen.key) ?? null;
  return {
    ...screen,
    connected: Boolean(display),
    recommended: recommendedZoom(display ?? screen, state.learnedDefaults),
  };
}

/** First-run rows: one per CONNECTED display, pre-filled from the map. */
function firstRunRows(map, state) {
  const rows = [];
  for (const [key, display] of map) {
    const s = state.screens[key];
    if (!s) continue;
    rows.push({
      key,
      name: s.name,
      isInternal: s.isInternal,
      width: s.width,
      height: s.height,
      recommended: recommendedZoom(display, state.learnedDefaults),
      zoomFactor: s.zoomFactor,
    });
  }
  rows.sort((a, b) => Number(b.isInternal) - Number(a.isInternal));
  return rows;
}

async function getPopupState({ tabId, windowId }) {
  let state = await storage.getState();
  if (!state.onboardingCompleted) {
    // First run: make sure every connected display has a profile to list.
    await engine.syncDisplays();
    state = await storage.getState();
  }
  const tab = Number.isInteger(tabId) ? await safeCall(() => chrome.tabs.get(tabId), 'tabs.get') : null;
  const wid = Number.isInteger(windowId) ? windowId : tab?.windowId;
  const screen = Number.isInteger(wid) ? await engine.screenForWindow(wid, state) : null;
  const map = await connectedKeyMap(state);

  let site = { manageable: false, host: null };
  if (tab && isManageable(tab)) {
    const host = hostOf(tab.url);
    const r = screen ? resolveDelta(host, screen.key, state) : { delta: 0, source: null, inherited: false };
    site = {
      manageable: true,
      host,
      delta: r.delta,
      inherited: r.inherited,
      source: r.source,
      sourceName: r.source ? (state.screens[r.source]?.name ?? null) : null,
      excluded: Boolean(state.excludedHosts[host]),
      expected: screen ? expectedZoom(screen.zoomFactor, r.delta) : null,
      currentZoom: (await safeCall(() => chrome.tabs.getZoom(tab.id), 'tabs.getZoom')) ?? null,
    };
  }

  const screens = Object.values(state.screens)
    .map((s) => ({ ...screenView(s, map, state), current: s.key === screen?.key }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        Number(b.isInternal) - Number(a.isInternal) ||
        String(a.name ?? '').localeCompare(String(b.name ?? '')),
    );

  const out = {
    enabled: state.enabled,
    onboardingCompleted: state.onboardingCompleted,
    ladder: [...ZOOM_LADDER],
    screen: screen ? screenView(screen, map, state) : null,
    site,
    screens,
    exceptionCount: Object.keys(state.siteStepDeltas).length, // hosts with rows
    excludedCount: Object.keys(state.excludedHosts).length,
  };
  if (!state.onboardingCompleted) out.firstRun = { rows: firstRunRows(map, state) };
  return out;
}

/** Normalize each accepted screen in the background (never awaited by the UI). */
async function normalizeAfterConfirm(keys) {
  try {
    for (const key of keys) await engine.normalizeScreen(key);
    await engine.resyncAllWindows('confirm');
  } catch (err) {
    console.warn('[AutoZoom] post-confirm normalization failed:', err?.message ?? err);
  }
}

async function dispatch(message) {
  const { type } = message ?? {};
  switch (type) {
    case MSG.GET_POPUP_STATE:
      return getPopupState(message);
    case MSG.CONFIRM_SETUP: {
      const keys = await engine.confirmSetup({ screens: message.screens });
      // Respond immediately; normalize in the background (doc §7).
      normalizeAfterConfirm(keys);
      return { ok: true, keys };
    }
    case MSG.SET_ENABLED:
      return engine.setEnabled(Boolean(message.enabled));
    case MSG.SET_SCREEN_ZOOM:
      return engine.setScreenZoom(String(message.key), Number(message.factor));
    case MSG.RENAME_SCREEN:
      return engine.renameScreen(String(message.key), message.name);
    case MSG.SET_EXCLUDED:
      return engine.setExcluded(String(message.host), Boolean(message.excluded));
    case MSG.CLEAR_SITE_EXCEPTIONS:
      return engine.clearSiteExceptions();
    case MSG.RELEASE_ALL:
      // "Restore Chrome's zoom": pause + release every managed tab (pitfall A2).
      return engine.restoreChromeZoom();
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

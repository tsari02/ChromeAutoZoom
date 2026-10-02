// AutoZoom service worker — ONLY top-level listener registration + dispatch.
// All listeners are registered synchronously so Chrome can replay events to a
// restarted worker. No correctness depends on in-memory state (doc §3).
import { TIMINGS } from '../lib/constants.js';
import * as storage from '../lib/storage.js';
import { invalidate as invalidateDisplays } from '../lib/display-cache.js';
import * as engine from '../lib/zoom-engine.js';
import * as scheduler from './sync-scheduler.js';
import { handleMessage } from './message-router.js';

function logError(label, err) {
  console.warn(`[AutoZoom] ${label}:`, err?.message ?? err);
}

// --- First-run popup (doc v3 §6, pitfall B1) -------------------------------
//
// chrome.action.openPopup() (Chrome 127+) can reject: Chrome's own "extension
// added" bubble is up, there is no focused normal window, a popup is already
// open. The first failure is logged and otherwise ignored — the first-run
// state simply shows on the next icon click. ONE retry is armed for the next
// windows.onFocusChanged while onboarding is still unaccepted, and never more
// than one per worker lifetime. Both flags are caches: a service-worker
// restart just means no retry, which loses nothing.
let popupRetryArmed = false;
let popupRetryUsed = false;

async function openFirstRunPopup(trigger) {
  try {
    await chrome.action.openPopup();
  } catch (err) {
    console.warn(`[AutoZoom] action.openPopup failed after ${trigger}:`, err?.message ?? err);
    if (!popupRetryUsed) popupRetryArmed = true;
  }
}

async function retryFirstRunPopupOnFocus() {
  if (!popupRetryArmed || popupRetryUsed) return;
  // Consume synchronously so a burst of focus events cannot retry twice.
  popupRetryArmed = false;
  popupRetryUsed = true;
  const { onboardingCompleted } = await storage.getState();
  if (onboardingCompleted) return;
  try {
    await chrome.action.openPopup();
  } catch (err) {
    console.warn('[AutoZoom] action.openPopup retry failed:', err?.message ?? err);
  }
}

// --- Install / startup -----------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === 'install') {
      const state = await storage.initState();
      await engine.syncDisplays();
      // Nothing is zoomed until the user accepts in the popup (doc §6 / D3).
      if (!state.onboardingCompleted) await openFirstRunPopup('install');
      return;
    }
    if (details.reason === 'update' || details.reason === 'chrome_update') {
      await storage.migrate();
      await engine.syncAll('update');
      // A v2 user who never finished setup gets the first-run popup now.
      const { onboardingCompleted } = await storage.getState();
      if (!onboardingCompleted) await openFirstRunPopup('update');
    }
  } catch (err) {
    logError('onInstalled', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await engine.syncAll('startup');
  } catch (err) {
    logError('onStartup', err);
  }
});

// --- Displays --------------------------------------------------------------

// Debounce timers are caches: if the SW dies mid-debounce the next
// focus/activate event restores correctness.
let displayChangeTimer = null;
let displayResyncTimer = null;
// Screens created by the last display-change pass. The delayed pass normalizes
// them again because macOS moves windows onto a new monitor only after the
// first pass ran. Cache semantics: losing it means background tabs on that
// screen sync lazily on activation (FR-8) instead of immediately.
const pendingNewScreens = new Set();

chrome.system.display.onDisplayChanged.addListener(() => {
  invalidateDisplays();
  clearTimeout(displayChangeTimer);
  displayChangeTimer = setTimeout(async () => {
    try {
      invalidateDisplays();
      for (const key of await engine.syncAll('display')) pendingNewScreens.add(key);
      clearTimeout(displayResyncTimer);
      displayResyncTimer = setTimeout(async () => {
        const keys = [...pendingNewScreens];
        pendingNewScreens.clear();
        try {
          invalidateDisplays();
          await engine.resyncAllWindows('display-delayed');
          for (const key of keys) await engine.normalizeNewScreen(key);
        } catch (err) {
          logError('delayed resync', err);
        }
      }, TIMINGS.displayChangeResyncDelayMs);
    } catch (err) {
      logError('onDisplayChanged', err);
    }
  }, TIMINGS.displayChangeDebounceMs);
});

// --- Windows ---------------------------------------------------------------

chrome.windows.onBoundsChanged.addListener((win) => {
  scheduler.request(win.id, 'bounds');
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  scheduler.request(windowId, 'focus');
  try {
    await retryFirstRunPopupOnFocus();
  } catch (err) {
    logError('openPopup retry', err);
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  scheduler.forget(windowId);
  try {
    await storage.deleteWindowScreen(windowId);
  } catch (err) {
    logError('windows.onRemoved', err);
  }
});

// --- Tabs ------------------------------------------------------------------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await engine.syncTab(tabId);
  } catch (err) {
    logError('tabs.onActivated', err);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // `url` = committed navigation (per-tab zoom settings were just reset);
  // `status: complete` covers reloads and un-discarded tabs.
  if (!changeInfo.url && changeInfo.status !== 'complete' && changeInfo.discarded !== false) return;
  try {
    await engine.syncTab(tabId);
  } catch (err) {
    logError('tabs.onUpdated', err);
  }
});

chrome.tabs.onRemoved.addListener(() => {
  // Badge state is tab-scoped and dies with the tab; nothing to clean up.
});

chrome.tabs.onZoomChange.addListener(async (info) => {
  try {
    await engine.handleZoomChange(info);
  } catch (err) {
    logError('tabs.onZoomChange', err);
  }
});

// --- Messages (popup) ------------------------------------------------------

chrome.runtime.onMessage.addListener(handleMessage);

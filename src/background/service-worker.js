// AutoZoom service worker — ONLY top-level listener registration + dispatch.
// All listeners are registered synchronously so Chrome can replay events to a
// restarted worker. No correctness depends on in-memory state (doc §3).
import { TIMINGS } from '../lib/constants.js';
import * as storage from '../lib/storage.js';
import { invalidate as invalidateDisplays } from '../lib/display-cache.js';
import * as engine from '../lib/zoom-engine.js';
import { openOnboarding, handleWindowRemoved } from '../lib/setup-window.js';
import * as scheduler from './sync-scheduler.js';
import { handleMessage } from './message-router.js';

function logError(label, err) {
  console.warn(`[AutoZoom] ${label}:`, err?.message ?? err);
}

// --- Install / startup -----------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === 'install') {
      const state = await storage.initState();
      await engine.syncDisplays();
      // Do not zoom anything until the user confirms (doc §6).
      if (!state.onboardingCompleted) await openOnboarding();
      return;
    }
    if (details.reason === 'update' || details.reason === 'chrome_update') {
      await storage.migrate();
      await engine.syncDisplays();
      await engine.resyncAllWindows('update');
    }
  } catch (err) {
    logError('onInstalled', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await engine.syncDisplays();
    await engine.resyncAllWindows('startup');
  } catch (err) {
    logError('onStartup', err);
  }
});

// --- Displays --------------------------------------------------------------

// Debounce timer is a cache: if the SW dies mid-debounce the next
// focus/activate event restores correctness.
let displayChangeTimer = null;
let displayResyncTimer = null;

chrome.system.display.onDisplayChanged.addListener(() => {
  invalidateDisplays();
  clearTimeout(displayChangeTimer);
  displayChangeTimer = setTimeout(async () => {
    try {
      invalidateDisplays();
      await engine.syncDisplays();
      await engine.resyncAllWindows('display');
      // macOS relocates windows after the event; re-sync once more later.
      clearTimeout(displayResyncTimer);
      displayResyncTimer = setTimeout(async () => {
        try {
          invalidateDisplays();
          await engine.resyncAllWindows('display-delayed');
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

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  scheduler.request(windowId, 'focus');
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  scheduler.forget(windowId);
  try {
    await storage.deleteWindowScreen(windowId);
    await handleWindowRemoved(windowId);
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

// --- Messages (popup / setup) ---------------------------------------------

chrome.runtime.onMessage.addListener(handleMessage);

// Setup window launcher (engineering doc §7): one window at a time, deduped
// through storage.session.setupWindowId; extra requests queue in pendingSetupKeys.
//
// Opening is SINGLE-FLIGHT: the read-check-create-write sequence runs inside
// an in-process lock, so N concurrent callers (resyncAllWindows → syncWindow
// for every window on an unconfirmed display) produce exactly one window.
// The lock is a cache — after a service-worker restart the persisted
// setupWindowId still dedupes.
import { SETUP_MODE, SETUP_WINDOW } from './constants.js';
import { centeredRect, resolveDisplay } from './geometry.js';
import { getDisplays, getDisplayById } from './display-cache.js';
import { isInternalDisplay } from './screen-keys.js';
import { safeCall } from './tab-zoom.js';
import {
  getSession,
  getState,
  setSetupWindowId,
  addPendingSetupKey,
  clearPendingSetupKeys,
  upsertScreen,
} from './storage.js';

const SETUP_PATH = 'src/setup/setup.html';
const FALLBACK_BOUNDS = Object.freeze({ left: 0, top: 0, width: 1440, height: 900 });

let openLock = Promise.resolve();
function withOpenLock(fn) {
  const previous = openLock;
  const run = (async () => {
    try {
      await previous;
    } catch {
      // a failed predecessor must not block the lock
    }
    return fn();
  })();
  openLock = (async () => {
    try {
      await run;
    } catch {
      // caller receives the rejection via `run`
    }
  })();
  return run;
}

/**
 * The display the user is most likely looking at: the one under the
 * last-focused NORMAL window (chrome.windows.getLastFocused), else primary.
 */
async function userFacingDisplay(displays) {
  const primary = displays.find((d) => d.isPrimary) ?? displays[0] ?? null;
  const win = await safeCall(
    () => chrome.windows.getLastFocused({ windowTypes: ['normal'] }),
    'windows.getLastFocused',
  );
  if (win && win.type === 'normal' && win.state !== 'minimized') {
    const r = resolveDisplay(win, displays);
    if (r?.display) return r.display;
  }
  return primary;
}

const boundsOf = (display) => display?.workArea ?? display?.bounds ?? FALLBACK_BOUNDS;

function setupUrl(mode, key) {
  const params = new URLSearchParams({ mode });
  if (key) params.set('key', key);
  return `${chrome.runtime.getURL(SETUP_PATH)}?${params.toString()}`;
}

function heightForRows(rows) {
  return Math.min(SETUP_WINDOW.maxHeight, SETUP_WINDOW.baseHeight + SETUP_WINDOW.rowHeight * rows);
}

/** Returns the live setup window id, or null (clearing a stale id). */
async function liveSetupWindowId() {
  const { setupWindowId } = await getSession();
  if (setupWindowId == null) return null;
  const win = await safeCall(() => chrome.windows.get(setupWindowId), 'windows.get(setup)');
  if (win) return setupWindowId;
  await setSetupWindowId(null);
  return null;
}

async function createSetupWindow(mode, key, bounds, rows) {
  const rect = centeredRect(bounds, SETUP_WINDOW.width, heightForRows(rows));
  const win = await safeCall(
    () =>
      chrome.windows.create({
        url: setupUrl(mode, key),
        type: 'popup',
        focused: true,
        ...rect,
      }),
    'windows.create(setup)',
  );
  if (!win) return null;
  await setSetupWindowId(win.id);
  return win.id;
}

/**
 * Open the onboarding window (first install). Lists every connected display
 * plus the absent class. Opens on the display of the last-focused normal
 * window (falls back to primary) so the user actually sees it. Idempotent:
 * if a setup window is already open it is focused instead.
 */
export function openOnboarding() {
  return withOpenLock(async () => {
    const existing = await liveSetupWindowId();
    if (existing != null) {
      await safeCall(() => chrome.windows.update(existing, { focused: true }), 'windows.update(setup)');
      return existing;
    }
    const displays = await getDisplays();
    const target = await userFacingDisplay(displays);
    const hasInternal = displays.some(isInternalDisplay);
    const hasExternal = displays.some((d) => !isInternalDisplay(d));
    const rows = displays.length + (hasInternal && hasExternal ? 0 : 1);
    return createSetupWindow(SETUP_MODE.ONBOARDING, null, boundsOf(target), rows);
  });
}

/**
 * Request the compact new-display prompt for an unrecognised external display.
 * If a setup window is already open, the key is appended to pendingSetupKeys
 * and the open window re-renders (it subscribes to storage.onChanged).
 * Opens on that display when it is connected, else where the user is looking.
 */
export function requestNewDisplayPrompt(key) {
  return withOpenLock(async () => {
    const state = await getState();
    const screen = state.screens[key];
    if (!screen || screen.confirmed || screen.isInternal || !state.onboardingCompleted) return null;

    const existing = await liveSetupWindowId();
    await addPendingSetupKey(key);
    if (existing != null) return existing;
    const display = screen.lastSeenDisplayId != null ? await getDisplayById(screen.lastSeenDisplayId) : null;
    const displays = await getDisplays();
    const target = display ?? (await userFacingDisplay(displays));
    return createSetupWindow(SETUP_MODE.NEW_DISPLAY, key, boundsOf(target), 1);
  });
}

/**
 * Called from windows.onRemoved. If the setup window was closed, clear the
 * dedupe id; any still-pending new-display keys are accepted at their default
 * (closing the prompt means "keep 125%"), so the user is never nagged again.
 */
export async function handleWindowRemoved(windowId) {
  const { setupWindowId, pendingSetupKeys } = await getSession();
  if (setupWindowId !== windowId) return false;
  await setSetupWindowId(null);
  if (pendingSetupKeys.length) {
    const state = await getState();
    for (const key of pendingSetupKeys) {
      if (state.screens[key] && !state.screens[key].confirmed) {
        await upsertScreen(key, { confirmed: true });
      }
    }
    await clearPendingSetupKeys();
  }
  return true;
}

/** Close the setup window if it is still open (after CONFIRM). */
export async function closeSetupWindow() {
  const id = await liveSetupWindowId();
  if (id == null) return;
  await clearPendingSetupKeys();
  await setSetupWindowId(null);
  await safeCall(() => chrome.windows.remove(id), 'windows.remove(setup)');
}

// Chrome adapter for tab zoom (engineering doc §5.5).
// This is the ONLY module that calls chrome.tabs.setZoom / setZoomSettings.
//
// Invariant (doc §0, decision 1): a tab is switched to per-tab scope before any
// setZoom. Per-origin scope would zoom every tab of that origin profile-wide
// and persist into Chrome's own zoom memory.
import { isSameZoom } from './zoom-ladder.js';
import { isZoomableUrl } from './url-rules.js';

const PER_TAB = Object.freeze({ mode: 'automatic', scope: 'per-tab' });
const PER_ORIGIN = Object.freeze({ mode: 'automatic', scope: 'per-origin' });

// Per-tab single-flight. Two overlapping operations on the SAME tab (e.g.
// normalizeScreen and a focus-change syncWindow both targeting the active tab)
// run one after the other, so the second one observes the first one's result
// and becomes a no-op instead of a duplicate setZoom. Different tabs are not
// serialized, so pool concurrency is unaffected. Pure cache: losing it on a
// service-worker restart changes nothing.
const inflightByTab = new Map(); // tabId → Promise that settles when the tab is free
function perTab(tabId, fn) {
  const previous = inflightByTab.get(tabId) ?? Promise.resolve();
  let release;
  const slot = new Promise((resolve) => {
    release = resolve;
  });
  inflightByTab.set(tabId, slot);
  return (async () => {
    try {
      await previous;
    } catch {
      // a failed predecessor must not block this tab
    }
    try {
      return await fn();
    } finally {
      release();
      if (inflightByTab.get(tabId) === slot) inflightByTab.delete(tabId);
    }
  })();
}

/** Errors that are expected during tab/window churn — swallowed silently. */
const EXPECTED_ERROR_RE =
  /no tab with id|no window with id|cannot zoom|discarded|tab was closed|tabs cannot be edited|cannot access|zoom is disabled|invalid tab id|frame with id|no current window/i;

/**
 * Run a chrome.* call, swallowing expected churn errors (returns `undefined`)
 * and logging anything unexpected (also returns `undefined`).
 */
export async function safeCall(fn, label = 'chrome call') {
  try {
    return await fn();
  } catch (err) {
    const message = err?.message ?? String(err);
    if (!EXPECTED_ERROR_RE.test(message)) {
      console.warn(`[AutoZoom] ${label} failed:`, message);
    }
    return undefined;
  }
}

/** True when AutoZoom may zoom this tab. */
export function isManageable(tab) {
  return Boolean(
    tab &&
      Number.isInteger(tab.id) &&
      tab.id >= 0 &&
      typeof tab.url === 'string' &&
      tab.url &&
      !tab.discarded &&
      isZoomableUrl(tab.url),
  );
}

/** Current zoom scope of a tab, or null if unavailable. */
export async function getScope(tabId) {
  const settings = await safeCall(() => chrome.tabs.getZoomSettings(tabId), 'getZoomSettings');
  return settings?.scope ?? null;
}

/**
 * Manage + apply: ensure per-tab scope, then set the zoom only if it differs.
 * Returns 'applied' | 'unchanged' | 'skipped' (tab vanished / not zoomable).
 */
export async function applyZoom(tabId, target) {
  if (!Number.isFinite(target) || target <= 0) return 'skipped';
  return perTab(tabId, () => applyZoomNow(tabId, target));
}

async function applyZoomNow(tabId, target) {
  let result = 'skipped';
  await safeCall(async () => {
    const settings = await chrome.tabs.getZoomSettings(tabId);
    if (settings?.scope !== 'per-tab') {
      // Isolate this tab BEFORE touching its zoom (doc §0 decision 1).
      await chrome.tabs.setZoomSettings(tabId, { ...PER_TAB });
    }
    const current = await chrome.tabs.getZoom(tabId);
    if (isSameZoom(current, target)) {
      result = 'unchanged';
      return;
    }
    await chrome.tabs.setZoom(tabId, target);
    result = 'applied';
  }, `applyZoom(${tabId})`);
  return result;
}

/**
 * Release: hand the tab back to Chrome's native per-origin zoom.
 * Returns 'released' | 'unchanged' (was never managed) | 'skipped'.
 *
 * Why the tab is first reset to Chrome's default zoom factor while still in
 * per-tab scope: when Chromium leaves isolated (per-tab) mode for a host that
 * has no stored per-origin level, it copies the tab's current level into the
 * host's zoom memory (ZoomController::SetZoomModeInternal, ZOOM_MODE_DEFAULT
 * branch). Writing the default first makes that copy a no-op — HostZoomMap
 * erases entries equal to the default — so Chrome's memory is never polluted
 * with AutoZoom's value (doc §0 decision 3). If the host *does* have a stored
 * level, Chrome restores it and the reset is harmless. The interim setZoom
 * happens in per-tab scope, so it cannot leak to sibling tabs.
 */
export async function releaseZoom(tabId) {
  return perTab(tabId, () => releaseZoomNow(tabId));
}

async function releaseZoomNow(tabId) {
  let result = 'skipped';
  await safeCall(async () => {
    const settings = await chrome.tabs.getZoomSettings(tabId);
    if (settings?.scope !== 'per-tab') {
      result = 'unchanged';
      return;
    }
    const defaultZoom = Number.isFinite(settings.defaultZoomFactor) ? settings.defaultZoomFactor : 1;
    const current = await chrome.tabs.getZoom(tabId);
    if (!isSameZoom(current, defaultZoom)) {
      await chrome.tabs.setZoom(tabId, defaultZoom); // still per-tab scope here
    }
    await chrome.tabs.setZoomSettings(tabId, { ...PER_ORIGIN });
    result = 'released';
  }, `releaseZoom(${tabId})`);
  return result;
}

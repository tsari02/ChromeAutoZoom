// Orchestration (engineering doc §5.6 / §5.7): syncWindow · syncTab ·
// normalizeScreen · handleZoomChange · releaseAll · clearSiteExceptions.
//
// No correctness depends on in-memory state. Every function reads storage
// fresh and writes storage BEFORE issuing the zoom calls it implies, so the
// stateless manual-zoom detector always sees the new expected value.
import { NORMALIZE_CONCURRENCY, INTERNAL_KEY } from './constants.js';
import * as storage from './storage.js';
import { getDisplays } from './display-cache.js';
import { resolveDisplay } from './geometry.js';
import { matchSavedScreen, buildKey, newScreenProfile, isInternalDisplay } from './screen-keys.js';
import { expectedZoom, isSameZoom, stepDelta } from './zoom-ladder.js';
import { hostOf } from './url-rules.js';
import { isManageable, applyZoom, releaseZoom, safeCall } from './tab-zoom.js';
import * as badge from './badge.js';
import { requestNewDisplayPrompt, closeSetupWindow } from './setup-window.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The zoom a tab should have, or null when AutoZoom must not touch it
 * (paused, onboarding not finished, unmanageable URL, excluded host).
 */
export function targetFor(tab, screen, state) {
  if (!state?.enabled || !state.onboardingCompleted || !screen) return null;
  if (!isManageable(tab)) return null;
  const host = hostOf(tab.url);
  if (state.excludedHosts?.[host]) return null;
  return expectedZoom(screen.zoomFactor, state.siteStepDeltas?.[host] ?? 0);
}

async function runPool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

async function normalWindows(populate) {
  const wins = await safeCall(
    () => chrome.windows.getAll({ populate, windowTypes: ['normal'] }),
    'windows.getAll',
  );
  return (wins ?? []).filter((w) => w.type === 'normal');
}

// ---------------------------------------------------------------------------
// Display profiles
// ---------------------------------------------------------------------------

/**
 * Ensure every connected display has a saved profile. New external displays
 * (after onboarding) are queued for the compact new-display prompt.
 * Returns { displays, screens, created }.
 */
export async function syncDisplays() {
  const displays = await getDisplays();
  const created = [];
  let onboardingCompleted = false;
  // Recompute from the CURRENT screens record inside the serialized write so
  // a concurrent popup change (SET_SCREEN_ZOOM) can never be reverted.
  const screens = await storage.updateScreens((saved, state) => {
    onboardingCompleted = state.onboardingCompleted;
    const next = { ...saved };
    let changed = false;
    created.length = 0;
    for (const d of displays) {
      const m = matchSavedScreen(d, next, displays);
      if (m) {
        if (m.needsIdUpdate) {
          next[m.key] = { ...m.screen, lastSeenDisplayId: d.id };
          changed = true;
        }
        continue;
      }
      const key = buildKey(d, displays);
      const zoom = isInternalDisplay(d) ? state.defaults.internal : state.defaults.external;
      const profile = newScreenProfile(d, key, zoom);
      // The built-in display never needs a prompt once onboarding is done.
      if (profile.isInternal && state.onboardingCompleted) profile.confirmed = true;
      next[key] = profile;
      created.push(key);
      changed = true;
    }
    return changed ? next : null;
  });

  if (onboardingCompleted) {
    for (const key of created) {
      if (!screens[key].isInternal) await requestNewDisplayPrompt(key);
    }
  }
  return { displays, screens, created };
}

/**
 * Resolve a window to its saved screen profile (creating one if missing).
 * Returns null for minimized/off-screen windows (caller keeps last known key).
 */
async function resolveScreenForWindow(win, displays, state) {
  const resolved = resolveDisplay(win, displays);
  if (!resolved) return null;
  const { display, confidence } = resolved;

  let m = matchSavedScreen(display, state.screens, displays);
  if (!m) {
    const key = buildKey(display, displays);
    const zoom = isInternalDisplay(display) ? state.defaults.internal : state.defaults.external;
    const profile = newScreenProfile(display, key, zoom);
    if (profile.isInternal && state.onboardingCompleted) profile.confirmed = true;
    const screen = await storage.upsertScreen(key, profile);
    state.screens[key] = screen;
    m = { key, screen, needsIdUpdate: false };
  } else if (m.needsIdUpdate) {
    const screen = await storage.upsertScreen(m.key, { lastSeenDisplayId: display.id });
    state.screens[m.key] = screen;
    m = { ...m, screen };
  }
  return { key: m.key, screen: m.screen, confidence, display };
}

/**
 * Screen profile for a window: last resolved key from storage.session, else
 * resolve from geometry now. Null when unknown (e.g. minimized, never seen).
 */
export async function screenForWindow(windowId, state) {
  const st = state ?? (await storage.getState());
  const key = await storage.getWindowScreen(windowId);
  if (key && st.screens[key]) return st.screens[key];

  const win = await safeCall(() => chrome.windows.get(windowId), 'windows.get');
  if (!win || win.type !== 'normal') return null;
  const displays = await getDisplays();
  const r = await resolveScreenForWindow(win, displays, st);
  if (!r) return null;
  await storage.setWindowScreen(windowId, r.key);
  return r.screen;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Re-evaluate one window: resolve its display, remember the key, apply the
 * screen zoom to the ACTIVE tab only (FR-7) and paint the badge.
 * `reason === 'bounds'` short-circuits when the resolved key is unchanged.
 */
export async function syncWindow(windowId, { reason = 'manual' } = {}) {
  const win = await safeCall(() => chrome.windows.get(windowId, { populate: true }), 'windows.get');
  if (!win || win.type !== 'normal') return null;

  const [displays, state] = await Promise.all([getDisplays(), storage.getState()]);
  const r = await resolveScreenForWindow(win, displays, state);
  if (!r) return null; // minimized: keep last known screen, never snap to primary

  const prevKey = await storage.getWindowScreen(windowId);
  if (reason === 'bounds' && prevKey === r.key) {
    return { key: r.key, changed: false, confidence: r.confidence, result: 'unchanged-key' };
  }
  await storage.setWindowScreen(windowId, r.key);

  if (state.onboardingCompleted && !r.screen.confirmed && !r.screen.isInternal) {
    await requestNewDisplayPrompt(r.key);
  }

  let result = 'skipped';
  const active = (win.tabs ?? []).find((t) => t.active);
  if (active) {
    const target = targetFor(active, r.screen, state);
    if (target != null) result = await applyZoom(active.id, target);
    await badge.update(active, r.screen, state);
  }
  return { key: r.key, changed: prevKey !== r.key, confidence: r.confidence, result };
}

/** Lazy per-tab sync (FR-8): used by tabs.onActivated / tabs.onUpdated. */
export async function syncTab(tabId) {
  const tab = await safeCall(() => chrome.tabs.get(tabId), 'tabs.get');
  if (!tab || tab.id == null) return 'skipped';
  const state = await storage.getState();
  const screen = await screenForWindow(tab.windowId, state);
  await badge.update(tab, screen, state);
  const target = targetFor(tab, screen, state);
  if (target == null) return 'skipped';
  return applyZoom(tab.id, target);
}

/** syncWindow for every normal window (startup, display change, resume). */
export async function resyncAllWindows(reason = 'resync') {
  const wins = await normalWindows(false);
  const results = await Promise.all(wins.map((w) => syncWindow(w.id, { reason })));
  return results.filter(Boolean);
}

/**
 * Apply the screen zoom to EVERY manageable tab in every window on `screenKey`
 * (FR-6). Active tabs first, through a pool of NORMALIZE_CONCURRENCY workers.
 * Returns { updated, applied, unchanged, skipped }.
 */
export async function normalizeScreen(screenKey) {
  const state = await storage.getState();
  const screen = state.screens[screenKey];
  const summary = { updated: 0, applied: 0, unchanged: 0, skipped: 0 };
  if (!screen) return summary;

  const displays = await getDisplays();
  const wins = await normalWindows(true);
  const tabs = [];
  for (const win of wins) {
    let key = null;
    const resolved = resolveDisplay(win, displays);
    if (resolved) {
      const m = matchSavedScreen(resolved.display, state.screens, displays);
      key = m?.key ?? buildKey(resolved.display, displays);
      if (key === screenKey) await storage.setWindowScreen(win.id, key);
    } else {
      key = await storage.getWindowScreen(win.id); // minimized: last known
    }
    if (key !== screenKey) continue;
    for (const t of win.tabs ?? []) tabs.push(t);
  }
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));

  await runPool(tabs, NORMALIZE_CONCURRENCY, async (tab) => {
    const target = targetFor(tab, screen, state);
    if (target == null) {
      summary.skipped++;
      return;
    }
    const res = await applyZoom(tab.id, target);
    if (res === 'skipped') summary.skipped++;
    else {
      summary.updated++;
      summary[res]++;
    }
    if (tab.active) await badge.update(tab, screen, state);
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Manual-zoom detection (doc §5.7) — stateless
// ---------------------------------------------------------------------------

export async function handleZoomChange({ tabId, oldZoomFactor, newZoomFactor, zoomSettings }) {
  // (1) Not ours / just navigated → ignore. Per-origin events come from
  //     Chrome's own memory or sibling tabs and must never be recorded.
  if (zoomSettings?.scope !== 'per-tab') return 'ignored:scope';
  // (1b) Switching a tab into per-tab scope makes Chromium echo an event with
  //      old === new (ZoomController::SetZoomModeInternal → SetTemporaryZoomLevel
  //      with the original level). Nothing changed, so there is nothing to record.
  if (Number.isFinite(oldZoomFactor) && isSameZoom(oldZoomFactor, newZoomFactor)) return 'ignored:no-change';

  const state = await storage.getState();
  if (!state.enabled || !state.onboardingCompleted) return 'ignored:disabled';

  const tab = await safeCall(() => chrome.tabs.get(tabId), 'tabs.get');
  if (!tab || !isManageable(tab)) return 'ignored:tab';
  const host = hostOf(tab.url);
  if (state.excludedHosts[host]) return 'ignored:excluded';

  const screen = await screenForWindow(tab.windowId, state);
  if (!screen) return 'ignored:no-screen';

  const expected = expectedZoom(screen.zoomFactor, state.siteStepDeltas[host] ?? 0);
  // (2) Matches what we would set → caused by us (or a no-op) → no record.
  if (isSameZoom(newZoomFactor, expected)) return 'ignored:expected';

  const delta = stepDelta(newZoomFactor, screen.zoomFactor);
  await storage.setSiteStepDelta(host, delta); // 0 ⇒ entry removed
  const next = await storage.getState();
  await badge.update(tab, screen, next);
  return `recorded:${delta}`;
}

// ---------------------------------------------------------------------------
// Bulk operations used by the popup / setup page
// ---------------------------------------------------------------------------

async function allManageableTabs() {
  const wins = await normalWindows(true);
  const tabs = [];
  for (const w of wins) for (const t of w.tabs ?? []) if (isManageable(t)) tabs.push(t);
  return tabs;
}

/** Hand every managed tab back to Chrome's native zoom (Pause / Restore). */
export async function releaseAll() {
  const tabs = await allManageableTabs();
  const state = await storage.getState();
  let released = 0;
  await runPool(tabs, NORMALIZE_CONCURRENCY, async (tab) => {
    const res = await releaseZoom(tab.id);
    if (res === 'released') released++;
    if (tab.active) await badge.update(tab, null, state);
  });
  return { released, total: tabs.length };
}

/** Global toggle (doc §8). Writes state first, then releases / re-applies. */
export async function setEnabled(enabled) {
  await storage.patchState({ enabled: Boolean(enabled) });
  if (enabled) return { enabled: true, synced: (await resyncAllWindows('resume')).length };
  return { enabled: false, ...(await releaseAll()) };
}

/**
 * Change one screen's default zoom and normalize every window on it.
 * Storage is written first; normalization runs in the background unless
 * `awaitNormalize` is set (tests), so UI responses are never blocked.
 */
export async function setScreenZoom(key, factor, { awaitNormalize = false } = {}) {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid zoom factor');
  const { screens } = await storage.getState();
  if (!screens[key]) throw new Error(`Unknown screen key: ${String(key)}`);
  await storage.upsertScreen(key, { zoomFactor: factor, confirmed: true });
  const normalizing = (async () => {
    try {
      return await normalizeScreen(key);
    } catch (err) {
      console.warn('[AutoZoom] normalizeScreen failed:', err?.message ?? err);
      return null;
    }
  })();
  if (awaitNormalize) return normalizing;
  return { key, factor, normalizing: true };
}

/** Exclude (release) or re-include (re-manage) every tab of a host. */
export async function setExcluded(host, excluded) {
  await storage.setExcludedHost(host, excluded);
  const tabs = (await allManageableTabs()).filter((t) => hostOf(t.url) === host);
  let count = 0;
  await runPool(tabs, NORMALIZE_CONCURRENCY, async (tab) => {
    const res = excluded ? await releaseZoom(tab.id) : await syncTab(tab.id);
    if (res === 'released' || res === 'applied' || res === 'unchanged') count++;
    if (excluded && tab.active) {
      const state = await storage.getState();
      await badge.update(tab, null, state);
    }
  });
  return { host, excluded: Boolean(excluded), tabs: count };
}

/** Delete one host's delta and re-sync its tabs to the screen default. */
export async function clearSiteDelta(host) {
  await storage.setSiteStepDelta(host, 0);
  const tabs = (await allManageableTabs()).filter((t) => hostOf(t.url) === host);
  await runPool(tabs, NORMALIZE_CONCURRENCY, (tab) => syncTab(tab.id));
  return { host, tabs: tabs.length };
}

/** Wipe all site deltas and normalize every connected screen. */
export async function clearSiteExceptions() {
  await storage.patchState({ siteStepDeltas: {} });
  const { displays, screens } = await syncDisplays();
  const keys = new Set();
  for (const d of displays) keys.add(matchSavedScreen(d, screens, displays)?.key ?? buildKey(d, displays));
  const results = {};
  for (const key of keys) results[key] = await normalizeScreen(key);
  return results;
}

/**
 * Onboarding / new-display CONFIRM: persist chosen zooms, mark onboarding
 * complete, and return. The caller normalizes in the background.
 */
export async function confirmSetup({ screens: chosen = {}, defaults = {} } = {}) {
  await storage.updateState((state) => {
    const screens = { ...state.screens };
    const nextDefaults = { ...state.defaults };
    if (Number.isFinite(defaults.internal)) nextDefaults.internal = defaults.internal;
    if (Number.isFinite(defaults.external)) nextDefaults.external = defaults.external;

    for (const [key, factor] of Object.entries(chosen)) {
      if (!Number.isFinite(factor) || factor <= 0) continue;
      const existing = screens[key];
      screens[key] = {
        key,
        name: existing?.name ?? (key === INTERNAL_KEY ? 'Built-in Display' : key.replace(/^ext:/, '')),
        isInternal: existing?.isInternal ?? key === INTERNAL_KEY,
        lastSeenDisplayId: existing?.lastSeenDisplayId ?? null,
        zoomFactor: factor,
        confirmed: true,
      };
    }
    return { screens, defaults: nextDefaults, onboardingCompleted: true };
  });
  await closeSetupWindow();
  return Object.keys(chosen);
}

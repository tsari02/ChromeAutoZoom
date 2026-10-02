// Orchestration (engineering doc v3 §5.4 / §6): syncDisplays · syncAll ·
// syncWindow · syncTab · normalizeScreen · handleZoomChange · setEnabled ·
// releaseAll · restoreChromeZoom · confirmSetup · renameScreen.
//
// No correctness depends on in-memory state. Every function reads storage
// fresh and writes storage BEFORE issuing the zoom calls it implies, so the
// stateless manual-zoom detector always sees the new expected value.
import { NORMALIZE_CONCURRENCY } from './constants.js';
import * as storage from './storage.js';
import { getDisplays } from './display-cache.js';
import { resolveDisplay } from './geometry.js';
import { matchSavedScreen, buildKey, newScreenProfile, profileRefreshPatch } from './screen-keys.js';
import { expectedZoom, isSameZoom, stepDelta } from './zoom-ladder.js';
import { recommendedZoom, sizeKey, withLearnedDefault } from './zoom-map.js';
import { resolveDelta } from './site-deltas.js';
import { hostOf } from './url-rules.js';
import { isManageable, applyZoom, releaseZoom, safeCall } from './tab-zoom.js';
import * as badge from './badge.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The zoom a tab should have, or null when AutoZoom must not touch it
 * (paused, onboarding not finished, unmanageable URL, excluded host).
 * The site delta is the explicit row for this screen, else the one inherited
 * from the closest other screen (site-deltas.resolveDelta).
 */
export function targetFor(tab, screen, state) {
  if (!state?.enabled || !state.onboardingCompleted || !screen) return null;
  if (!isManageable(tab)) return null;
  const host = hostOf(tab.url);
  if (state.excludedHosts?.[host]) return null;
  return expectedZoom(screen.zoomFactor, resolveDelta(host, screen.key, state).delta);
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
 * Ensure every connected display has a saved profile. New profiles are seeded
 * from the resolution map (+ learned overrides); matched profiles get their
 * `lastSeenDisplayId` and logical `width/height` refreshed (pitfall C2 — this
 * is one of the two refresh paths, `resolveScreenForWindow` is the other).
 * Returns { displays, screens, created }. Does NOT normalize: the caller
 * decides (see `syncAll` / `normalizeNewScreen`).
 */
export async function syncDisplays() {
  const displays = await getDisplays();
  const created = [];
  // Recompute from the CURRENT screens record inside the serialized write so
  // a concurrent popup change (SET_SCREEN_ZOOM) can never be reverted.
  const screens = await storage.updateScreens((saved, state) => {
    const next = { ...saved };
    let changed = false;
    created.length = 0;
    for (const d of displays) {
      const m = matchSavedScreen(d, next, displays);
      if (m) {
        const patch = profileRefreshPatch(m.screen, d);
        if (patch) {
          next[m.key] = { ...m.screen, ...patch };
          changed = true;
        }
        continue;
      }
      const key = buildKey(d, displays);
      next[key] = newScreenProfile(d, key, recommendedZoom(d, state.learnedDefaults), next);
      created.push(key);
      changed = true;
    }
    return changed ? next : null;
  });
  return { displays, screens, created };
}

// In-flight guard for "normalize a freshly created screen" (pitfall C1).
// `syncAll` and N concurrent `resolveScreenForWindow` calls can all learn about
// the same never-seen monitor in the same burst; only the caller that actually
// CREATED the profile asks for normalization, and overlapping requests for the
// same key join the running pass instead of starting another one. The map is
// a cache: if the service worker dies mid-pass, background tabs on that screen
// sync lazily on activation (FR-8) — nothing is lost.
const normalizingNew = new Map(); // screenKey → Promise<summary|null>

/**
 * Normalize a screen whose profile was created a moment ago. No-op before
 * first-run Accept (nothing may be zoomed until then). Never throws.
 */
export function normalizeNewScreen(key) {
  const running = normalizingNew.get(key);
  if (running) return running;
  const pass = (async () => {
    try {
      const { onboardingCompleted } = await storage.getState();
      if (!onboardingCompleted) return null;
      return await normalizeScreen(key);
    } catch (err) {
      console.warn('[AutoZoom] normalizeScreen failed:', err?.message ?? err);
      return null;
    } finally {
      normalizingNew.delete(key);
    }
  })();
  normalizingNew.set(key, pass);
  return pass;
}

/** Test hook: resolves once every background new-screen normalization has settled. */
export async function settleBackgroundWork() {
  while (normalizingNew.size) await Promise.all([...normalizingNew.values()]);
}

/**
 * Full pass used by startup, update and display changes: profiles for every
 * connected display → every window's active tab → whole-screen normalization
 * for the screens created in THIS pass (decision 1.3: a new monitor gets its
 * recommended zoom immediately, no prompt). Returns the created keys so the
 * display-change handler can normalize them again in its delayed pass.
 */
export async function syncAll(reason = 'resync') {
  const { created } = await syncDisplays();
  await resyncAllWindows(reason);
  for (const key of created) await normalizeNewScreen(key);
  return created;
}

/**
 * Resolve a window to its saved screen profile (creating one if missing).
 * Returns null for minimized/off-screen windows (caller keeps last known key).
 * A profile created here after first run triggers a background
 * `normalizeNewScreen` so a window dragged to a never-seen monitor gets ALL
 * its tabs set, not only the active one.
 */
async function resolveScreenForWindow(win, displays, state) {
  const resolved = resolveDisplay(win, displays);
  if (!resolved) return null;
  const { display, confidence } = resolved;

  let m = matchSavedScreen(display, state.screens, displays);
  if (!m) {
    const key = buildKey(display, displays);
    const profile = newScreenProfile(display, key, recommendedZoom(display, state.learnedDefaults), state.screens);
    // Serialized create-if-absent: of N windows racing for the same new
    // display exactly one gets `created`, and only that one normalizes (C1).
    const { screen, created } = await storage.createScreenIfAbsent(key, profile);
    state.screens[key] = screen;
    if (created && state.onboardingCompleted) normalizeNewScreen(key);
    m = { key, screen, needsIdUpdate: false };
  } else {
    const patch = profileRefreshPatch(m.screen, display); // id and/or size (C2)
    if (patch) {
      const screen = await storage.upsertScreen(m.key, patch);
      state.screens[m.key] = screen;
      m = { ...m, screen };
    }
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

/** Keys of the screens that are connected right now (profiles created if missing). */
async function connectedKeys() {
  const { displays, screens } = await syncDisplays();
  const keys = new Set();
  for (const d of displays) keys.add(matchSavedScreen(d, screens, displays)?.key ?? buildKey(d, displays));
  return [...keys];
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

  const expected = expectedZoom(screen.zoomFactor, resolveDelta(host, screen.key, state).delta);
  // (2) Matches what we would set → caused by us (or a no-op) → no record.
  if (isSameZoom(newZoomFactor, expected)) return 'ignored:expected';

  // Explicit row for THIS screen — 0 included. A 0 row is what makes
  // "correct it back on the laptop" stick instead of re-inheriting the other
  // screen's delta (doc v3 §5.4); the host is pruned once all its rows are 0.
  const delta = stepDelta(newZoomFactor, screen.zoomFactor);
  await storage.setSiteStepDelta(host, screen.key, delta);
  const next = await storage.getState();
  await badge.update(tab, screen, next);
  return `recorded:${delta}`;
}

// ---------------------------------------------------------------------------
// Bulk operations used by the popup
// ---------------------------------------------------------------------------

async function allManageableTabs() {
  const wins = await normalWindows(true);
  const tabs = [];
  for (const w of wins) for (const t of w.tabs ?? []) if (isManageable(t)) tabs.push(t);
  return tabs;
}

/** Hand every managed tab back to Chrome's native zoom. */
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

/**
 * Global toggle (doc v3 §5.4).
 *  - off: "freeze & detach" — ONLY the flag flips and active badges go OFF.
 *    No zoom call of any kind: tabs keep their per-tab zoom; Chrome itself
 *    resets them to per-origin on their next cross-document navigation.
 *  - on: every window's active tab (resyncAllWindows) AND every other tab on
 *    every connected screen (normalizeScreen per connected key, pitfall A3),
 *    so background tabs are re-applied immediately, not lazily.
 */
export async function setEnabled(enabled) {
  await storage.patchState({ enabled: Boolean(enabled) });
  if (!enabled) {
    const state = await storage.getState();
    const wins = await normalWindows(true);
    for (const w of wins) {
      const active = (w.tabs ?? []).find((t) => t.active);
      if (active) await badge.update(active, null, state);
    }
    return { enabled: false };
  }
  const synced = (await resyncAllWindows('resume')).length;
  const normalized = {};
  for (const key of await connectedKeys()) normalized[key] = await normalizeScreen(key);
  return { enabled: true, synced, normalized };
}

/**
 * "Restore Chrome's zoom" (RELEASE_ALL) — the ONLY action that hands tabs
 * back to Chrome (pitfall A2). Pauses first so nothing re-manages a tab
 * between release and the user's next click, then releases every managed tab.
 */
export async function restoreChromeZoom() {
  await storage.patchState({ enabled: false });
  return { enabled: false, ...(await releaseAll()) };
}

/**
 * Change one screen's default zoom and normalize every window on it. Storage
 * is written first; normalization runs in the background unless
 * `awaitNormalize` is set (tests), so UI responses are never blocked.
 * External screens also teach the map: the next never-seen monitor with the
 * same logical size seeds from this value (doc v3 §4). Internal is never
 * learned, and a size-less profile (v2-migrated, not yet re-seen) has no
 * size key and teaches nothing (pitfall A4).
 */
export async function setScreenZoom(key, factor, { awaitNormalize = false } = {}) {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid zoom factor');
  const { screens } = await storage.getState();
  const screen = screens[key];
  if (!screen) throw new Error(`Unknown screen key: ${String(key)}`);
  await storage.upsertScreen(key, { zoomFactor: factor });
  const learned = screen.isInternal ? false : await storage.setLearnedDefault(sizeKey(screen), factor);
  const normalizing = (async () => {
    try {
      return await normalizeScreen(key);
    } catch (err) {
      console.warn('[AutoZoom] normalizeScreen failed:', err?.message ?? err);
      return null;
    }
  })();
  if (awaitNormalize) return normalizing;
  return { key, factor, learned, normalizing: true };
}

/**
 * Exclude (release) or re-include (re-manage) every tab of a host. Excluding
 * also forgets the host's per-screen delta rows (doc v3 §5.4).
 */
export async function setExcluded(host, excluded) {
  await storage.setExcludedHost(host, excluded);
  if (excluded) await storage.clearHostDeltas(host);
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

/** Wipe all site deltas and normalize every connected screen. */
export async function clearSiteExceptions() {
  await storage.patchState({ siteStepDeltas: {} });
  const results = {};
  for (const key of await connectedKeys()) results[key] = await normalizeScreen(key);
  return results;
}

/**
 * First-run Accept (doc v3 §5.4 / §7): persist the chosen zoom for every
 * KNOWN key, mark onboarding complete and, for each external whose choice
 * differs from what the map recommended, teach the map in the same write.
 * `withLearnedDefault` refuses size-less keys, so a migrated profile that has
 * never been re-seen cannot poison `learnedDefaults` (pitfall A4). Unknown
 * keys are ignored. Returns the keys applied; the caller normalizes them.
 */
export async function confirmSetup({ screens: chosen = {} } = {}) {
  await syncDisplays(); // every connected display has a profile to write into
  const applied = [];
  await storage.updateState((state) => {
    const screens = { ...state.screens };
    let learnedDefaults = { ...state.learnedDefaults };
    applied.length = 0;
    for (const [key, raw] of Object.entries(chosen ?? {})) {
      const factor = Number(raw);
      const existing = screens[key];
      if (!existing || !Number.isFinite(factor) || factor <= 0) continue;
      screens[key] = { ...existing, zoomFactor: factor };
      applied.push(key);
      if (!existing.isInternal && !isSameZoom(factor, recommendedZoom(existing, state.learnedDefaults))) {
        learnedDefaults = withLearnedDefault(learnedDefaults, sizeKey(existing), factor);
      }
    }
    return { screens, learnedDefaults, onboardingCompleted: true };
  });
  return applied;
}

/**
 * Rename a screen (doc v3 §5.4): storage write, then refresh the hover title
 * on the active tab of every window currently on that screen. Throws for an
 * unknown key so the popup can report it.
 */
export async function renameScreen(key, name) {
  const screen = await storage.renameScreen(key, name);
  if (!screen) throw new Error(`Unknown screen key: ${String(key)}`);
  const [state, { windowScreen }, wins] = await Promise.all([storage.getState(), storage.getSession(), normalWindows(true)]);
  for (const w of wins) {
    if (windowScreen[String(w.id)] !== key) continue;
    const active = (w.tabs ?? []).find((t) => t.active);
    if (active) await badge.update(active, screen, state);
  }
  return screen;
}

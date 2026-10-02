// Typed storage wrappers + schema migration (engineering doc v3 §3 / §5.3).
// storage.local  → durable settings.   storage.session → per-browser-session caches.
import { SCHEMA_VERSION, INTERNAL_KEY, SCREEN_NAME_MAX_LENGTH, RECOMMENDED_ZOOM } from './constants.js';
import { hostOf } from './url-rules.js';
import { defaultScreenName } from './screen-keys.js';
import { isSizeKey, withLearnedDefault } from './zoom-map.js';
import { withDelta, withoutHost } from './site-deltas.js';

const LOCAL_KEYS = [
  'schemaVersion',
  'enabled',
  'onboardingCompleted',
  'learnedDefaults',
  'screens',
  'siteStepDeltas',
  'excludedHosts',
];

/** v1/v2 keys that no longer exist in v3 and are removed by migration. */
const LEGACY_LOCAL_KEYS = ['defaults', 'defaultInternalZoom', 'defaultExternalZoom', 'excludedOrigins'];

/** v2 auto-labels (`displayLabel`): replaced by `defaultScreenName` on migration. */
const V2_AUTO_LABEL_RE = /^(?:Built-in Display|External Display(?: · \d+[x×]\d+)?)$/;

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    onboardingCompleted: false,
    learnedDefaults: {},
    screens: {},
    siteStepDeltas: {},
    excludedHosts: {},
  };
}

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** learnedDefaults: only positive "WxH" keys with positive finite factors survive (pitfall A4). */
export function normalizeLearnedDefaults(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const f = Number(value);
    if (isSizeKey(key) && Number.isFinite(f) && f > 0) out[key] = f;
  }
  return out;
}

/** siteStepDeltas: {host: {screenKey: {delta:int, updatedAt:num}}}; anything else is dropped. */
export function normalizeSiteStepDeltas(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [host, rows] of Object.entries(raw)) {
    if (!host || !isRecord(rows)) continue;
    const next = {};
    for (const [key, row] of Object.entries(rows)) {
      if (!key || !isRecord(row)) continue;
      if (!Number.isInteger(row.delta) || !Number.isFinite(row.updatedAt)) continue;
      next[key] = { delta: row.delta, updatedAt: row.updatedAt };
    }
    if (Object.keys(next).length) out[host] = next;
  }
  return out;
}

function normalizeScreens(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [key, screen] of Object.entries(raw)) if (isRecord(screen)) out[key] = screen;
  return out;
}

/** Defaults-merged, shape-validated state. Exported for tests; `getState()` uses it. */
export function normalize(raw) {
  const d = defaultState();
  const r = isRecord(raw) ? raw : {};
  return {
    schemaVersion: Number.isInteger(r.schemaVersion) ? r.schemaVersion : d.schemaVersion,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    onboardingCompleted: r.onboardingCompleted === true,
    learnedDefaults: normalizeLearnedDefaults(r.learnedDefaults),
    screens: normalizeScreens(r.screens),
    siteStepDeltas: normalizeSiteStepDeltas(r.siteStepDeltas),
    excludedHosts: isRecord(r.excludedHosts) ? r.excludedHosts : {},
  };
}

// ---------------------------------------------------------------------------
// Write serialization. EVERY read-modify-write of storage.local or
// storage.session goes through this single in-process queue, so two
// concurrent mutations (e.g. two Cmd+ events, or resyncAllWindows upserting
// lastSeenDisplayId while the popup changes a screen's zoom) can never lose
// a write. The queue is a cache: losing it on a service-worker restart costs
// nothing because every mutation re-reads storage inside its turn.
// ---------------------------------------------------------------------------

let writeQueue = Promise.resolve();
function serialized(fn) {
  const previous = writeQueue;
  const run = (async () => {
    try {
      await previous;
    } catch {
      // a failed predecessor must not block the queue
    }
    return fn();
  })();
  writeQueue = (async () => {
    try {
      await run;
    } catch {
      // swallowed here; the caller still receives the rejection via `run`
    }
  })();
  return run;
}

// ---------------------------------------------------------------------------
// storage.local
// ---------------------------------------------------------------------------

/** Full, defaults-merged state. Always read fresh — never cache across events. */
export async function getState() {
  const raw = await chrome.storage.local.get(LOCAL_KEYS);
  return normalize(raw ?? {});
}

/** Shallow-merge a partial state into storage.local (ordered with every other write). */
export function patchState(partial) {
  return serialized(() => chrome.storage.local.set(partial));
}

/**
 * Serialized read-modify-write: `fn(state)` receives the fresh, defaults-merged
 * state and returns the partial to persist (or null/undefined for no-op).
 * Resolves to the state after the write. Use this for ANY mutation that
 * depends on the current value.
 */
export function updateState(fn) {
  return serialized(async () => {
    const state = await getState();
    const partial = await fn(state);
    if (partial && Object.keys(partial).length) await chrome.storage.local.set(partial);
    return { ...state, ...(partial ?? {}) };
  });
}

/** First install: write defaults for any missing key (idempotent). */
export function initState() {
  return serialized(async () => {
    const raw = await chrome.storage.local.get(LOCAL_KEYS);
    const d = defaultState();
    const toWrite = {};
    for (const k of LOCAL_KEYS) if (raw[k] === undefined) toWrite[k] = d[k];
    if (Object.keys(toWrite).length) await chrome.storage.local.set(toWrite);
    return getState();
  });
}

// ---------------------------------------------------------------------------
// Migration (doc v3 §3). v1 → v2 shape (unchanged logic) → v3.
// ---------------------------------------------------------------------------

/**
 * Migrate older schemas to v3. Runs in onInstalled{reason:'update'}; idempotent
 * at ≥ current version (then only fills missing keys).
 */
export async function migrate() {
  const raw = await chrome.storage.local.get(null);
  const from = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : raw.enabled === undefined ? SCHEMA_VERSION : 1;
  if (from >= SCHEMA_VERSION) {
    await initState();
    return { from, to: SCHEMA_VERSION, migrated: false };
  }
  return serialized(() => migrateFrom(raw, from));
}

async function migrateFrom(raw, from) {
  const v2 = toV2Shape(raw);
  const next = v2ToV3(v2, Date.now());
  await chrome.storage.local.set(next);
  const stale = LEGACY_LOCAL_KEYS.filter((k) => k in raw);
  if (stale.length) await chrome.storage.local.remove(stale);
  // storage.session: only `windowScreen` survives into v3. Everything else the
  // v2 setup window kept there is dropped (it is rebuilt lazily anyway).
  const session = await chrome.storage.session.get(['windowScreen']);
  await chrome.storage.session.clear();
  if (isRecord(session.windowScreen)) await chrome.storage.session.set({ windowScreen: session.windowScreen });
  return { from, to: SCHEMA_VERSION, migrated: true };
}

/**
 * v1 (PRD shape: defaultInternalZoom / defaultExternalZoom, excludedOrigins
 * array, origin-keyed siteStepDeltas) or v2 raw → the v2 in-memory shape.
 */
function toV2Shape(raw) {
  const legacy = isRecord(raw.defaults) ? raw.defaults : {};
  const seeds = {
    internal: Number(legacy.internal ?? raw.defaultInternalZoom) || RECOMMENDED_ZOOM.internal,
    external: Number(legacy.external ?? raw.defaultExternalZoom) || RECOMMENDED_ZOOM.externalFallback,
  };
  const v2 = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    onboardingCompleted: raw.onboardingCompleted === true,
    screens: {},
    siteStepDeltas: {},
    excludedHosts: {},
  };

  for (const [oldKey, s] of Object.entries(isRecord(raw.screens) ? raw.screens : {})) {
    if (!isRecord(s)) continue;
    const key = s.isInternal ? INTERNAL_KEY : s.key ?? oldKey;
    v2.screens[key] = {
      key,
      name: typeof s.name === 'string' ? s.name : '',
      isInternal: Boolean(s.isInternal),
      zoomFactor: Number(s.zoomFactor) || (s.isInternal ? seeds.internal : seeds.external),
      lastSeenDisplayId: s.lastSeenDisplayId ?? s.hardwareId ?? null,
    };
  }

  for (const [k, v] of Object.entries(isRecord(raw.siteStepDeltas) ? raw.siteStepDeltas : {})) {
    const host = k.includes('://') ? hostOf(k) : k.toLowerCase();
    if (host && Number.isInteger(v) && v !== 0) v2.siteStepDeltas[host] = v;
  }

  const excluded = Array.isArray(raw.excludedOrigins)
    ? raw.excludedOrigins
    : Array.isArray(raw.excludedHosts)
      ? raw.excludedHosts
      : Object.keys(isRecord(raw.excludedHosts) ? raw.excludedHosts : {});
  for (const k of excluded) {
    const host = String(k).includes('://') ? hostOf(k) : String(k).toLowerCase();
    if (host) v2.excludedHosts[host] = true;
  }
  return v2;
}

/**
 * v2 → v3 (doc v3 §3):
 *  - `defaults` dropped (learnedDefaults starts empty)
 *  - screens: `confirmed` dropped; width/height null until the display is next
 *    seen; createdAt = now; v2 auto-labels replaced by defaultScreenName()
 *    (profile-driven, no live display needed — pitfall A5); other names kept
 *  - siteStepDeltas[host] = n fans out to {k: {delta: n, updatedAt: now}} for
 *    EVERY existing screen key k — reproduces v2 behaviour exactly until the
 *    user adjusts per screen
 */
function v2ToV3(v2, now) {
  const next = defaultState();
  next.enabled = v2.enabled;
  next.onboardingCompleted = v2.onboardingCompleted;
  next.excludedHosts = v2.excludedHosts;

  for (const [key, s] of Object.entries(v2.screens)) {
    const profile = {
      key,
      name: s.name.trim(),
      isInternal: s.isInternal,
      width: null,
      height: null,
      zoomFactor: s.zoomFactor,
      lastSeenDisplayId: s.lastSeenDisplayId,
      createdAt: now,
    };
    if (!profile.name || V2_AUTO_LABEL_RE.test(profile.name)) profile.name = defaultScreenName(profile, next.screens);
    next.screens[key] = profile;
  }

  const keys = Object.keys(next.screens);
  for (const [host, n] of Object.entries(v2.siteStepDeltas)) {
    if (!keys.length) break; // nothing to fan out onto
    next.siteStepDeltas[host] = Object.fromEntries(keys.map((k) => [k, { delta: n, updatedAt: now }]));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Persist an explicit per-(host, screen) step delta. 0 IS persisted — it is
 * what stops that screen from inheriting — unless the host's rows are then
 * all 0, in which case the host is pruned (see site-deltas.withDelta).
 */
export async function setSiteStepDelta(host, screenKey, delta) {
  if (!host || !screenKey || !Number.isInteger(delta)) return;
  await updateState(({ siteStepDeltas }) => ({ siteStepDeltas: withDelta(siteStepDeltas, host, screenKey, delta) }));
}

/** Remove every delta row of a host (exclude). */
export async function clearHostDeltas(host) {
  if (!host) return;
  await updateState(({ siteStepDeltas }) => {
    if (!(host in siteStepDeltas)) return null;
    return { siteStepDeltas: withoutHost(siteStepDeltas, host) };
  });
}

/**
 * Teach the map: `learnedDefaults[sizeKey] = factor`. Refuses keys without
 * positive dimensions (a v2-migrated profile has no size until next seen, so
 * its key is null — pitfall A4) and non-positive factors. Returns whether the
 * value was written.
 */
export async function setLearnedDefault(sizeKey, factor) {
  if (!isSizeKey(sizeKey) || !Number.isFinite(factor) || factor <= 0) return false;
  await updateState(({ learnedDefaults }) => ({ learnedDefaults: withLearnedDefault(learnedDefaults, sizeKey, factor) }));
  return true;
}

/** Mark/unmark a host as excluded. */
export async function setExcludedHost(host, excluded) {
  if (!host) return;
  await updateState(({ excludedHosts }) => {
    const next = { ...excludedHosts };
    if (excluded) next[host] = true;
    else delete next[host];
    return { excludedHosts: next };
  });
}

/** Merge a patch into one screen profile (creates it when absent). */
export async function upsertScreen(key, patch) {
  const { screens } = await updateState(({ screens }) => ({
    screens: { ...screens, [key]: { ...(screens[key] ?? { key }), ...patch, key } },
  }));
  return screens[key];
}

/**
 * Create a screen profile only if no profile exists for `key` (serialized, so
 * N concurrent callers racing for the same never-seen display produce exactly
 * one creation). Returns { screen, created } — `created` tells the caller
 * whether IT is the one that must normalize the new screen (pitfall C1).
 */
export async function createScreenIfAbsent(key, profile) {
  let created = false;
  const { screens } = await updateState(({ screens }) => {
    if (screens[key]) return null;
    created = true;
    return { screens: { ...screens, [key]: { ...profile, key } } };
  });
  return { screen: screens[key], created };
}

/**
 * Recompute the whole screens record from the CURRENT value (serialized).
 * `fn(screens, state)` returns the next record, or null to leave it alone.
 */
export async function updateScreens(fn) {
  const { screens } = await updateState((state) => {
    const next = fn(state.screens, state);
    return next ? { screens: next } : null;
  });
  return screens;
}

/** Trim, collapse whitespace, cap at SCREEN_NAME_MAX_LENGTH. '' when nothing usable is left. */
export function cleanScreenName(name) {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCREEN_NAME_MAX_LENGTH)
    .trim();
}

/**
 * Rename a screen. Empty (after cleaning) reverts to the default auto name.
 * Returns the updated profile, or null when the key is unknown.
 */
export async function renameScreen(key, name) {
  const { screens } = await updateState((state) => {
    const screen = state.screens[key];
    if (!screen) return null;
    const next = cleanScreenName(name) || defaultScreenName(screen, state.screens);
    if (next === screen.name) return null;
    return { screens: { ...state.screens, [key]: { ...screen, name: next } } };
  });
  return screens[key] ?? null;
}

// ---------------------------------------------------------------------------
// storage.session — only the window → screen map remains in v3.
// ---------------------------------------------------------------------------

export async function getSession() {
  const raw = await chrome.storage.session.get(['windowScreen']);
  return { windowScreen: isRecord(raw.windowScreen) ? raw.windowScreen : {} };
}

export async function getWindowScreen(windowId) {
  const { windowScreen } = await getSession();
  return windowScreen[String(windowId)] ?? null;
}

export function setWindowScreen(windowId, key) {
  return serialized(async () => {
    const { windowScreen } = await getSession();
    if (windowScreen[String(windowId)] === key) return;
    await chrome.storage.session.set({ windowScreen: { ...windowScreen, [String(windowId)]: key } });
  });
}

export function deleteWindowScreen(windowId) {
  return serialized(async () => {
    const { windowScreen } = await getSession();
    if (!(String(windowId) in windowScreen)) return;
    const next = { ...windowScreen };
    delete next[String(windowId)];
    await chrome.storage.session.set({ windowScreen: next });
  });
}

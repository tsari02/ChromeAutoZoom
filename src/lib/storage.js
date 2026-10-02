// Typed storage wrappers + schema migration (engineering doc §4).
// storage.local  → durable settings.   storage.session → per-browser-session caches.
import { DEFAULT_ZOOMS, SCHEMA_VERSION, INTERNAL_KEY } from './constants.js';
import { hostOf } from './url-rules.js';

const LOCAL_KEYS = [
  'schemaVersion',
  'enabled',
  'onboardingCompleted',
  'defaults',
  'screens',
  'siteStepDeltas',
  'excludedHosts',
];

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    onboardingCompleted: false,
    defaults: { ...DEFAULT_ZOOMS },
    screens: {},
    siteStepDeltas: {},
    excludedHosts: {},
  };
}

function normalize(raw) {
  const d = defaultState();
  return {
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : d.schemaVersion,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    onboardingCompleted: raw.onboardingCompleted === true,
    defaults: { ...d.defaults, ...(raw.defaults ?? {}) },
    screens: raw.screens && typeof raw.screens === 'object' ? raw.screens : {},
    siteStepDeltas:
      raw.siteStepDeltas && typeof raw.siteStepDeltas === 'object' ? raw.siteStepDeltas : {},
    excludedHosts:
      raw.excludedHosts && typeof raw.excludedHosts === 'object' && !Array.isArray(raw.excludedHosts)
        ? raw.excludedHosts
        : {},
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

/**
 * Migrate older schemas (v1 PRD shape: defaultInternalZoom / defaultExternalZoom,
 * excludedOrigins array, origin-keyed siteStepDeltas) to the v2 schema.
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
  const next = defaultState();
  next.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
  next.onboardingCompleted = raw.onboardingCompleted === true;
  next.defaults = {
    internal: Number(raw.defaults?.internal ?? raw.defaultInternalZoom ?? DEFAULT_ZOOMS.internal),
    external: Number(raw.defaults?.external ?? raw.defaultExternalZoom ?? DEFAULT_ZOOMS.external),
  };

  for (const [oldKey, s] of Object.entries(raw.screens ?? {})) {
    if (!s || typeof s !== 'object') continue;
    const key = s.isInternal ? INTERNAL_KEY : s.key ?? oldKey;
    next.screens[key] = {
      key,
      name: s.name ?? (s.isInternal ? 'Built-in Display' : 'External Display'),
      isInternal: Boolean(s.isInternal),
      zoomFactor: Number(s.zoomFactor) || (s.isInternal ? next.defaults.internal : next.defaults.external),
      confirmed: s.confirmed === true,
      lastSeenDisplayId: s.lastSeenDisplayId ?? s.hardwareId ?? null,
    };
  }

  for (const [k, v] of Object.entries(raw.siteStepDeltas ?? {})) {
    const host = k.includes('://') ? hostOf(k) : k.toLowerCase();
    if (host && Number.isInteger(v) && v !== 0) next.siteStepDeltas[host] = v;
  }

  const excluded = Array.isArray(raw.excludedOrigins)
    ? raw.excludedOrigins
    : Array.isArray(raw.excludedHosts)
      ? raw.excludedHosts
      : Object.keys(raw.excludedHosts ?? {});
  for (const k of excluded) {
    const host = String(k).includes('://') ? hostOf(k) : String(k).toLowerCase();
    if (host) next.excludedHosts[host] = true;
  }

  const stale = ['defaultInternalZoom', 'defaultExternalZoom', 'excludedOrigins'].filter((k) => k in raw);
  await chrome.storage.local.set(next);
  if (stale.length) await chrome.storage.local.remove(stale);
  return { from, to: SCHEMA_VERSION, migrated: true };
}

/** Persist a relative step delta for a host. 0 (or non-integer) removes the entry. */
export async function setSiteStepDelta(host, delta) {
  if (!host) return;
  await updateState(({ siteStepDeltas }) => {
    const next = { ...siteStepDeltas };
    if (Number.isInteger(delta) && delta !== 0) next[host] = delta;
    else delete next[host];
    return { siteStepDeltas: next };
  });
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

// ---------------------------------------------------------------------------
// storage.session — the small shared maps.
// ---------------------------------------------------------------------------

export async function getSession() {
  const raw = await chrome.storage.session.get(['windowScreen', 'setupWindowId', 'pendingSetupKeys']);
  return {
    windowScreen: raw.windowScreen ?? {},
    setupWindowId: Number.isInteger(raw.setupWindowId) ? raw.setupWindowId : null,
    pendingSetupKeys: Array.isArray(raw.pendingSetupKeys) ? raw.pendingSetupKeys : [],
  };
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

export function setSetupWindowId(id) {
  return serialized(async () => {
    if (Number.isInteger(id)) await chrome.storage.session.set({ setupWindowId: id });
    else await chrome.storage.session.remove('setupWindowId');
  });
}

export function addPendingSetupKey(key) {
  return serialized(async () => {
    const { pendingSetupKeys } = await getSession();
    if (pendingSetupKeys.includes(key)) return false;
    await chrome.storage.session.set({ pendingSetupKeys: [...pendingSetupKeys, key] });
    return true;
  });
}

export function clearPendingSetupKeys() {
  return serialized(() => chrome.storage.session.remove('pendingSetupKeys'));
}

// Minimal in-memory chrome.* stub for `node --test`. Zero dependencies.
//
// It models the parts of Chrome's zoom behaviour that matter for AutoZoom:
//  - per-origin scope: setZoom writes the host's zoom level and changes every
//    per-origin tab of that host (each one gets an onZoomChange event);
//  - per-tab scope: setZoom changes only that tab;
//  - setZoomSettings(per-tab) echoes an onZoomChange with old === new (as
//    ZoomController::SetZoomModeInternal does);
//  - setZoomSettings(per-origin) on a host with no stored level copies the
//    tab's current level into the host map (erased when equal to default);
//  - discarded tabs reject zoom calls ("Cannot zoom a tab in a discarded state").
// It also records every call and tracks the maximum number of concurrent
// zoom operations so tests can assert pool limits.

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    async emit(...args) {
      const results = [];
      for (const fn of [...listeners]) results.push(await fn(...args));
      return results;
    },
    get size() {
      return listeners.size;
    },
  };
}

function makeStorageArea(initial = {}) {
  let data = structuredClone(initial);
  const onChanged = makeEvent();
  const area = {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === 'string') return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      }
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : dflt;
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      await onChanged.emit(changes);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      data = {};
    },
    _dump: () => structuredClone(data),
    _onChanged: onChanged,
  };
  return area;
}

const yieldTick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Create a chrome mock.
 * @param {object} opts
 * @param {Array} opts.displays   system.display.getInfo() result
 * @param {Array} opts.windows    [{ id, type, state, left, top, width, height, focused }]
 * @param {Array} opts.tabs       [{ id, windowId, url, active, discarded }]
 * @param {object} opts.local     initial storage.local
 * @param {object} opts.session   initial storage.session
 * @param {number} opts.defaultZoom Chrome's default page zoom (1.0)
 */
export function createChromeMock({
  displays = [],
  windows = [],
  tabs = [],
  local = {},
  session = {},
  defaultZoom = 1,
  hostZoom = {},
} = {}) {
  const calls = [];
  const record = (api, ...args) => calls.push({ api, args: structuredClone(args) });

  const state = {
    displays: structuredClone(displays),
    windows: new Map(windows.map((w) => [w.id, { type: 'normal', state: 'normal', focused: false, ...w }])),
    tabs: new Map(
      tabs.map((t) => [t.id, { active: false, discarded: false, scope: 'per-origin', tempZoom: null, ...t }]),
    ),
    hostZoom: new Map(Object.entries(hostZoom)),
    defaultZoom,
    nextWindowId: Math.max(0, ...windows.map((w) => w.id)) + 1,
    nextTabId: Math.max(0, ...tabs.map((t) => t.id)) + 1,
  };

  const concurrency = { active: 0, max: 0 };
  async function zoomOp(fn) {
    concurrency.active++;
    concurrency.max = Math.max(concurrency.max, concurrency.active);
    try {
      await yieldTick();
      return await fn();
    } finally {
      concurrency.active--;
    }
  }

  const hostOfUrl = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };

  function tabOrThrow(tabId) {
    const tab = state.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }
  function zoomableTabOrThrow(tabId) {
    const tab = tabOrThrow(tabId);
    if (tab.discarded) throw new Error('Cannot zoom a tab in a discarded state.');
    if (!/^https?:|^file:/.test(tab.url ?? '')) throw new Error('Cannot zoom a tab in this state.');
    return tab;
  }
  function effectiveZoom(tab) {
    if (tab.scope === 'per-tab') return tab.tempZoom ?? state.defaultZoom;
    return state.hostZoom.get(hostOfUrl(tab.url)) ?? state.defaultZoom;
  }
  const settingsOf = (tab) => ({ mode: 'automatic', scope: tab.scope, defaultZoomFactor: state.defaultZoom });

  const publicTab = (t) => ({
    id: t.id,
    windowId: t.windowId,
    url: t.url,
    active: t.active,
    discarded: t.discarded,
    index: t.index ?? 0,
    status: 'complete',
  });
  const publicWindow = (w, populate) => ({
    id: w.id,
    type: w.type,
    state: w.state,
    focused: w.focused,
    left: w.left,
    top: w.top,
    width: w.width,
    height: w.height,
    ...(populate ? { tabs: [...state.tabs.values()].filter((t) => t.windowId === w.id).map(publicTab) } : {}),
  });

  const events = {
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    onMessage: makeEvent(),
    onDisplayChanged: makeEvent(),
    onBoundsChanged: makeEvent(),
    onFocusChanged: makeEvent(),
    onWindowRemoved: makeEvent(),
    onActivated: makeEvent(),
    onUpdated: makeEvent(),
    onTabRemoved: makeEvent(),
    onZoomChange: makeEvent(),
  };

  const zoomEvents = []; // every onZoomChange payload the mock dispatched
  async function fireZoomChange(tab, oldZoom, newZoom) {
    const info = { tabId: tab.id, oldZoomFactor: oldZoom, newZoomFactor: newZoom, zoomSettings: settingsOf(tab) };
    zoomEvents.push(info);
    await events.onZoomChange.emit(info);
  }

  let openPopupFailure = null; // see helpers.failOpenPopup / allowOpenPopup

  const chrome = {
    runtime: {
      id: 'mock-extension-id',
      getURL: (p) => `chrome-extension://mock-extension-id/${p}`,
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
      lastError: undefined,
    },
    storage: {
      local: makeStorageArea(local),
      session: makeStorageArea(session),
      onChanged: makeEvent(),
    },
    system: {
      display: {
        async getInfo() {
          record('system.display.getInfo');
          return structuredClone(state.displays);
        },
        onDisplayChanged: events.onDisplayChanged,
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      async get(windowId, { populate = false } = {}) {
        record('windows.get', windowId);
        const w = state.windows.get(windowId);
        if (!w) throw new Error(`No window with id: ${windowId}.`);
        return publicWindow(w, populate);
      },
      async getAll({ populate = false, windowTypes } = {}) {
        record('windows.getAll');
        return [...state.windows.values()]
          .filter((w) => !windowTypes || windowTypes.includes(w.type))
          .map((w) => publicWindow(w, populate));
      },
      async getLastFocused({ populate = false, windowTypes } = {}) {
        record('windows.getLastFocused', { windowTypes });
        const pool = [...state.windows.values()].filter((w) => !windowTypes || windowTypes.includes(w.type));
        const w = pool.find((x) => x.focused) ?? pool[0];
        if (!w) throw new Error('No current window');
        return publicWindow(w, populate);
      },
      async create(opts = {}) {
        record('windows.create', opts);
        const id = state.nextWindowId++;
        const w = {
          id,
          type: opts.type ?? 'normal',
          state: 'normal',
          focused: Boolean(opts.focused),
          left: opts.left ?? 0,
          top: opts.top ?? 0,
          width: opts.width ?? 800,
          height: opts.height ?? 600,
        };
        state.windows.set(id, w);
        if (opts.url) {
          const tid = state.nextTabId++;
          state.tabs.set(tid, { id: tid, windowId: id, url: opts.url, active: true, discarded: false, scope: 'per-origin', tempZoom: null });
        }
        return publicWindow(w, true);
      },
      async update(windowId, opts = {}) {
        record('windows.update', windowId, opts);
        const w = state.windows.get(windowId);
        if (!w) throw new Error(`No window with id: ${windowId}.`);
        Object.assign(w, opts);
        return publicWindow(w, false);
      },
      async remove(windowId) {
        record('windows.remove', windowId);
        if (!state.windows.delete(windowId)) throw new Error(`No window with id: ${windowId}.`);
        for (const [tid, t] of state.tabs) if (t.windowId === windowId) state.tabs.delete(tid);
        await events.onWindowRemoved.emit(windowId);
      },
      onBoundsChanged: events.onBoundsChanged,
      onFocusChanged: events.onFocusChanged,
      onRemoved: events.onWindowRemoved,
    },
    tabs: {
      async get(tabId) {
        record('tabs.get', tabId);
        return publicTab(tabOrThrow(tabId));
      },
      async query(info = {}) {
        record('tabs.query', info);
        return [...state.tabs.values()]
          .filter((t) => (info.windowId == null || t.windowId === info.windowId) && (info.active == null || t.active === info.active))
          .map(publicTab);
      },
      async getZoom(tabId) {
        record('tabs.getZoom', tabId);
        return zoomOp(() => effectiveZoom(zoomableTabOrThrow(tabId)));
      },
      async getZoomSettings(tabId) {
        record('tabs.getZoomSettings', tabId);
        return zoomOp(() => settingsOf(zoomableTabOrThrow(tabId)));
      },
      async setZoom(tabId, factor) {
        record('tabs.setZoom', tabId, factor);
        return zoomOp(async () => {
          const tab = zoomableTabOrThrow(tabId);
          const target = factor === 0 ? state.defaultZoom : factor;
          if (tab.scope === 'per-tab') {
            const old = effectiveZoom(tab);
            tab.tempZoom = target;
            await fireZoomChange(tab, old, target);
            return;
          }
          // per-origin: write host memory and move every per-origin sibling.
          const host = hostOfUrl(tab.url);
          const affected = [...state.tabs.values()].filter(
            (t) => t.scope === 'per-origin' && hostOfUrl(t.url) === host && !t.discarded,
          );
          const olds = new Map(affected.map((t) => [t.id, effectiveZoom(t)]));
          if (Math.abs(target - state.defaultZoom) < 0.001) state.hostZoom.delete(host);
          else state.hostZoom.set(host, target);
          for (const t of affected) await fireZoomChange(t, olds.get(t.id), target);
        });
      },
      async setZoomSettings(tabId, settings) {
        record('tabs.setZoomSettings', tabId, settings);
        return zoomOp(async () => {
          const tab = zoomableTabOrThrow(tabId);
          const scope = settings.scope ?? (settings.mode === 'automatic' ? 'per-origin' : 'per-tab');
          if (scope === tab.scope) return;
          const original = effectiveZoom(tab);
          if (scope === 'per-tab') {
            tab.scope = 'per-tab';
            tab.tempZoom = original;
            await fireZoomChange(tab, original, original); // Chromium echo
            return;
          }
          // Leaving isolated mode (ZoomController::SetZoomModeInternal, DEFAULT branch)
          const host = hostOfUrl(tab.url);
          tab.scope = 'per-origin';
          tab.tempZoom = null;
          if (state.hostZoom.has(host)) {
            await fireZoomChange(tab, original, state.hostZoom.get(host));
          } else {
            if (Math.abs(original - state.defaultZoom) >= 0.001) state.hostZoom.set(host, original);
            await fireZoomChange(tab, original, original);
          }
        });
      },
      onActivated: events.onActivated,
      onUpdated: events.onUpdated,
      onRemoved: events.onTabRemoved,
      onZoomChange: events.onZoomChange,
    },
    action: {
      async setBadgeText(d) {
        record('action.setBadgeText', d);
      },
      async setBadgeBackgroundColor(d) {
        record('action.setBadgeBackgroundColor', d);
      },
      async setTitle(d) {
        record('action.setTitle', d);
      },
      /**
       * chrome.action.openPopup() (Chrome 127+). Rejects while a failure is
       * armed via `failOpenPopup(message)` — e.g. "Could not find an active
       * browser window." — and resolves otherwise. Every call is recorded.
       */
      async openPopup(opts) {
        record('action.openPopup', opts ?? {});
        if (openPopupFailure) throw new Error(openPopupFailure);
      },
    },
  };

  // ---- test helpers (not part of chrome.*) --------------------------------
  const helpers = {
    calls,
    zoomEvents,
    concurrency,
    state,
    callsTo: (api) => calls.filter((c) => c.api === api),
    resetCalls() {
      calls.length = 0;
      zoomEvents.length = 0;
      concurrency.max = 0;
    },
    tab: (id) => state.tabs.get(id),
    zoomOf: (id) => effectiveZoom(state.tabs.get(id)),
    scopeOf: (id) => state.tabs.get(id)?.scope,
    hostZoom: state.hostZoom,
    setDisplays(d) {
      state.displays = structuredClone(d);
    },
    moveWindow(id, rect) {
      Object.assign(state.windows.get(id), rect);
    },
    /** Add a normal window to the world (e.g. one that sits on a newly plugged-in monitor). */
    addWindow(w) {
      state.windows.set(w.id, { type: 'normal', state: 'normal', focused: false, ...w });
      state.nextWindowId = Math.max(state.nextWindowId, w.id + 1);
    },
    /** Add a tab to the world (per-origin scope, not discarded unless stated). */
    addTab(t) {
      state.tabs.set(t.id, { active: false, discarded: false, scope: 'per-origin', tempZoom: null, ...t });
      state.nextTabId = Math.max(state.nextTabId, t.id + 1);
    },
    /** Make chrome.action.openPopup() reject with `message` until allowOpenPopup(). */
    failOpenPopup(message = 'Could not find an active browser window.') {
      openPopupFailure = String(message);
    },
    allowOpenPopup() {
      openPopupFailure = null;
    },
    /** Fake clock for `updatedAt` / `createdAt` ordering (see `clock` below). */
    clock,
    /** Simulate the user pressing Cmd +/- or Cmd 0 (Chrome changes zoom, then fires the event). */
    async userZoom(tabId, factor) {
      await chrome.tabs.setZoom(tabId, factor);
    },
    /** Simulate a cross-document navigation: per-tab settings reset, page loads at host zoom. */
    async navigate(tabId, url) {
      const tab = tabOrThrow(tabId);
      const old = effectiveZoom(tab);
      tab.url = url;
      tab.scope = 'per-origin';
      tab.tempZoom = null;
      const fresh = effectiveZoom(tab);
      await fireZoomChange(tab, old, fresh);
      await events.onUpdated.emit(tabId, { url, status: 'loading' }, publicTab(tab));
      await events.onUpdated.emit(tabId, { status: 'complete' }, publicTab(tab));
    },
  };

  return { chrome, ...helpers };
}

// Fake clock ------------------------------------------------------------------
//
// `Date.now` is what storage.js / site-deltas.js / screen-keys.js stamp into
// `updatedAt` and `createdAt`. Tests that depend on ordering pin it here; every
// `installChromeMock()` restores the real clock first so a pinned time never
// leaks into the next test.
const realDateNow = Date.now;
let fakeNow = null;
export const clock = {
  /** Pin Date.now() to `ms`. */
  set(ms) {
    fakeNow = Number(ms);
    Date.now = () => fakeNow;
  },
  /** Move the pinned clock forward (pins it to the real time first if needed). */
  advance(ms) {
    if (fakeNow == null) clock.set(realDateNow());
    fakeNow += Number(ms);
    return fakeNow;
  },
  restore() {
    fakeNow = null;
    Date.now = realDateNow;
  },
  get now() {
    return fakeNow ?? realDateNow();
  },
  get pinned() {
    return fakeNow != null;
  },
};

/** Install a mock as the global `chrome` (modules read it lazily at call time). */
export function installChromeMock(opts) {
  clock.restore();
  const mock = createChromeMock(opts);
  globalThis.chrome = mock.chrome;
  return mock;
}

// Convenience fixtures -------------------------------------------------------

export const DISPLAY_INTERNAL = Object.freeze({
  id: '69733382',
  name: 'Built-in Retina Display',
  isPrimary: true,
  isInternal: true,
  bounds: { left: 0, top: 0, width: 1512, height: 982 },
  workArea: { left: 0, top: 38, width: 1512, height: 944 },
});

export const DISPLAY_EXTERNAL = Object.freeze({
  id: '1026386291',
  name: 'LG UltraFine',
  isPrimary: false,
  isInternal: false,
  bounds: { left: 1512, top: -300, width: 2560, height: 1440 },
  workArea: { left: 1512, top: -262, width: 2560, height: 1402 },
});

export const DISPLAY_EXTERNAL_2 = Object.freeze({
  id: '2049383711',
  name: 'DELL U2723QE',
  isPrimary: false,
  isInternal: false,
  bounds: { left: 4072, top: -300, width: 2560, height: 1440 },
  workArea: { left: 4072, top: -262, width: 2560, height: 1402 },
});

/** 4K at 1× — the map says 150% (v2's flat default would have said 125%). */
export const DISPLAY_EXTERNAL_4K = Object.freeze({
  id: '3310028840',
  name: 'LG HDR 4K',
  isPrimary: false,
  isInternal: false,
  bounds: { left: 6632, top: -500, width: 3840, height: 2160 },
  workArea: { left: 6632, top: -462, width: 3840, height: 2122 },
});

/** 1080p — the map says 100%. */
export const DISPLAY_EXTERNAL_1080P = Object.freeze({
  id: '4471120013',
  name: 'BenQ GW2480',
  isPrimary: false,
  isInternal: false,
  bounds: { left: -1920, top: 0, width: 1920, height: 1080 },
  workArea: { left: -1920, top: 38, width: 1920, height: 1042 },
});

/** What macOS Chrome actually reports on many Macs: name "" for every display. */
export const DISPLAY_NAMELESS_QHD = Object.freeze({
  id: '2',
  name: '',
  isPrimary: false,
  isInternal: false,
  bounds: { left: 1512, top: 0, width: 2560, height: 1440 },
  workArea: { left: 1512, top: 38, width: 2560, height: 1402 },
});

export function windowOn(display, id, extra = {}) {
  const b = display.bounds;
  return {
    id,
    type: 'normal',
    state: 'normal',
    left: b.left + 100,
    top: b.top + 100,
    width: Math.min(1200, b.width - 200),
    height: Math.min(800, b.height - 200),
    ...extra,
  };
}

/** Fully-onboarded v3 storage.local with the two standard screens. */
export function onboardedLocal(overrides = {}) {
  return {
    schemaVersion: 3,
    enabled: true,
    onboardingCompleted: true,
    learnedDefaults: {},
    screens: {
      internal: {
        key: 'internal',
        name: 'Built-in Retina Display',
        isInternal: true,
        width: 1512,
        height: 982,
        zoomFactor: 1.0,
        lastSeenDisplayId: DISPLAY_INTERNAL.id,
        createdAt: 1790960000000,
      },
      'ext:lg-ultrafine': {
        key: 'ext:lg-ultrafine',
        name: 'LG UltraFine',
        isInternal: false,
        width: 2560,
        height: 1440,
        zoomFactor: 1.25,
        lastSeenDisplayId: DISPLAY_EXTERNAL.id,
        createdAt: 1790960001000,
      },
    },
    siteStepDeltas: {},
    excludedHosts: {},
    ...overrides,
  };
}

/** The exact storage.local shape shipped by 1.0.0 (schema v2), for migration tests. */
export function v2Local(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    onboardingCompleted: true,
    defaults: { internal: 1.0, external: 1.25 },
    screens: {
      internal: {
        key: 'internal',
        name: 'Built-in Display',
        isInternal: true,
        zoomFactor: 1.0,
        confirmed: true,
        lastSeenDisplayId: DISPLAY_INTERNAL.id,
      },
      'ext:lg-ultrafine': {
        key: 'ext:lg-ultrafine',
        name: 'LG UltraFine',
        isInternal: false,
        zoomFactor: 1.25,
        confirmed: true,
        lastSeenDisplayId: DISPLAY_EXTERNAL.id,
      },
    },
    siteStepDeltas: {},
    excludedHosts: {},
    ...overrides,
  };
}

/**
 * v3 delta rows for one host: deltaRows({ 'ext:lg-ultrafine': 1, internal: 0 }, 1790961000000)
 * → { 'ext:lg-ultrafine': { delta: 1, updatedAt }, internal: { delta: 0, updatedAt } }
 */
export function deltaRows(byKey, updatedAt = 1790961000000) {
  return Object.fromEntries(Object.entries(byKey).map(([k, delta]) => [k, { delta, updatedAt }]));
}

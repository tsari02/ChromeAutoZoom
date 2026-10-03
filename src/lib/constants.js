// Shared constants for AutoZoom. Pure data — safe to import from any context
// (service worker, extension pages, node tests).

/** Chrome's official 17-step zoom ladder (PRD §3). */
export const ZOOM_LADDER = Object.freeze([
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5,
  3.0, 4.0, 5.0,
]);

/** Index of 100% in the ladder. */
export const STEP_100 = 7;

/** Tolerance used only for equality checks between zoom factors. */
export const ZOOM_EPSILON = 0.005;

/**
 * Logical resolution → recommended zoom (engineering doc v3 §4).
 * Internal panels are always 100%; externals use an exact-size table, one
 * "small monitor" rule (≤ 1920×1200 → 100%) and a 125% fallback.
 */
export const RECOMMENDED_ZOOM = Object.freeze({
  internal: 1.0,
  bySize: Object.freeze({
    '2560x1080': 1.1,
    '3840x2160': 1.5,
    '5120x2880': 2.0,
  }),
  smallExternalMax: Object.freeze({ width: 1920, height: 1200 }),
  externalFallback: 1.25,
});

/** storage.local schema version (engineering doc v3 §3). */
export const SCHEMA_VERSION = 3;

/** Stable key for the built-in display profile. */
export const INTERNAL_KEY = 'internal';

/** Default (auto) screen names (doc v3 §5.1). */
export const DEFAULT_SCREEN_NAMES = Object.freeze({
  internal: 'MacBook Screen',
  external: 'External Display',
});

/** Max length of a user-entered screen name (doc v3 §5.3 renameScreen). */
export const SCREEN_NAME_MAX_LENGTH = 40;

/** Timings (engineering doc §6). */
export const TIMINGS = Object.freeze({
  boundsDebounceMs: 150,
  displayChangeDebounceMs: 500,
  displayChangeResyncDelayMs: 1500,
});

/** Max concurrent applyZoom calls during normalizeScreen (doc §5.6). */
export const NORMALIZE_CONCURRENCY = 8;

/** Badge appearance (doc §5.8). Excluded sites show no text since 1.1.0 (D25). */
export const BADGE = Object.freeze({
  off: { text: 'OFF', color: '#8E8E93' },
  zoom: { color: '#0A84FF' },
});

/** URL schemes AutoZoom never touches (FR-9). */
export const ZOOMABLE_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

/** Chrome Web Store hosts — Chrome refuses zoom API calls on these pages. */
export const WEBSTORE_HOSTS = Object.freeze([
  'chrome.google.com',
  'chromewebstore.google.com',
]);

/** Message types shared by the SW and the popup (doc v3 §8). */
export const MSG = Object.freeze({
  GET_POPUP_STATE: 'GET_POPUP_STATE',
  CONFIRM_SETUP: 'CONFIRM_SETUP',
  SET_ENABLED: 'SET_ENABLED',
  SET_SCREEN_ZOOM: 'SET_SCREEN_ZOOM',
  RENAME_SCREEN: 'RENAME_SCREEN',
  SET_EXCLUDED: 'SET_EXCLUDED',
  CLEAR_SITE_EXCEPTIONS: 'CLEAR_SITE_EXCEPTIONS',
  RELEASE_ALL: 'RELEASE_ALL',
});

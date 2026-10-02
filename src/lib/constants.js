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

/** Default zoom per display class (engineering doc §4). */
export const DEFAULT_ZOOMS = Object.freeze({ internal: 1.0, external: 1.25 });

/** storage.local schema version (engineering doc §4). */
export const SCHEMA_VERSION = 2;

/** Stable key for the built-in display profile. */
export const INTERNAL_KEY = 'internal';

/** Timings (engineering doc §6). */
export const TIMINGS = Object.freeze({
  boundsDebounceMs: 150,
  displayChangeDebounceMs: 500,
  displayChangeResyncDelayMs: 1500,
});

/** Max concurrent applyZoom calls during normalizeScreen (doc §5.6). */
export const NORMALIZE_CONCURRENCY = 8;

/** Setup window geometry (doc §7). */
export const SETUP_WINDOW = Object.freeze({
  width: 420,
  baseHeight: 180,
  rowHeight: 64,
  maxHeight: 720,
});

/** Badge appearance (doc §5.8). */
export const BADGE = Object.freeze({
  off: { text: 'OFF', color: '#8E8E93' },
  pinned: { text: 'PIN', color: '#FF9F0A' },
  zoom: { color: '#0A84FF' },
});

/** URL schemes AutoZoom never touches (FR-9). */
export const ZOOMABLE_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

/** Chrome Web Store hosts — Chrome refuses zoom API calls on these pages. */
export const WEBSTORE_HOSTS = Object.freeze([
  'chrome.google.com',
  'chromewebstore.google.com',
]);

/** Message types shared by the SW, popup and setup page (doc §7/§8). */
export const MSG = Object.freeze({
  GET_SETUP_DATA: 'GET_SETUP_DATA',
  CONFIRM_SETUP: 'CONFIRM_SETUP',
  DISMISS_SETUP: 'DISMISS_SETUP',
  GET_POPUP_STATE: 'GET_POPUP_STATE',
  SET_ENABLED: 'SET_ENABLED',
  SET_SCREEN_ZOOM: 'SET_SCREEN_ZOOM',
  SET_EXCLUDED: 'SET_EXCLUDED',
  CLEAR_SITE_DELTA: 'CLEAR_SITE_DELTA',
  CLEAR_SITE_EXCEPTIONS: 'CLEAR_SITE_EXCEPTIONS',
  RELEASE_ALL: 'RELEASE_ALL',
  OPEN_ONBOARDING: 'OPEN_ONBOARDING',
});

/** Setup page modes (doc §7). */
export const SETUP_MODE = Object.freeze({
  ONBOARDING: 'onboarding',
  NEW_DISPLAY: 'new-display',
});

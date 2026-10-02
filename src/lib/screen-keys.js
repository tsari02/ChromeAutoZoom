// PURE: stable display keys + matching against saved profiles (doc §5.2),
// plus the display-shape helpers shared by zoom-map.js / storage.js (v3 §5.1).
import { INTERNAL_KEY, DEFAULT_SCREEN_NAMES } from './constants.js';

const INTERNAL_NAME_RE = /built-in|color lcd|liquid retina/i;

/** Robust internal-display test (older macOS builds mislabel `isInternal`). */
export function isInternalDisplay(display) {
  return Boolean(display?.isInternal) || INTERNAL_NAME_RE.test(display?.name ?? '');
}

/** "LG UltraFine (2)" → "lg-ultrafine-2"; empty/unusable names → "". */
export function slug(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Logical (DIP) size of either a raw `chrome.system.display` entry (size under
 * `bounds`) or a stored screen profile (top-level `width`/`height`).
 * Returns `{ width, height }` (rounded integers) only when BOTH are finite and
 * > 0; otherwise `null`. Never yields NaN or 0 — `null`, `undefined`, `0` and
 * a missing `bounds` all mean "size unknown" (pitfall A1).
 */
export function dimensionsOf(input) {
  if (!input || typeof input !== 'object') return null;
  const src = input.bounds && typeof input.bounds === 'object' ? input.bounds : input;
  const w = Math.round(Number(src.width));
  const h = Math.round(Number(src.height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}

/** "2560x1440" from a display's DIP bounds (used only when the name is empty). */
export function resolutionTag(display) {
  const d = dimensionsOf(display);
  return d ? `${d.width}x${d.height}` : 'unknown';
}

/**
 * Key base for an external display. macOS Chrome frequently reports
 * `name: ""` for every display, so a nameless monitor falls back to its DIP
 * resolution (`ext:2560x1440`) rather than a shared `ext:external` bucket.
 * Resolution is NOT used when a name is available.
 */
export function externalKeyBase(display) {
  const s = slug(display?.name);
  return s ? `ext:${s}` : `ext:${resolutionTag(display)}`;
}

function numericThenLexical(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Build the stable key for a display given its connected siblings.
 *  - internal → "internal"
 *  - external → "ext:<slug(name)>" (or "ext:<w>x<h>" when the name is empty),
 *    suffixed "#2", "#3", … when another connected external display has the
 *    same base (ordered by ascending display id).
 * Resolution is deliberately NOT part of the key when a name exists.
 *
 * Caveat (documented in README): two IDENTICAL monitors (same name, or both
 * nameless with the same resolution) are told apart only by id order, so
 * their profiles may swap if macOS re-numbers the displays on reconnect.
 */
export function buildKey(display, siblings = []) {
  if (isInternalDisplay(display)) return INTERNAL_KEY;
  const base = externalKeyBase(display);
  const sameBase = siblings
    .filter((d) => d && !isInternalDisplay(d) && externalKeyBase(d) === base)
    .map((d) => d.id)
    .sort(numericThenLexical);
  const idx = sameBase.indexOf(display.id);
  if (idx <= 0) return base;
  return `${base}#${idx + 1}`;
}

/**
 * Find the saved profile for a connected display.
 * Priority: lastSeenDisplayId → buildKey → internal-class match.
 * Returns `{ key, screen, needsIdUpdate }` or `null`. Pure: never mutates
 * `screens`; the caller persists `lastSeenDisplayId` when `needsIdUpdate`.
 */
export function matchSavedScreen(display, screens = {}, siblings = []) {
  const internal = isInternalDisplay(display);
  const entries = Object.entries(screens ?? {});

  const byId = entries.find(
    ([, s]) => s && s.lastSeenDisplayId === display.id && Boolean(s.isInternal) === internal,
  );
  if (byId) return { key: byId[0], screen: byId[1], needsIdUpdate: false };

  const key = buildKey(display, siblings);
  const byKey = screens?.[key];
  if (byKey) {
    return { key, screen: byKey, needsIdUpdate: byKey.lastSeenDisplayId !== display.id };
  }

  if (internal) {
    const byClass = entries.find(([, s]) => s?.isInternal);
    if (byClass) {
      return {
        key: byClass[0],
        screen: byClass[1],
        needsIdUpdate: byClass[1].lastSeenDisplayId !== display.id,
      };
    }
  }
  return null;
}

/**
 * Human-readable label for a display. macOS often reports an empty name, so
 * nameless externals are labelled by resolution ("External Display · 2560×1440").
 * Since v3 this is only used for resolution text, never as the profile name
 * (see `defaultScreenName`).
 */
export function displayLabel(display) {
  const name = String(display?.name ?? '').trim();
  if (name) return name;
  if (isInternalDisplay(display)) return 'Built-in Display';
  const tag = resolutionTag(display);
  return tag === 'unknown' ? 'External Display' : `External Display · ${tag.replace('x', '×')}`;
}

/**
 * Default (auto) name for a screen profile (doc v3 §5.1, pitfall A5).
 * Profile-driven so it also works during migration, when no live display is
 * available: `profile` only needs `isInternal` (and `key`, to exclude itself
 * from the sibling count); `display` is optional and, when it carries a
 * non-empty macOS name, that name wins.
 *
 *  - internal → "MacBook Screen"
 *  - external → "External Display", or "External Display N" where
 *    N = 1 + number of OTHER external profiles already in `screens`
 *    (so a second monitor becomes "External Display 2"). N is bumped past any
 *    name another profile already uses, so two auto-named profiles can never
 *    collide (e.g. renaming two screens back to empty, or migrating several
 *    v2 auto-labelled externals).
 */
export function defaultScreenName(profile, screens = {}, display = null) {
  const liveName = String(display?.name ?? '').trim();
  if (liveName) return liveName;
  const internal =
    typeof profile?.isInternal === 'boolean' ? profile.isInternal : isInternalDisplay(display ?? profile);
  if (internal) return DEFAULT_SCREEN_NAMES.internal;

  const others = Object.entries(screens ?? {}).filter(
    ([k, s]) => s && typeof s === 'object' && k !== profile?.key && !s.isInternal,
  );
  const taken = new Set(others.map(([, s]) => String(s.name ?? '')));
  let n = others.length + 1;
  let candidate = n === 1 ? DEFAULT_SCREEN_NAMES.external : `${DEFAULT_SCREEN_NAMES.external} ${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${DEFAULT_SCREEN_NAMES.external} ${n}`;
  }
  return candidate;
}

/**
 * Patch that brings a matched profile up to date with the connected display:
 * `lastSeenDisplayId` when the id changed and `width`/`height` when the
 * logical size differs (macOS "Looks like…" change, or a v2-migrated profile
 * whose size is still null). Returns null when nothing needs writing.
 * Used by BOTH `syncDisplays` and the per-window resolve path (pitfall C2).
 */
export function profileRefreshPatch(screen, display) {
  const patch = {};
  if (screen?.lastSeenDisplayId !== display?.id) patch.lastSeenDisplayId = display?.id ?? null;
  const d = dimensionsOf(display);
  if (d && (screen?.width !== d.width || screen?.height !== d.height)) {
    patch.width = d.width;
    patch.height = d.height;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * A fresh profile for a display (doc v3 §5.1). `existingScreens` is what the
 * auto name is numbered against. Size is `null` when Chrome reported none
 * (never NaN / 0 — see `dimensionsOf`). No `confirmed` flag in v3.
 */
export function newScreenProfile(display, key, zoomFactor, existingScreens = {}) {
  const isInternal = isInternalDisplay(display);
  const d = dimensionsOf(display);
  return {
    key,
    name: defaultScreenName({ key, isInternal }, existingScreens, display),
    isInternal,
    width: d?.width ?? null,
    height: d?.height ?? null,
    zoomFactor,
    lastSeenDisplayId: display?.id ?? null,
    createdAt: Date.now(),
  };
}

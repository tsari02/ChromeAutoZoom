// PURE: stable display keys + matching against saved profiles (doc §5.2).
import { INTERNAL_KEY } from './constants.js';

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

/** "2560x1440" from a display's DIP bounds (used only when the name is empty). */
export function resolutionTag(display) {
  const b = display?.bounds ?? {};
  const w = Math.round(Number(b.width)) || 0;
  const h = Math.round(Number(b.height)) || 0;
  return w && h ? `${w}x${h}` : 'unknown';
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
 * Human-readable name for a display. macOS often reports an empty name, so
 * nameless externals are labelled by resolution ("External Display · 2560×1440").
 */
export function displayLabel(display) {
  const name = String(display?.name ?? '').trim();
  if (name) return name;
  if (isInternalDisplay(display)) return 'Built-in Display';
  const tag = resolutionTag(display);
  return tag === 'unknown' ? 'External Display' : `External Display · ${tag.replace('x', '×')}`;
}

/** A fresh, unconfirmed profile for a display. */
export function newScreenProfile(display, key, zoomFactor) {
  return {
    key,
    name: displayLabel(display),
    isInternal: isInternalDisplay(display),
    zoomFactor,
    confirmed: false,
    lastSeenDisplayId: display.id,
  };
}

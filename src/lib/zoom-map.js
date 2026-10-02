// PURE: logical resolution → recommended zoom (engineering doc v3 §4).
// No chrome.* access. Accepts either a raw `chrome.system.display` entry
// (size under `bounds`) or a stored screen profile (top-level width/height).
import { RECOMMENDED_ZOOM } from './constants.js';
import { dimensionsOf, isInternalDisplay } from './screen-keys.js';

/**
 * "2560x1440" for a display or profile with a known logical size, else null.
 * Never "NaNxNaN" / "0x0": unknown sizes have no key (pitfall A1 / A4).
 */
export function sizeKey(input) {
  const d = dimensionsOf(input);
  return d ? `${d.width}x${d.height}` : null;
}

/** True for a well-formed, positive "WxH" key (what learnedDefaults may contain). */
export function isSizeKey(key) {
  const m = /^(\d+)x(\d+)$/.exec(String(key ?? ''));
  return Boolean(m) && Number(m[1]) > 0 && Number(m[2]) > 0;
}

/**
 * Recommended zoom for a display / profile, with user-taught overrides.
 *  1. internal panel (flag OR built-in name heuristic) → 1.0, never learned
 *  2. unknown / invalid size → external fallback (125%) — NOT the ≤1920 rule
 *     (`null <= 1920` is true in JS; pitfall A1)
 *  3. learned override for this exact size
 *  4. exact-size table
 *  5. ≤ 1920×1200 → 1.0
 *  6. everything else → 1.25
 */
export function recommendedZoom(input, learned = {}) {
  if (isInternalDisplay(input)) return RECOMMENDED_ZOOM.internal;
  const d = dimensionsOf(input);
  if (!d) return RECOMMENDED_ZOOM.externalFallback;
  const key = `${d.width}x${d.height}`;
  const taught = Number(learned?.[key]);
  if (Number.isFinite(taught) && taught > 0) return taught;
  if (Object.hasOwn(RECOMMENDED_ZOOM.bySize, key)) return RECOMMENDED_ZOOM.bySize[key];
  const max = RECOMMENDED_ZOOM.smallExternalMax;
  if (d.width <= max.width && d.height <= max.height) return 1.0;
  return RECOMMENDED_ZOOM.externalFallback;
}

/**
 * Next learnedDefaults record with `key → factor` taught. Refuses malformed
 * keys (no positive dimensions) and non-positive factors by returning the
 * input unchanged, so "0x0" / "NaNxNaN" can never be written (pitfall A4).
 */
export function withLearnedDefault(learned, key, factor) {
  const f = Number(factor);
  if (!isSizeKey(key) || !Number.isFinite(f) || f <= 0) return learned ?? {};
  return { ...(learned ?? {}), [key]: f };
}

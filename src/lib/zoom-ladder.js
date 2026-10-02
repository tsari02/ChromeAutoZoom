// PURE: zoom-ladder step math (engineering doc §5.1). No chrome.* access.
import { ZOOM_LADDER, ZOOM_EPSILON, STEP_100 } from './constants.js';

export { ZOOM_LADDER, STEP_100 };

const LAST = ZOOM_LADDER.length - 1;

/** Clamp a step index into the valid ladder range. */
export function clampStep(index) {
  if (!Number.isFinite(index)) return STEP_100;
  return Math.min(LAST, Math.max(0, Math.round(index)));
}

/**
 * Nearest ladder index by absolute difference. Always returns a valid index,
 * so an arbitrary pre-install factor like 1.33 maps deterministically (to 1.25).
 * Ties resolve to the lower index.
 */
export function nearestStepIndex(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return STEP_100;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ZOOM_LADDER.length; i++) {
    const diff = Math.abs(ZOOM_LADDER[i] - factor);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/** Zoom factor at a (clamped) step index. */
export function factorAtStep(index) {
  return ZOOM_LADDER[clampStep(index)];
}

/** True when two factors are the same zoom within ε (0.005). */
export function isSameZoom(a, b) {
  return Math.abs(a - b) < ZOOM_EPSILON;
}

/** True when `factor` sits (within ε) on a ladder rung. */
export function isLadderValue(factor) {
  return ZOOM_LADDER.some((f) => isSameZoom(f, factor));
}

/**
 * The zoom AutoZoom expects for a tab: the screen's ladder rung shifted by the
 * site's relative step delta, clamped to the ladder.
 */
export function expectedZoom(screenZoom, delta = 0) {
  return factorAtStep(nearestStepIndex(screenZoom) + (delta | 0));
}

/** Step delta between an observed factor and the screen's zoom. */
export function stepDelta(observedFactor, screenZoom) {
  return nearestStepIndex(observedFactor) - nearestStepIndex(screenZoom);
}

/** "1.25" → "125%". */
export function formatPercent(factor) {
  return `${Math.round(factor * 100)}%`;
}

/** "+1 step" / "−2 steps" / "" for 0. */
export function formatDelta(delta) {
  if (!delta) return '';
  const sign = delta > 0 ? '+' : '−';
  const n = Math.abs(delta);
  return `${sign}${n} step${n === 1 ? '' : 's'}`;
}

// PURE: window → display resolution (engineering doc §5.3). No chrome.* access.

function hasCoords(win) {
  return ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(win?.[k]));
}

/** Center point of a window rect. */
export function windowCenter(win) {
  return { x: win.left + win.width / 2, y: win.top + win.height / 2 };
}

/** True when `pt` lies inside `bounds` (half-open on the far edges). */
export function containsPoint(bounds, pt) {
  return (
    pt.x >= bounds.left &&
    pt.x < bounds.left + bounds.width &&
    pt.y >= bounds.top &&
    pt.y < bounds.top + bounds.height
  );
}

/** Area of the intersection of two rects (0 when disjoint). */
export function intersectionArea(a, b) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Euclidean distance from a point to the nearest point of a rect (0 if inside). */
export function distanceToRect(pt, r) {
  const dx = Math.max(r.left - pt.x, 0, pt.x - (r.left + r.width));
  const dy = Math.max(r.top - pt.y, 0, pt.y - (r.top + r.height));
  return Math.hypot(dx, dy);
}

/**
 * Resolve which display a window is on.
 *
 * Returns `null` for minimized windows or windows without coordinates — the
 * caller keeps the last known screen and must never snap to the primary.
 *
 * Otherwise returns `{ display, confidence }` where confidence is
 * `'center'` (display contains the window center), `'overlap'` (largest
 * positive intersection) or `'nearest'` (closest display by center-to-rect
 * distance; happens with stale bounds right after an unplug).
 */
export function resolveDisplay(win, displays) {
  if (!win || win.state === 'minimized' || !hasCoords(win)) return null;
  if (!Array.isArray(displays) || displays.length === 0) return null;

  const center = windowCenter(win);

  const byCenter = displays.find((d) => d?.bounds && containsPoint(d.bounds, center));
  if (byCenter) return { display: byCenter, confidence: 'center' };

  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    if (!d?.bounds) continue;
    const area = intersectionArea(win, d.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  if (best) return { display: best, confidence: 'overlap' };

  let nearest = null;
  let nearestDist = Infinity;
  for (const d of displays) {
    if (!d?.bounds) continue;
    const dist = distanceToRect(center, d.bounds);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = d;
    }
  }
  return nearest ? { display: nearest, confidence: 'nearest' } : null;
}

/**
 * Centered placement for a popup of `width`×`height` within `bounds`
 * (uses workArea when provided so the window avoids the Dock/menu bar).
 */
export function centeredRect(bounds, width, height) {
  const w = Math.min(width, bounds.width);
  const h = Math.min(height, bounds.height);
  return {
    left: Math.round(bounds.left + (bounds.width - w) / 2),
    top: Math.round(bounds.top + (bounds.height - h) / 2),
    width: w,
    height: h,
  };
}

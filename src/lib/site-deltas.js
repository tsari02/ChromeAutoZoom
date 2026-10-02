// PURE: per-(host, screen) site step deltas with inheritance (engineering doc
// v3 §5.2). No chrome.* access.
//
// Shape: siteStepDeltas[host][screenKey] = { delta: int, updatedAt: ms }.
// An explicit row (0 included) always wins for its screen; a screen without a
// row inherits from the closest other screen that has one.

/** Logical area of a profile, or null when its size is unknown (v2-migrated). */
function screenArea(screen) {
  const w = Number(screen?.width);
  const h = Number(screen?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w * h : null;
}

/** |Δ area| in logical px²; unknown sizes sort last (Infinity) so recency decides among them. */
export function areaGap(a, b) {
  const x = screenArea(a);
  const y = screenArea(b);
  return x == null || y == null ? Number.POSITIVE_INFINITY : Math.abs(x - y);
}

function isRow(row) {
  return Boolean(row) && typeof row === 'object' && Number.isInteger(row.delta);
}

const NO_DELTA = Object.freeze({ delta: 0, source: null, inherited: false });

/**
 * Inheritance order (decision 2.2 + pitfall C3):
 *  1. same display class (internal ↔ internal, external ↔ external)
 *  2. smallest |Δ logical area| (unknown sizes last)
 *  3. most recently adjusted row (`updatedAt` desc)
 *  4. older profile first (`createdAt` asc)              ┐ deterministic final
 *  5. screen key, lexical                                ┘ tiebreakers
 * Steps 4–5 matter after a v2→v3 migration, where every fanned-out row shares
 * one `updatedAt`; without them the winner would depend on insertion order.
 */
function compareCandidates(me, a, b) {
  const ga = areaGap(me, a.screen);
  const gb = areaGap(me, b.screen);
  if (ga !== gb) return ga < gb ? -1 : 1; // (Infinity === Infinity → fall through)
  const ua = Number(a.row.updatedAt) || 0;
  const ub = Number(b.row.updatedAt) || 0;
  if (ua !== ub) return ub - ua;
  const ca = Number(a.screen.createdAt) || 0;
  const cb = Number(b.screen.createdAt) || 0;
  if (ca !== cb) return ca - cb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Effective delta for `host` on `screenKey`.
 * Returns { delta, source, inherited }: `source` is the screen key the delta
 * came from (null when 0 by default), `inherited` is true when it was borrowed
 * from another screen.
 */
export function resolveDelta(host, screenKey, state) {
  const rows = state?.siteStepDeltas?.[host];
  if (!rows || typeof rows !== 'object') return { ...NO_DELTA };
  const own = rows[screenKey];
  if (isRow(own)) return { delta: own.delta, source: screenKey, inherited: false };

  const screens = state?.screens ?? {};
  const me = screens[screenKey];
  const candidates = Object.entries(rows)
    .filter(([k, row]) => k !== screenKey && isRow(row) && screens[k] && typeof screens[k] === 'object')
    .map(([k, row]) => ({ key: k, row, screen: screens[k] }));
  if (!candidates.length) return { ...NO_DELTA };

  const myClass = Boolean(me?.isInternal);
  const sameClass = candidates.filter((c) => Boolean(c.screen.isInternal) === myClass);
  const pool = sameClass.length ? sameClass : candidates;
  pool.sort((a, b) => compareCandidates(me, a, b));
  return { delta: pool[0].row.delta, source: pool[0].key, inherited: true };
}

/** Remove `host` entirely when every one of its rows is 0 (nothing left to inherit). */
export function pruneHost(siteStepDeltas, host) {
  const all = siteStepDeltas ?? {};
  const rows = all[host];
  if (!rows || typeof rows !== 'object') return all;
  const live = Object.values(rows).some((r) => isRow(r) && r.delta !== 0);
  if (live) return all;
  const next = { ...all };
  delete next[host];
  return next;
}

/**
 * Next siteStepDeltas record with an explicit row written for (host, screen).
 * 0 is allowed and persisted — it is what blocks inheritance on that screen —
 * unless every row of the host is now 0, in which case the host is pruned.
 */
export function withDelta(siteStepDeltas, host, screenKey, delta, now = Date.now()) {
  const all = siteStepDeltas ?? {};
  const rows = { ...(all[host] ?? {}), [screenKey]: { delta: Math.trunc(Number(delta)) || 0, updatedAt: now } };
  return pruneHost({ ...all, [host]: rows }, host);
}

/** Next siteStepDeltas record without `host` (exclude / clear). Returns a copy. */
export function withoutHost(siteStepDeltas, host) {
  const all = siteStepDeltas ?? {};
  if (!(host in all)) return all;
  const next = { ...all };
  delete next[host];
  return next;
}

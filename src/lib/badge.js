// Toolbar badge (engineering doc §5.8). Tab-scoped text so it follows the tab.
import { BADGE } from './constants.js';
import { expectedZoom, formatPercent, formatDelta } from './zoom-ladder.js';
import { resolveDelta } from './site-deltas.js';
import { isManageable, safeCall } from './tab-zoom.js';
import { hostOf, prettyHost } from './url-rules.js';

async function paint(tabId, { text, color, title }) {
  if (!chrome.action) return;
  await safeCall(() => chrome.action.setBadgeText({ tabId, text }), 'setBadgeText');
  if (color) {
    await safeCall(() => chrome.action.setBadgeBackgroundColor({ tabId, color }), 'setBadgeBackgroundColor');
  }
  await safeCall(() => chrome.action.setTitle({ tabId, title }), 'setTitle');
}

/**
 * Compute what the badge should show for a tab given the current state and
 * the screen the tab's window is on. Pure; exported for tests.
 */
export function describe(tab, screen, state) {
  if (!state?.enabled) {
    return { text: BADGE.off.text, color: BADGE.off.color, title: 'AutoZoom is paused' };
  }
  if (!isManageable(tab)) {
    return { text: '', title: 'AutoZoom — not available on this page' };
  }
  const host = hostOf(tab.url);
  if (state.excludedHosts?.[host]) {
    // No badge text for excluded sites (1.1.0 polish, D25) — the hover title
    // and the popup's amber "Excluded" pill carry the information.
    return { text: '', title: `AutoZoom — ${prettyHost(host)} is excluded (Chrome's own zoom applies)` };
  }
  if (!screen) {
    return { text: '', title: 'AutoZoom — screen not resolved yet' };
  }
  const { delta, source, inherited } = resolveDelta(host, screen.key, state);
  const zoom = expectedZoom(screen.zoomFactor, delta);
  const pct = Math.round(zoom * 100);
  const parts = [screen.name, formatPercent(zoom)];
  if (delta) {
    let detail = `${formatDelta(delta)} for ${prettyHost(host)}`;
    const from = inherited ? state.screens?.[source]?.name : null;
    if (from) detail += ` (inherited from ${from})`;
    parts.push(detail);
  }
  return {
    text: pct === 100 && !delta ? '' : String(pct),
    color: BADGE.zoom.color,
    title: `AutoZoom · ${parts.join(' · ')}`,
  };
}

/** Paint the badge for a tab. */
export async function update(tab, screen, state) {
  if (!tab || !Number.isInteger(tab.id)) return;
  await paint(tab.id, describe(tab, screen, state));
}

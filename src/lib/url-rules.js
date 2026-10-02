// PURE: URL filtering (FR-9) and host extraction (doc §4). No chrome.* access.
import { ZOOMABLE_PROTOCOLS, WEBSTORE_HOSTS } from './constants.js';

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True for pages Chrome lets extensions zoom: http(s) and file URLs, except
 * the Chrome Web Store. Everything else (chrome://, chrome-extension://,
 * devtools://, about:, edge://, view-source:, data:, blob:…) is rejected.
 */
export function isZoomableUrl(url) {
  const u = typeof url === 'string' ? parse(url) : null;
  if (!u) return false;
  if (!ZOOMABLE_PROTOCOLS.includes(u.protocol)) return false;
  if (WEBSTORE_HOSTS.includes(u.hostname)) return false;
  return true;
}

/**
 * Hostname used as the key for site deltas / exclusions. Lower-cased, port
 * stripped (mirrors Chrome's own per-host zoom memory). `file:` URLs map to
 * the pseudo-host "file". Returns '' when unparsable.
 */
export function hostOf(url) {
  const u = typeof url === 'string' ? parse(url) : null;
  if (!u) return '';
  if (u.protocol === 'file:') return 'file';
  return u.hostname.toLowerCase();
}

/** Display form of a host: strips a leading "www.". */
export function prettyHost(host) {
  return String(host ?? '').replace(/^www\./, '');
}

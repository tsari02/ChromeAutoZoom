// Per-window single-flight coalescing + debounce (engineering doc §6).
//
// Both maps are caches: losing them on a service-worker restart costs at most
// one missed debounce, recovered by the next focus/activate event.
// setTimeout is deliberate — chrome.alarms has a 30 s minimum and the SW is
// alive during the event burst that created the timer.
import { TIMINGS } from '../lib/constants.js';
import { syncWindow } from '../lib/zoom-engine.js';

const inflight = new Map(); // windowId → { dirty: string|null }
const timers = new Map(); // windowId → timeoutId

async function run(windowId, reason) {
  const slot = inflight.get(windowId);
  if (slot) {
    slot.dirty = reason; // one trailing re-run max, with the latest reason
    return;
  }
  const s = { dirty: null };
  inflight.set(windowId, s);
  try {
    await syncWindow(windowId, { reason });
  } catch (err) {
    console.warn('[AutoZoom] syncWindow failed:', err?.message ?? err);
  } finally {
    inflight.delete(windowId);
  }
  if (s.dirty) run(windowId, s.dirty);
}

/**
 * Request a sync for a window. 'bounds' is debounced (150 ms); every other
 * reason runs immediately but is coalesced with any in-flight sync.
 */
export function request(windowId, reason = 'manual') {
  if (!Number.isInteger(windowId) || windowId < 0) return;
  if (reason === 'bounds') {
    clearTimeout(timers.get(windowId));
    timers.set(
      windowId,
      setTimeout(() => {
        timers.delete(windowId);
        run(windowId, reason);
      }, TIMINGS.boundsDebounceMs),
    );
    return;
  }
  run(windowId, reason);
}

/** Drop any pending debounce for a closed window. */
export function forget(windowId) {
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
}

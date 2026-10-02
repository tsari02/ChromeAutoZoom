// system.display.getInfo with an in-memory cache (engineering doc §5.4).
// This is a *cache*, not state: if the service worker restarts it is simply
// refetched on the next call. Invalidated by system.display.onDisplayChanged.

let cache = null;
let pending = null;

export async function getDisplays() {
  if (cache) return cache;
  if (!pending) {
    pending = (async () => {
      try {
        const displays = await chrome.system.display.getInfo();
        cache = Array.isArray(displays) ? displays : [];
        return cache;
      } finally {
        pending = null;
      }
    })();
  }
  return pending;
}

export function invalidate() {
  cache = null;
}

/** Look up one cached display by id (refetches if the cache is cold). */
export async function getDisplayById(id) {
  const displays = await getDisplays();
  return displays.find((d) => d.id === id) ?? null;
}

// Boots the real service-worker.js under the chrome mock and drives the
// install → onboarding → confirm → events flow end-to-end. Guards against
// wiring errors that unit tests of individual modules would miss.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_2,
  windowOn,
} from './_chrome-mock.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import * as storage from '../src/lib/storage.js';
import { MSG, SETUP_MODE } from '../src/lib/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The service worker registers listeners on whatever `chrome` is at import
// time, so install the mock first, then import it once. Later tests reuse the
// same mock object and reset its world through the helpers.
const mock = installChromeMock({
  displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
  windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
  tabs: [
    { id: 22, windowId: 2, url: 'https://example.com/', active: true },
    { id: 23, windowId: 2, url: 'https://example.org/', active: false },
    { id: 11, windowId: 1, url: 'https://example.com/', active: true },
  ],
});
invalidateDisplays();
await import('../src/background/service-worker.js');
const { chrome } = mock;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.emit(message, { id: 'mock' }, resolve);
  });
}

describe('service-worker boot (install → onboarding → confirm → events)', () => {
  beforeEach(() => {
    globalThis.chrome = chrome; // other suites swap the global; the SW's listeners live on this one
    invalidateDisplays();
  });

  test('all top-level listeners are registered synchronously', () => {
    assert.equal(chrome.runtime.onInstalled.size, 1);
    assert.equal(chrome.runtime.onStartup.size, 1);
    assert.equal(chrome.runtime.onMessage.size, 1);
    assert.equal(chrome.system.display.onDisplayChanged.size, 1);
    assert.equal(chrome.windows.onBoundsChanged.size, 1);
    assert.equal(chrome.windows.onFocusChanged.size, 1);
    assert.equal(chrome.windows.onRemoved.size, 1);
    assert.equal(chrome.tabs.onActivated.size, 1);
    assert.equal(chrome.tabs.onUpdated.size, 1);
    assert.equal(chrome.tabs.onRemoved.size, 1);
    assert.equal(chrome.tabs.onZoomChange.size, 1);
  });

  test('fresh install opens exactly one onboarding window and zooms nothing', async () => {
    await chrome.runtime.onInstalled.emit({ reason: 'install' });
    await sleep(20);
    const creates = mock.callsTo('windows.create');
    assert.equal(creates.length, 1);
    assert.match(creates[0].args[0].url, /setup\.html\?mode=onboarding$/);
    assert.equal(creates[0].args[0].type, 'popup');
    assert.equal(creates[0].args[0].width, 420);
    assert.equal(creates[0].args[0].height, 180 + 64 * 2);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, false);
    assert.deepEqual(Object.keys(st.screens).sort(), ['ext:lg-ultrafine', 'internal']);
    assert.equal(st.screens['ext:lg-ultrafine'].confirmed, false);
  });

  test('onboarding lists every connected display; Apply closes it, completes onboarding and normalizes', async () => {
    const data = await send({ type: MSG.GET_SETUP_DATA, mode: SETUP_MODE.ONBOARDING });
    assert.equal(data.ok, true);
    assert.deepEqual(data.result.rows.map((r) => r.key), ['internal', 'ext:lg-ultrafine']);
    assert.deepEqual(data.result.rows.map((r) => r.zoomFactor), [1.0, 1.25]);

    const { setupWindowId } = await storage.getSession();
    assert.ok(Number.isInteger(setupWindowId));

    const res = await send({ type: MSG.CONFIRM_SETUP, screens: { internal: 1.0, 'ext:lg-ultrafine': 1.25 } });
    assert.equal(res.ok, true);
    assert.equal((await storage.getState()).onboardingCompleted, true);
    assert.equal(mock.callsTo('windows.remove').at(-1)?.args[0], setupWindowId, 'setup window closed by the SW');
    assert.equal((await storage.getSession()).setupWindowId, null);

    await sleep(80); // background normalization
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(23), 1.25);
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.scopeOf(11), 'per-tab');
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
  });

  test('Cmd + on a managed tab writes exactly one delta; Cmd − removes it', async () => {
    await mock.userZoom(22, 1.5);
    await sleep(10);
    assert.deepEqual((await storage.getState()).siteStepDeltas, { 'example.com': 1 });
    assert.equal(mock.zoomOf(11), 1.0, 'sibling tab in the other window is untouched');
    await mock.userZoom(22, 1.25);
    await sleep(10);
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
  });

  test('tabs.onActivated lazily manages a background tab; cross-origin navigation re-manages without a delta', async () => {
    mock.tab(23).active = true;
    mock.tab(22).active = false;
    await chrome.tabs.onActivated.emit({ tabId: 23, windowId: 2 });
    await sleep(10);
    assert.equal(mock.scopeOf(23), 'per-tab');
    assert.equal(mock.zoomOf(23), 1.25);

    await mock.navigate(23, 'https://totally-different.net/');
    await sleep(10);
    assert.equal(mock.scopeOf(23), 'per-tab');
    assert.equal(mock.zoomOf(23), 1.25);
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
    mock.tab(22).active = true;
    mock.tab(23).active = false;
  });

  test('windows.onBoundsChanged (debounced) applies the new screen zoom when a window is dragged', async () => {
    const b = DISPLAY_INTERNAL.bounds;
    mock.moveWindow(2, { left: b.left + 20, top: b.top + 20 });
    for (let i = 0; i < 5; i++) await chrome.windows.onBoundsChanged.emit({ id: 2 });
    await sleep(220);
    assert.equal(mock.zoomOf(22), 1.0);
    assert.equal(await storage.getWindowScreen(2), 'internal');
    // Drag back.
    const e = DISPLAY_EXTERNAL.bounds;
    mock.moveWindow(2, { left: e.left + 100, top: e.top + 100 });
    await chrome.windows.onBoundsChanged.emit({ id: 2 });
    await sleep(220);
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('minimizing a window produces no setZoom for its tabs', async () => {
    mock.state.windows.get(2).state = 'minimized';
    mock.resetCalls();
    await chrome.windows.onFocusChanged.emit(2);
    await chrome.windows.onBoundsChanged.emit({ id: 2 });
    await sleep(220);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    assert.equal(await storage.getWindowScreen(2), 'ext:lg-ultrafine');
    mock.state.windows.get(2).state = 'normal';
  });

  test('system.display.onDisplayChanged: new monitor → profile + one new-display prompt on that display', async () => {
    mock.resetCalls();
    mock.setDisplays([DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2]);
    for (let i = 0; i < 3; i++) await chrome.system.display.onDisplayChanged.emit();
    await sleep(600);
    const creates = mock.callsTo('windows.create');
    assert.equal(creates.length, 1, 'macOS fires several events; only one prompt opens');
    assert.match(creates[0].args[0].url, /mode=new-display&key=ext%3Adell-u2723qe/);
    const st = await storage.getState();
    assert.equal(st.screens['ext:dell-u2723qe'].confirmed, false);

    // Closing the prompt without confirming accepts the default and clears dedupe state.
    const { setupWindowId } = await storage.getSession();
    await chrome.windows.remove(setupWindowId);
    await sleep(10);
    const after = await storage.getState();
    assert.equal(after.screens['ext:dell-u2723qe'].confirmed, true);
    assert.equal(after.screens['ext:dell-u2723qe'].zoomFactor, 1.25);
    assert.equal((await storage.getSession()).setupWindowId, null);
    assert.deepEqual((await storage.getSession()).pendingSetupKeys, []);
    await sleep(1600); // let the delayed re-sync timer fire and settle
  });

  test('Pause releases every managed tab to per-origin; Resume returns active tabs to per-tab', async () => {
    const res = await send({ type: MSG.SET_ENABLED, enabled: false });
    assert.equal(res.ok, true);
    for (const id of [11, 22, 23]) assert.equal(mock.scopeOf(id), 'per-origin');
    assert.equal(mock.hostZoom.size, 0);
    const on = await send({ type: MSG.SET_ENABLED, enabled: true });
    assert.equal(on.ok, true);
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.scopeOf(11), 'per-tab');
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('windows.onRemoved cleans the session map; onStartup / onInstalled(update) re-sync without errors', async () => {
    await chrome.windows.onRemoved.emit(1);
    assert.equal(await storage.getWindowScreen(1), null);
    await chrome.runtime.onStartup.emit();
    await chrome.runtime.onInstalled.emit({ reason: 'update', previousVersion: '0.9.0' });
    await sleep(20);
    assert.equal((await storage.getState()).schemaVersion, 2);
  });
});

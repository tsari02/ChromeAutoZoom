// Boots the real service-worker.js under the chrome mock and drives the
// install → first-run popup → Accept → events flow end-to-end. Guards against
// wiring errors that unit tests of individual modules would miss, and covers
// the v3 §6 / §10 service-worker scenarios plus the B1 regression.
import { test, describe, beforeEach, mock as nodeMock } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_4K,
  windowOn,
} from './_chrome-mock.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import * as storage from '../src/lib/storage.js';
import { MSG } from '../src/lib/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = 'ext:lg-ultrafine';
const INT = 'internal';
const K4 = 'ext:lg-hdr-4k';

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
// Chrome's "extension added" bubble is up when onInstalled fires: openPopup rejects.
mock.failOpenPopup('Could not find an active browser window.');
invalidateDisplays();
await import('../src/background/service-worker.js');
const { chrome } = mock;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.emit(message, { id: 'mock' }, resolve);
  });
}
const openPopupCalls = () => mock.callsTo('action.openPopup').length;

describe('service-worker boot (install → first-run popup → Accept → events)', () => {
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

  test('install → chrome.action.openPopup called once; rejection swallowed; nothing zoomed; profiles seeded from the map', async () => {
    await chrome.runtime.onInstalled.emit({ reason: 'install' });
    await sleep(20);
    assert.equal(openPopupCalls(), 1, 'exactly one openPopup attempt');
    assert.equal(mock.callsTo('windows.create').length, 0, 'no setup window');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'nothing zoomed before Accept');
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, false);
    assert.equal(st.schemaVersion, 3);
    assert.deepEqual(Object.keys(st.screens).sort(), [EXT, INT]);
    assert.equal(st.screens[EXT].zoomFactor, 1.25, '2560×1440 → 125%');
    assert.equal(st.screens[INT].zoomFactor, 1.0);
    assert.deepEqual([st.screens[EXT].width, st.screens[EXT].height], [2560, 1440]);
    assert.ok(!('confirmed' in st.screens[EXT]));
    assert.deepEqual(st.learnedDefaults, {});
  });

  test('REGRESSION B1: next windows.onFocusChanged retries openPopup exactly once (WINDOW_ID_NONE ignored; further focus → no more calls)', async () => {
    assert.equal(openPopupCalls(), 1);
    await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
    await sleep(10);
    assert.equal(openPopupCalls(), 1, 'WINDOW_ID_NONE is not a focus');

    await chrome.windows.onFocusChanged.emit(2);
    await sleep(10);
    assert.equal(openPopupCalls(), 2, 'one retry on the next real focus change');

    for (const id of [1, 2, 1]) await chrome.windows.onFocusChanged.emit(id);
    await sleep(10);
    assert.equal(openPopupCalls(), 2, 'never more than one retry per worker lifetime');
    assert.equal((await storage.getState()).onboardingCompleted, false);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'focus syncs zoom nothing before Accept');
  });

  test('GET_POPUP_STATE in first run lists connected displays with map values; CONFIRM_SETUP applies, completes onboarding and normalizes every tab', async () => {
    mock.allowOpenPopup();
    const data = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(data.ok, true, data.error);
    assert.equal(data.result.onboardingCompleted, false);
    assert.deepEqual(data.result.firstRun.rows.map((r) => r.key), [INT, EXT]);
    assert.deepEqual(data.result.firstRun.rows.map((r) => r.recommended), [1.0, 1.25]);
    assert.deepEqual(data.result.firstRun.rows.map((r) => `${r.width}×${r.height}`), ['1512×982', '2560×1440']);

    const res = await send({ type: MSG.CONFIRM_SETUP, screens: { [INT]: 1.0, [EXT]: 1.25 } });
    assert.equal(res.ok, true);
    assert.equal((await storage.getState()).onboardingCompleted, true);
    assert.equal(mock.callsTo('windows.remove').length, 0, 'no setup window to close');

    await sleep(80); // background normalization
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(23), 1.25, 'background tab too');
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.scopeOf(23), 'per-tab');
    assert.equal(mock.scopeOf(11), 'per-tab');
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
    assert.deepEqual((await storage.getState()).learnedDefaults, {}, 'recommended values accepted → nothing learned');
    assert.equal((await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 })).result.firstRun, undefined);
  });

  test('Cmd + on a managed tab writes exactly one per-screen delta row; Cmd − back writes 0 and prunes the host', async () => {
    await mock.userZoom(22, 1.5);
    await sleep(10);
    const rows = (await storage.getState()).siteStepDeltas;
    assert.deepEqual(Object.keys(rows), ['example.com']);
    assert.deepEqual(Object.keys(rows['example.com']), [EXT], 'a row for the external screen only');
    assert.equal(rows['example.com'][EXT].delta, 1);
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
    assert.equal(await storage.getWindowScreen(2), INT);
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
    assert.equal(await storage.getWindowScreen(2), EXT);
    mock.state.windows.get(2).state = 'normal';
  });

  test('system.display.onDisplayChanged: new monitor → profile seeded from the map, every tab on it zoomed in pass 1 and normalized again in pass 2, no prompt', async () => {
    // macOS already placed a window (with a background tab) on the new 4K monitor.
    mock.addWindow(windowOn(DISPLAY_EXTERNAL_4K, 4));
    mock.addTab({ id: 41, windowId: 4, url: 'https://a.example.com/', active: true });
    mock.addTab({ id: 42, windowId: 4, url: 'https://b.example.com/', active: false });
    mock.resetCalls();
    mock.setDisplays([DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K]);
    for (let i = 0; i < 3; i++) await chrome.system.display.onDisplayChanged.emit();
    await sleep(600); // debounce (500 ms) + pass 1

    const st = await storage.getState();
    assert.equal(st.screens[K4].zoomFactor, 1.5, 'seeded from the map (3840×2160 → 150%)');
    assert.equal(st.screens[K4].name, 'LG HDR 4K');
    assert.deepEqual([st.screens[K4].width, st.screens[K4].height], [3840, 2160]);
    assert.equal(mock.zoomOf(41), 1.5, 'active tab');
    assert.equal(mock.zoomOf(42), 1.5, 'background tab — whole-screen normalization in pass 1');
    assert.equal(mock.scopeOf(42), 'per-tab');
    assert.equal(mock.callsTo('windows.create').length, 0, 'macOS fires several events; no prompt window ever');
    assert.equal(openPopupCalls(), 0, 'no popup either');
    assert.equal(mock.callsTo('tabs.setZoom').filter((c) => c.args[0] === 42).length, 1, 'one pass, no normalization storm');
    assert.equal(mock.zoomOf(22), 1.25, 'other screens untouched');

    // Between the passes macOS relocates another window onto the new monitor.
    mock.addWindow(windowOn(DISPLAY_EXTERNAL_4K, 5));
    mock.addTab({ id: 51, windowId: 5, url: 'https://c.example.com/', active: true });
    mock.addTab({ id: 52, windowId: 5, url: 'https://d.example.com/', active: false });
    await sleep(1600); // delayed pass (+1500 ms)
    assert.equal(mock.zoomOf(51), 1.5, 'active tab of the relocated window (resyncAllWindows)');
    assert.equal(mock.zoomOf(52), 1.5, 'its background tab too — normalizeScreen ran again in pass 2');
    assert.equal(mock.callsTo('tabs.setZoom').filter((c) => c.args[0] === 42).length, 1, 'already-correct tabs are not re-set');
    assert.equal(openPopupCalls(), 0);
    assert.equal(mock.callsTo('windows.create').length, 0);
  });

  test('Pause (SET_ENABLED false) freezes every tab in place with zero zoom calls; Resume (SET_ENABLED true) re-applies every tab on every screen', async () => {
    mock.resetCalls();
    const res = await send({ type: MSG.SET_ENABLED, enabled: false });
    assert.equal(res.ok, true);
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0, 'nothing released');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'nothing re-zoomed');
    for (const id of [11, 22, 23, 41, 42]) assert.equal(mock.scopeOf(id), 'per-tab', `tab ${id} keeps per-tab scope`);
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(42), 1.5);
    assert.ok(mock.callsTo('action.setBadgeText').some((c) => c.args[0].text === 'OFF'), 'badge shows OFF');
    assert.equal(mock.hostZoom.size, 0);

    // While paused: a manual zoom on a background tab is neither recorded nor undone.
    await mock.userZoom(23, 1.75);
    await mock.userZoom(42, 1.0);
    await sleep(10);
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
    assert.equal(mock.zoomOf(23), 1.75);

    mock.resetCalls();
    const on = await send({ type: MSG.SET_ENABLED, enabled: true });
    assert.equal(on.ok, true);
    assert.equal(mock.zoomOf(23), 1.25, 'background tab on the LG re-applied immediately');
    assert.equal(mock.zoomOf(42), 1.5, 'background tab on the 4K re-applied immediately');
    assert.deepEqual(mock.callsTo('tabs.setZoom').map((c) => c.args[0]).sort(), [23, 42], 'exactly the drifted tabs were set');
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(11), 1.0);
    for (const id of [11, 22, 23, 41, 42]) assert.equal(mock.scopeOf(id), 'per-tab');
  });

  test('RELEASE_ALL (Restore Chrome\'s zoom) is the only path that hands tabs back: every managed tab → per-origin, enabled=false', async () => {
    mock.resetCalls();
    const res = await send({ type: MSG.RELEASE_ALL });
    assert.equal(res.ok, true);
    assert.equal(res.result.enabled, false);
    const releases = mock.callsTo('tabs.setZoomSettings').filter((c) => c.args[1].scope === 'per-origin');
    assert.ok(releases.length >= 1);
    for (const id of [11, 22, 23, 41, 42, 51, 52]) {
      assert.equal(mock.scopeOf(id), 'per-origin', `tab ${id} released`);
      assert.equal(mock.zoomOf(id), 1.0);
    }
    assert.equal(mock.hostZoom.size, 0, 'Chrome\'s per-origin memory never written');
    assert.equal((await storage.getState()).enabled, false);
    // Turn it back on for the remaining tests.
    await send({ type: MSG.SET_ENABLED, enabled: true });
    assert.equal(mock.scopeOf(22), 'per-tab');
  });

  test('RENAME_SCREEN through the SW updates the profile and the hover title of that screen\'s active tab', async () => {
    mock.resetCalls();
    const res = await send({ type: MSG.RENAME_SCREEN, key: K4, name: 'Desk 4K' });
    assert.equal(res.ok, true);
    assert.equal((await storage.getState()).screens[K4].name, 'Desk 4K');
    const titles = mock.callsTo('action.setTitle').map((c) => c.args[0]);
    assert.ok(titles.some((t) => [41, 51].includes(t.tabId) && /Desk 4K · 150%/.test(t.title)));
    assert.ok(!titles.some((t) => t.tabId === 22), 'other screens\' tabs untouched');
  });

  test('windows.onRemoved cleans the session map; onStartup re-syncs; onInstalled(update) with onboardingCompleted=false → openPopup', async () => {
    await chrome.windows.onRemoved.emit(1);
    assert.equal(await storage.getWindowScreen(1), null);
    await chrome.runtime.onStartup.emit();
    await sleep(20);
    assert.equal((await storage.getState()).schemaVersion, 3);

    // An update for a v2 user who never finished setup: migrate, then the first-run popup.
    await chrome.storage.local.set({ onboardingCompleted: false });
    mock.resetCalls();
    await chrome.runtime.onInstalled.emit({ reason: 'update', previousVersion: '1.0.0' });
    await sleep(20);
    assert.equal(openPopupCalls(), 1, 'openPopup after update while unaccepted');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'nothing zoomed while unaccepted');
    assert.equal((await storage.getState()).schemaVersion, 3);

    // …and not when onboarding is already accepted.
    await send({ type: MSG.CONFIRM_SETUP, screens: { [INT]: 1.0, [EXT]: 1.25, [K4]: 1.5 } });
    await sleep(80);
    mock.resetCalls();
    await chrome.runtime.onInstalled.emit({ reason: 'update', previousVersion: '1.1.0' });
    await sleep(20);
    assert.equal(openPopupCalls(), 0, 'no popup once accepted');
  });
});

// The shared worker above has already spent its one retry, so the remaining B1
// branch needs a fresh instance: a query string gives Node a separate module
// (fresh `popupRetryArmed` / `popupRetryUsed`) whose listeners bind to a fresh
// mock world. Library modules stay shared; they read `globalThis.chrome` lazily.
describe('service-worker — REGRESSION B1: the armed retry is skipped once onboarding is accepted', () => {
  test('install rejection is logged; Accept before the next focus → no retry on any later focus', async () => {
    const world = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 11, windowId: 1, url: 'https://example.com/', active: true },
      ],
    });
    world.failOpenPopup('Could not find an active browser window.');
    invalidateDisplays();
    const warn = nodeMock.method(console, 'warn', () => {});
    try {
      await import('../src/background/service-worker.js?instance=b1-accepted');
      const c = world.chrome;
      await c.runtime.onInstalled.emit({ reason: 'install' });
      await sleep(20);
      assert.equal(world.callsTo('action.openPopup').length, 1, 'one attempt at install');
      assert.ok(
        warn.mock.calls.some((call) => /openPopup failed after install/.test(String(call.arguments[0]))),
        'the rejection is logged',
      );

      // The user clicks the toolbar icon and accepts before any focus change.
      world.allowOpenPopup();
      const res = await new Promise((resolve) => {
        c.runtime.onMessage.emit({ type: MSG.CONFIRM_SETUP, screens: { [INT]: 1.0, [EXT]: 1.25 } }, { id: 'mock' }, resolve);
      });
      assert.equal(res.ok, true, res.error);
      assert.equal((await storage.getState()).onboardingCompleted, true);
      await sleep(80); // background normalization after Accept

      for (const id of [2, 1, 2]) await c.windows.onFocusChanged.emit(id);
      await sleep(20);
      assert.equal(world.callsTo('action.openPopup').length, 1, 'no retry once onboarding is accepted');
      assert.equal(world.zoomOf(22), 1.25, 'focus still syncs zoom normally');
    } finally {
      warn.mock.restore();
      globalThis.chrome = chrome; // hand the global back to the shared instance above
    }
  });
});

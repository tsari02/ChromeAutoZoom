// Engine scenarios from engineering doc v2 §10 (still valid) and v3 §10, plus
// the regression tests for pitfalls A3, A4, C1, C2. Uses _chrome-mock.js and
// asserts through the mock's recorded chrome.* calls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_2,
  DISPLAY_EXTERNAL_4K,
  windowOn,
  onboardedLocal,
  deltaRows,
} from './_chrome-mock.js';
import * as engine from '../src/lib/zoom-engine.js';
import * as storage from '../src/lib/storage.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import { applyZoom, releaseZoom } from '../src/lib/tab-zoom.js';

const EXT = 'ext:lg-ultrafine';
const INT = 'internal';
const K4 = 'ext:lg-hdr-4k';

/** Build a mock and wire the SW's event handlers exactly as service-worker.js does. */
function setup(opts) {
  const mock = installChromeMock({
    displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
    local: onboardedLocal(),
    ...opts,
  });
  invalidateDisplays();
  mock.chrome.tabs.onZoomChange.addListener((info) => engine.handleZoomChange(info));
  mock.chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    await engine.syncTab(tabId);
  });
  return mock;
}

const deltas = async () => (await storage.getState()).siteStepDeltas;
/** {host: {screenKey: delta}} — rows without their timestamps. */
const deltaMap = async () =>
  Object.fromEntries(
    Object.entries(await deltas()).map(([host, rows]) => [host, Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.delta]))]),
  );
const setZoomsFor = (mock, tabId) => mock.callsTo('tabs.setZoom').filter((c) => c.args[0] === tabId);
const lastTitleFor = (mock, tabId) => mock.callsTo('action.setTitle').filter((c) => c.args[0].tabId === tabId).at(-1)?.args[0].title;

describe('zoom-engine — §10 scenarios (v2, still valid)', () => {
  beforeEach(() => invalidateDisplays());

  test('1. Same origin in two windows on two screens → each tab keeps its own zoom', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_INTERNAL, 1), windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 11, windowId: 1, url: 'https://mail.google.com/mail/u/0/', active: true },
        { id: 22, windowId: 2, url: 'https://mail.google.com/mail/u/1/', active: true },
      ],
    });

    const r2 = await engine.syncWindow(2);
    const r1 = await engine.syncWindow(1);
    assert.equal(r2.key, EXT);
    assert.equal(r1.key, INT);

    assert.equal(mock.zoomOf(22), 1.25, 'external window tab at 125%');
    assert.equal(mock.zoomOf(11), 1.0, 'internal window tab stays at 100% (not dragged by the sibling)');
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.scopeOf(11), 'per-tab');

    // Per-tab scope must be set BEFORE setZoom on every managed tab.
    const order = mock.calls.filter((c) => c.api.startsWith('tabs.set')).map((c) => `${c.api}:${c.args[0]}`);
    assert.ok(order.indexOf('tabs.setZoomSettings:22') < order.indexOf('tabs.setZoom:22'));
    assert.deepEqual(mock.callsTo('tabs.setZoomSettings').map((c) => c.args[1].scope), ['per-tab', 'per-tab']);

    // Chrome's own per-origin memory is never written, and no spurious delta
    // was recorded from the per-tab "echo" event Chromium fires on scope change.
    assert.equal(mock.hostZoom.size, 0);
    assert.deepEqual(await deltas(), {});

    // Focus ping-pong does not move either tab.
    await engine.syncWindow(1, { reason: 'focus' });
    await engine.syncWindow(2, { reason: 'focus' });
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('2. onZoomChange with scope per-origin after navigation → no delta written; tab is re-managed', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    await engine.syncWindow(2);
    assert.equal(mock.zoomOf(22), 1.25);
    mock.resetCalls();

    // Cross-origin navigation: Chrome resets per-tab settings and fires
    // onZoomChange with scope 'per-origin' (page loads at host zoom = 1.0).
    await mock.navigate(22, 'https://other.example.org/page');
    const navEvent = mock.zoomEvents[0];
    assert.equal(navEvent.zoomSettings.scope, 'per-origin');
    assert.deepEqual(await deltas(), {}, 'no delta from the navigation reset');

    // tabs.onUpdated → syncTab re-managed the new page at the screen zoom.
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.zoomOf(22), 1.25);
    assert.deepEqual(await deltas(), {}, 'no delta from re-managing either');

    // A direct per-origin event is ignored before any storage read.
    const res = await engine.handleZoomChange({
      tabId: 22,
      oldZoomFactor: 1,
      newZoomFactor: 1.5,
      zoomSettings: { mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 },
    });
    assert.equal(res, 'ignored:scope');
    assert.deepEqual(await deltas(), {});
  });

  test('3. onZoomChange equal to expected → no delta; +1 step → explicit row {ext: 1}; back → host pruned', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true }],
    });
    await engine.syncWindow(2);
    assert.equal(mock.zoomOf(22), 1.25);

    // Equal to expected (our own setZoom echo) → nothing recorded.
    const same = await engine.handleZoomChange({
      tabId: 22,
      oldZoomFactor: 1.0,
      newZoomFactor: 1.25,
      zoomSettings: { mode: 'automatic', scope: 'per-tab', defaultZoomFactor: 1 },
    });
    assert.equal(same, 'ignored:expected');
    assert.deepEqual(await deltas(), {});

    // Cmd + → 150% → +1 step, exactly one row, for THIS screen.
    await mock.userZoom(22, 1.5);
    assert.deepEqual(await deltaMap(), { 'news.ycombinator.com': { [EXT]: 1 } });
    assert.equal(typeof (await deltas())['news.ycombinator.com'][EXT].updatedAt, 'number');

    // Cmd − back to 125% → explicit 0 → every row 0 → host pruned.
    await mock.userZoom(22, 1.25);
    assert.deepEqual(await deltas(), {});

    // The scope-change echo (old === new) is never treated as user intent.
    const echo = await engine.handleZoomChange({
      tabId: 22,
      oldZoomFactor: 1.0,
      newZoomFactor: 1.0,
      zoomSettings: { mode: 'automatic', scope: 'per-tab', defaultZoomFactor: 1 },
    });
    assert.equal(echo, 'ignored:no-change');
    assert.deepEqual(await deltas(), {});
  });

  test('4. Minimized window → no setZoom', async () => {
    const mock = setup({
      windows: [{ ...windowOn(DISPLAY_EXTERNAL, 2), state: 'minimized' }],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
      session: { windowScreen: { 2: EXT } },
    });
    const r = await engine.syncWindow(2, { reason: 'focus' });
    assert.equal(r, null);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0);
    // Last known screen is kept — never snapped to the primary display.
    assert.equal(await storage.getWindowScreen(2), EXT);
    assert.equal(mock.scopeOf(22), 'per-origin');
  });

  test('5. Unplug with stale bounds → "nearest" resolution, then corrected on delayed re-sync', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2],
      local: onboardedLocal({
        screens: {
          ...onboardedLocal().screens,
          'ext:dell-u2723qe': {
            key: 'ext:dell-u2723qe',
            name: 'DELL U2723QE',
            isInternal: false,
            width: 2560,
            height: 1440,
            zoomFactor: 1.5,
            lastSeenDisplayId: DISPLAY_EXTERNAL_2.id,
            createdAt: 1790960002000,
          },
        },
      }),
      windows: [windowOn(DISPLAY_EXTERNAL_2, 3)],
      tabs: [{ id: 33, windowId: 3, url: 'https://example.com/', active: true }],
    });
    const before = await engine.syncWindow(3);
    assert.equal(before.key, 'ext:dell-u2723qe');
    assert.equal(before.confidence, 'center');
    assert.equal(mock.zoomOf(33), 1.5);

    // Unplug the DELL: onDisplayChanged fires before macOS relocates the window.
    mock.setDisplays([DISPLAY_INTERNAL, DISPLAY_EXTERNAL]);
    invalidateDisplays();
    const stale = await engine.syncWindow(3, { reason: 'display' });
    assert.equal(stale.confidence, 'nearest');
    assert.equal(stale.key, EXT, 'nearest remaining display is the LG');
    assert.equal(mock.zoomOf(33), 1.25);

    // macOS then moves the window onto the built-in display; delayed re-sync corrects it.
    const b = DISPLAY_INTERNAL.bounds;
    mock.moveWindow(3, { left: b.left + 50, top: b.top + 50, width: 1200, height: 800 });
    const corrected = await engine.syncWindow(3, { reason: 'display-delayed' });
    assert.equal(corrected.confidence, 'center');
    assert.equal(corrected.key, INT);
    assert.equal(mock.zoomOf(33), 1.0);
    assert.equal(await storage.getWindowScreen(3), INT);
  });

  test('6. 150 tabs, 40 discarded → exactly 110 applyZoom calls, ≤ 8 concurrent', async () => {
    const tabs = [];
    for (let i = 0; i < 150; i++) {
      tabs.push({
        id: 1000 + i,
        windowId: 2,
        url: `https://site${i % 17}.example.com/p/${i}`,
        active: i === 0,
        discarded: i >= 20 && i < 60, // exactly 40 discarded, scattered among live tabs
      });
    }
    assert.equal(tabs.filter((t) => t.discarded).length, 40);
    const mock = setup({ windows: [windowOn(DISPLAY_EXTERNAL, 2)], tabs });

    const summary = await engine.normalizeScreen(EXT);
    assert.equal(summary.updated, 110, 'applyZoom ran for every non-discarded tab');
    assert.equal(summary.applied, 110);
    assert.equal(summary.skipped, 40, 'discarded tabs were skipped, not attempted');

    // Each applyZoom = exactly one getZoomSettings + one setZoom on a distinct tab.
    assert.equal(mock.callsTo('tabs.getZoomSettings').length, 110);
    assert.equal(mock.callsTo('tabs.setZoom').length, 110);
    assert.equal(new Set(mock.callsTo('tabs.setZoom').map((c) => c.args[0])).size, 110);
    for (const t of tabs) {
      if (t.discarded) assert.equal(mock.scopeOf(t.id), 'per-origin', `discarded tab ${t.id} untouched`);
      else assert.equal(mock.zoomOf(t.id), 1.25);
    }

    // Pool limit: never more than 8 zoom operations in flight; and it IS pooled.
    assert.ok(mock.concurrency.max <= 8, `max concurrency was ${mock.concurrency.max}`);
    assert.ok(mock.concurrency.max >= 2, 'work was actually parallelised');

    // Active tab first.
    assert.equal(mock.callsTo('tabs.getZoomSettings')[0].args[0], 1000);
  });

  test('7. Turn Off freezes (zero setZoomSettings/setZoom, tabs keep zoom + per-tab scope); Restore is the only release', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_INTERNAL, 1), windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example.com/', active: true },
        { id: 12, windowId: 1, url: 'https://b.example.com/', active: false },
        { id: 13, windowId: 1, url: 'chrome://extensions/', active: false },
        { id: 21, windowId: 2, url: 'https://c.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://d.example.com/', active: false },
      ],
    });
    await engine.syncWindow(1);
    await engine.syncWindow(2);
    await engine.normalizeScreen(INT);
    await engine.normalizeScreen(EXT);
    for (const id of [11, 12, 21, 22]) assert.equal(mock.scopeOf(id), 'per-tab', `tab ${id} managed`);
    mock.resetCalls();

    // Turn Off: only the flag flips and the badge goes OFF. Nothing is released.
    const paused = await engine.setEnabled(false);
    assert.equal(paused.enabled, false);
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0, 'no scope change on pause');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'no zoom change on pause');
    assert.equal(mock.callsTo('tabs.getZoom').length + mock.callsTo('tabs.getZoomSettings').length, 0, 'no zoom API traffic at all');
    for (const id of [11, 12, 21, 22]) assert.equal(mock.scopeOf(id), 'per-tab', `tab ${id} keeps per-tab scope`);
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal((await storage.getState()).enabled, false);
    const offBadges = mock.callsTo('action.setBadgeText').filter((c) => c.args[0].text === 'OFF').map((c) => c.args[0].tabId);
    assert.deepEqual(offBadges.sort(), [11, 21], 'OFF badge painted on the active tab of each window');

    // Paused engine neither re-manages on activation nor records manual zooms.
    await engine.syncTab(22);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    await mock.userZoom(22, 1.75);
    assert.deepEqual(await deltas(), {}, 'manual zoom while paused is not a site exception');
    assert.equal(mock.zoomOf(22), 1.75, 'the tab keeps what the user set');

    // Restore Chrome's zoom is the one explicit release path.
    mock.resetCalls();
    const restored = await engine.restoreChromeZoom();
    assert.equal(restored.enabled, false);
    assert.equal(restored.released, 4);
    for (const id of [11, 12, 21, 22]) assert.equal(mock.scopeOf(id), 'per-origin', `tab ${id} released`);
    assert.equal(mock.scopeOf(13), 'per-origin');
    const releases = mock.callsTo('tabs.setZoomSettings').filter((c) => c.args[1].scope === 'per-origin');
    assert.deepEqual(releases.map((c) => c.args[0]).sort(), [11, 12, 21, 22]);
    for (const id of [11, 12, 21, 22]) assert.equal(mock.zoomOf(id), 1.0, 'back at Chrome\'s native zoom');
    assert.equal(mock.hostZoom.size, 0, 'Chrome\'s per-origin memory was never written');
    assert.deepEqual(await deltas(), {}, 'the release reset is not mistaken for a manual zoom');
  });
});

describe('zoom-engine — v3 §10 scenarios', () => {
  beforeEach(() => invalidateDisplays());

  test('Gmail +1 on external → internal tab renders +1 (inherited) → Cmd− on internal writes {internal: 0} → external still +1, internal 0', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://mail.google.com/mail/u/0/', active: true },
        { id: 11, windowId: 1, url: 'https://mail.google.com/mail/u/0/#inbox', active: true },
      ],
    });
    await engine.syncWindow(2);
    assert.equal(mock.zoomOf(22), 1.25);

    // Cmd + on the external → +1 for mail.google.com on THAT screen only.
    await mock.userZoom(22, 1.5);
    assert.deepEqual(await deltaMap(), { 'mail.google.com': { [EXT]: 1 } });

    // The internal window renders the inherited +1 (100% + 1 step = 110%).
    await engine.syncWindow(1);
    assert.equal(mock.zoomOf(11), 1.1, 'inherited +1 step relative to the 100% screen');
    assert.match(lastTitleFor(mock, 11), /\+1 step for mail\.google\.com \(inherited from LG UltraFine\)/);

    // Cmd − on the internal back to 100% → explicit 0 row for the internal screen.
    await mock.userZoom(11, 1.0);
    assert.deepEqual(await deltaMap(), { 'mail.google.com': { [EXT]: 1, [INT]: 0 } });
    assert.doesNotMatch(lastTitleFor(mock, 11), /inherited/);

    // Both screens keep their own answer from now on.
    await engine.syncWindow(1);
    await engine.syncWindow(2);
    assert.equal(mock.zoomOf(11), 1.0, 'explicit 0 blocks inheritance on the internal screen');
    assert.equal(mock.zoomOf(22), 1.5, 'external still +1');
    assert.equal(setZoomsFor(mock, 11).filter((c) => c.args[1] !== 1.0).length, 1, 'only the first sync moved the internal tab (to 110%)');
    assert.equal(mock.hostZoom.size, 0);
  });

  test('Turn Off: zero setZoomSettings/setZoom calls, tabs keep zoom and per-tab scope', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://a.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://b.example.com/', active: false },
      ],
    });
    await engine.normalizeScreen(EXT);
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(22), 1.25);
    mock.resetCalls();

    await engine.setEnabled(false);
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    assert.equal(mock.scopeOf(21), 'per-tab');
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.hostZoom.size, 0);

    // Chrome itself detaches a frozen tab on its next cross-document navigation
    // (per-tab settings reset); AutoZoom does not re-manage it while paused.
    await mock.navigate(21, 'https://elsewhere.example.net/');
    assert.equal(mock.scopeOf(21), 'per-origin');
    assert.equal(mock.zoomOf(21), 1.0, 'follows Chrome\'s zoom after navigating');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
  });

  test('REGRESSION A3 — Resume: every tab on every screen re-applied (non-active tabs receive setZoom)', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_INTERNAL, 1), windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 11, windowId: 1, url: 'https://a.example.com/', active: true },
        { id: 12, windowId: 1, url: 'https://b.example.com/', active: false },
        { id: 21, windowId: 2, url: 'https://c.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://d.example.com/', active: false },
      ],
    });
    await engine.normalizeScreen(INT);
    await engine.normalizeScreen(EXT);
    await engine.setEnabled(false);

    // While paused the user zooms a background tab on each screen; nothing is recorded.
    await mock.userZoom(12, 0.8);
    await mock.userZoom(22, 1.75);
    assert.deepEqual(await deltas(), {});
    mock.resetCalls();

    const resumed = await engine.setEnabled(true);
    assert.equal(resumed.enabled, true);
    assert.deepEqual(Object.keys(resumed.normalized).sort(), [EXT, INT], 'every connected screen normalized');
    // The non-active tab on EACH connected screen got a setZoom back to the screen default.
    assert.deepEqual(setZoomsFor(mock, 12).map((c) => c.args[1]), [1.0]);
    assert.deepEqual(setZoomsFor(mock, 22).map((c) => c.args[1]), [1.25]);
    for (const id of [11, 12, 21, 22]) assert.equal(mock.scopeOf(id), 'per-tab');
    assert.equal(mock.zoomOf(12), 1.0);
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal(mock.zoomOf(21), 1.25);
  });

  test('SET_SCREEN_ZOOM on external writes learnedDefaults; on internal does not (and seeds the next same-size monitor)', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    const ext = await engine.setScreenZoom(EXT, 1.5, { awaitNormalize: true });
    assert.equal(ext.updated, 1);
    assert.equal(mock.zoomOf(22), 1.5);
    assert.deepEqual((await storage.getState()).learnedDefaults, { '2560x1440': 1.5 });

    await engine.setScreenZoom(INT, 1.1, { awaitNormalize: true });
    assert.deepEqual((await storage.getState()).learnedDefaults, { '2560x1440': 1.5 }, 'internal is never learned');
    assert.equal((await storage.getState()).screens[INT].zoomFactor, 1.1, 'but its own zoom did change');

    // The next never-seen 2560×1440 monitor seeds from the learned value, not the 125% fallback.
    mock.setDisplays([DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2]);
    invalidateDisplays();
    const { created, screens } = await engine.syncDisplays();
    assert.deepEqual(created, ['ext:dell-u2723qe']);
    assert.equal(screens['ext:dell-u2723qe'].zoomFactor, 1.5);
    assert.equal(screens[EXT].zoomFactor, 1.5, 'existing screens untouched by learning');
  });

  test('new external after first run → every manageable tab on it gets applyZoom with the map value without any message', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_EXTERNAL_4K, 4)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 41, windowId: 4, url: 'https://a.example.com/', active: true },
        { id: 42, windowId: 4, url: 'https://b.example.com/', active: false },
        { id: 43, windowId: 4, url: 'https://c.example.com/', active: false },
        { id: 44, windowId: 4, url: 'chrome://settings/', active: false },
      ],
    });
    // The 4K monitor is plugged in now (its window was already placed there by macOS).
    mock.setDisplays([DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K]);
    invalidateDisplays();
    const created = await engine.syncAll('display');
    assert.deepEqual(created, [K4]);

    const s = (await storage.getState()).screens[K4];
    assert.equal(s.zoomFactor, 1.5, 'seeded from the map (3840×2160 → 150%), not a flat 125%');
    assert.deepEqual([s.width, s.height], [3840, 2160]);
    assert.equal(s.name, 'LG HDR 4K');
    for (const id of [41, 42, 43]) {
      assert.equal(mock.zoomOf(id), 1.5, `tab ${id} at the map value`);
      assert.equal(mock.scopeOf(id), 'per-tab');
    }
    assert.equal(mock.scopeOf(44), 'per-origin', 'chrome:// tab untouched');
    assert.equal(mock.zoomOf(22), 1.25, 'other screen unaffected');
    assert.equal(mock.callsTo('windows.create').length, 0, 'no prompt window');
    assert.equal(mock.callsTo('action.openPopup').length, 0, 'no popup');
  });

  test('never-seen monitor via window drag → normalizeScreen fired (background tabs set too)', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K], // 4K connected but never profiled
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://a.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://b.example.com/', active: false },
        { id: 23, windowId: 2, url: 'https://c.example.com/', active: false },
      ],
    });
    await engine.normalizeScreen(EXT);
    for (const id of [21, 22, 23]) assert.equal(mock.zoomOf(id), 1.25);
    assert.ok(!(K4 in (await storage.getState()).screens));
    mock.resetCalls();

    const b = DISPLAY_EXTERNAL_4K.bounds;
    mock.moveWindow(2, { left: b.left + 100, top: b.top + 100 });
    const r = await engine.syncWindow(2, { reason: 'bounds' });
    assert.equal(r.key, K4);
    assert.equal(r.changed, true);
    assert.equal(mock.zoomOf(21), 1.5, 'active tab set by syncWindow');
    await engine.settleBackgroundWork();
    assert.equal(mock.zoomOf(22), 1.5, 'background tab set by the background normalizeScreen');
    assert.equal(mock.zoomOf(23), 1.5);
    assert.deepEqual(setZoomsFor(mock, 22).map((c) => c.args[1]), [1.5]);
    const profile = (await storage.getState()).screens[K4];
    assert.equal(profile.zoomFactor, 1.5);
    assert.equal(profile.width, 3840);
    assert.equal(await storage.getWindowScreen(2), K4);
  });

  test('exclude host → its delta rows gone (other hosts untouched); tabs released', async () => {
    const mock = setup({
      local: onboardedLocal({
        siteStepDeltas: {
          'www.figma.com': deltaRows({ [EXT]: 1, [INT]: 0 }),
          'news.ycombinator.com': deltaRows({ [EXT]: 2 }),
        },
      }),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://www.figma.com/file/1', active: true },
        { id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: false },
      ],
    });
    await engine.normalizeScreen(EXT);
    assert.equal(mock.zoomOf(21), 1.5, '125% + 1');
    assert.equal(mock.zoomOf(22), 1.75, '125% + 2');

    const ex = await engine.setExcluded('www.figma.com', true);
    assert.equal(ex.tabs, 1);
    assert.deepEqual(await deltaMap(), { 'news.ycombinator.com': { [EXT]: 2 } });
    assert.equal(mock.scopeOf(21), 'per-origin');
    assert.equal(mock.zoomOf(21), 1.0);
    assert.equal(mock.zoomOf(22), 1.75, 'other host untouched');
    assert.equal(mock.hostZoom.size, 0);

    // Re-including starts from the screen default: the rows are really gone.
    await engine.setExcluded('www.figma.com', false);
    assert.equal(mock.scopeOf(21), 'per-tab');
    assert.equal(mock.zoomOf(21), 1.25);
  });
});

describe('zoom-engine — regressions (pitfalls C1 / C2 / A4)', () => {
  beforeEach(() => invalidateDisplays());

  test('REGRESSION C1: N windows on a never-seen display + concurrent syncAll/resyncAllWindows → background tabs get exactly one getZoomSettings/setZoom', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K],
      windows: [windowOn(DISPLAY_EXTERNAL_4K, 3), windowOn(DISPLAY_EXTERNAL_4K, 4), windowOn(DISPLAY_EXTERNAL_4K, 5)],
      tabs: [
        { id: 31, windowId: 3, url: 'https://a.example.com/', active: true },
        { id: 32, windowId: 3, url: 'https://b.example.com/', active: false },
        { id: 41, windowId: 4, url: 'https://c.example.com/', active: true },
        { id: 42, windowId: 4, url: 'https://d.example.com/', active: false },
        { id: 51, windowId: 5, url: 'https://e.example.com/', active: true },
        { id: 52, windowId: 5, url: 'https://f.example.com/', active: false },
      ],
    });
    // The display-change pass and two focus bursts land in the same tick.
    await Promise.all([engine.syncAll('display'), engine.resyncAllWindows('focus'), engine.resyncAllWindows('focus')]);
    await engine.settleBackgroundWork();

    assert.equal(Object.keys((await storage.getState()).screens).filter((k) => k === K4).length, 1, 'one profile');
    for (const id of [32, 42, 52]) {
      assert.equal(mock.callsTo('tabs.getZoomSettings').filter((c) => c.args[0] === id).length, 1, `tab ${id}: one normalization pass, not N+1`);
      assert.equal(setZoomsFor(mock, id).length, 1, `tab ${id}: one setZoom`);
      assert.equal(mock.zoomOf(id), 1.5);
    }
    for (const id of [31, 41, 51]) assert.equal(mock.zoomOf(id), 1.5);

    // A later pass for the same key (the delayed display-change pass) runs again
    // by design, but overlapping requests join one in-flight pass.
    mock.resetCalls();
    await Promise.all([engine.normalizeNewScreen(K4), engine.normalizeNewScreen(K4), engine.normalizeNewScreen(K4)]);
    for (const id of [32, 42, 52]) {
      assert.equal(mock.callsTo('tabs.getZoomSettings').filter((c) => c.args[0] === id).length, 1, `tab ${id}: three overlapping requests → one pass`);
    }
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'already at the target: nothing re-set');
  });

  test('REGRESSION C1: a window dragged onto a display another window just created does not normalize again', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K],
      windows: [windowOn(DISPLAY_EXTERNAL_4K, 3), windowOn(DISPLAY_EXTERNAL_4K, 4)],
      tabs: [
        { id: 31, windowId: 3, url: 'https://a.example.com/', active: true },
        { id: 32, windowId: 3, url: 'https://b.example.com/', active: false },
        { id: 41, windowId: 4, url: 'https://c.example.com/', active: true },
        { id: 42, windowId: 4, url: 'https://d.example.com/', active: false },
      ],
    });
    await Promise.all([engine.syncWindow(3, { reason: 'bounds' }), engine.syncWindow(4, { reason: 'bounds' })]);
    await engine.settleBackgroundWork();
    for (const id of [32, 42]) {
      assert.equal(mock.callsTo('tabs.getZoomSettings').filter((c) => c.args[0] === id).length, 1, `tab ${id}: exactly one pass`);
      assert.equal(mock.zoomOf(id), 1.5);
    }
    // A later resync of the same windows matches the profile and does not normalize.
    mock.resetCalls();
    await engine.resyncAllWindows('focus');
    await engine.settleBackgroundWork();
    for (const id of [32, 42]) assert.equal(mock.callsTo('tabs.getZoomSettings').filter((c) => c.args[0] === id).length, 0);
  });

  test('REGRESSION C2: syncDisplays refreshes width/height (and lastSeenDisplayId) on matched profiles', async () => {
    const local = onboardedLocal();
    // A v2-migrated external (size unknown) and an internal whose "Looks like…" scaling changed.
    local.screens[EXT] = { ...local.screens[EXT], width: null, height: null, lastSeenDisplayId: 'old-id' };
    local.screens[INT] = { ...local.screens[INT], width: 1728, height: 1117 };
    const mock = setup({ local, windows: [], tabs: [] });
    const { created, screens } = await engine.syncDisplays();
    assert.deepEqual(created, [], 'matched, not re-created');
    assert.deepEqual([screens[EXT].width, screens[EXT].height], [2560, 1440]);
    assert.equal(screens[EXT].lastSeenDisplayId, DISPLAY_EXTERNAL.id);
    assert.deepEqual([screens[INT].width, screens[INT].height], [1512, 982]);
    const dump = mock.chrome.storage.local._dump().screens;
    assert.deepEqual([dump[EXT].width, dump[EXT].height], [2560, 1440], 'persisted');
    assert.equal(dump[EXT].zoomFactor, 1.25, 'nothing else touched');
    assert.equal(dump[EXT].createdAt, local.screens[EXT].createdAt);
  });

  test('REGRESSION C2: the per-window resolve path (syncWindow) refreshes width/height too', async () => {
    const local = onboardedLocal();
    local.screens[EXT] = { ...local.screens[EXT], width: null, height: null };
    const mock = setup({
      local,
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    const r = await engine.syncWindow(2); // no syncDisplays in this path
    assert.equal(r.key, EXT);
    const dump = mock.chrome.storage.local._dump().screens[EXT];
    assert.deepEqual([dump.width, dump.height], [2560, 1440]);
    assert.equal(mock.callsTo('windows.getAll').length, 0, 'syncDisplays was not involved');
  });

  test('REGRESSION A4: confirmSetup on a migrated size-less external choosing a non-map value teaches nothing', async () => {
    const local = onboardedLocal({ onboardingCompleted: false });
    local.screens[EXT] = { ...local.screens[EXT], width: null, height: null }; // v2-migrated, never re-seen
    setup({ displays: [], local, windows: [], tabs: [] }); // no live display to refresh the size from
    const applied = await engine.confirmSetup({ screens: { [INT]: 1.0, [EXT]: 1.5, 'ext:unknown': 1.1 } });
    assert.deepEqual(applied.sort(), [EXT, INT], 'unknown keys ignored');
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.equal(st.screens[EXT].zoomFactor, 1.5);
    assert.deepEqual(st.learnedDefaults, {}, 'no "0x0" / "nullxnull" key');
    assert.ok(!('ext:unknown' in st.screens));
  });

  test('confirmSetup teaches the map only for externals whose choice differs from the recommendation', async () => {
    setup({ local: onboardedLocal({ onboardingCompleted: false }), windows: [], tabs: [] });
    await engine.confirmSetup({ screens: { [INT]: 1.1, [EXT]: 1.25 } });
    let st = await storage.getState();
    assert.deepEqual(st.learnedDefaults, {}, 'map value accepted → nothing learned; internal never learned');
    assert.equal(st.screens[INT].zoomFactor, 1.1);

    await storage.patchState({ onboardingCompleted: false });
    await engine.confirmSetup({ screens: { [EXT]: 1.5 } });
    st = await storage.getState();
    assert.deepEqual(st.learnedDefaults, { '2560x1440': 1.5 });
    assert.equal(st.onboardingCompleted, true);
  });
});

describe('zoom-engine — behavioural guarantees', () => {
  beforeEach(() => invalidateDisplays());

  test('Cmd+0 is treated like any other manual zoom (R5): records −2 on a 125% screen', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://tiny.example.com/', active: true }],
    });
    await engine.syncWindow(2);
    await mock.userZoom(22, 1.0);
    assert.deepEqual(await deltaMap(), { 'tiny.example.com': { [EXT]: -2 } });
  });

  test('a manual zoom on a tab whose scope is per-origin never writes a delta', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://unmanaged.example.com/', active: true }],
    });
    assert.equal(mock.scopeOf(22), 'per-origin');
    await mock.userZoom(22, 1.5);
    assert.deepEqual(await deltas(), {});
  });

  test('site delta follows the site across screens by inheritance (Journey 4)', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true },
        { id: 11, windowId: 1, url: 'https://news.ycombinator.com/news', active: true },
      ],
    });
    await engine.syncWindow(2);
    await mock.userZoom(22, 1.5); // +1 on the 125% screen
    assert.deepEqual(await deltaMap(), { 'news.ycombinator.com': { [EXT]: 1 } });
    await engine.syncWindow(1);
    assert.equal(mock.zoomOf(11), 1.1, '+1 step relative to the 100% screen');
  });

  test('Exclude releases the site\'s tabs to Chrome\'s zoom (no delta recorded); un-exclude re-manages', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://www.figma.com/file/1', active: true },
        { id: 22, windowId: 2, url: 'https://www.figma.com/file/2', active: false },
        { id: 23, windowId: 2, url: 'https://other.example.com/', active: false },
      ],
    });
    await engine.normalizeScreen(EXT);
    for (const id of [21, 22, 23]) assert.equal(mock.scopeOf(id), 'per-tab');

    const ex = await engine.setExcluded('www.figma.com', true);
    assert.equal(ex.tabs, 2);
    assert.equal(mock.scopeOf(21), 'per-origin');
    assert.equal(mock.scopeOf(22), 'per-origin');
    assert.equal(mock.scopeOf(23), 'per-tab', 'other sites untouched');
    assert.equal(mock.zoomOf(21), 1.0);
    assert.equal(mock.hostZoom.size, 0);
    assert.deepEqual(await deltas(), {});
    assert.equal((await storage.getState()).excludedHosts['www.figma.com'], true);

    // Excluded sites are ignored by sync and by the detector.
    await engine.syncTab(21);
    assert.equal(mock.scopeOf(21), 'per-origin');
    await mock.userZoom(21, 1.5);
    assert.deepEqual(await deltas(), {});

    await engine.setExcluded('www.figma.com', false);
    assert.equal(mock.scopeOf(21), 'per-tab');
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('releaseZoom restores a pre-existing Chrome per-origin level and never persists AutoZoom\'s value', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://remembered.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://fresh.example.com/', active: false },
      ],
      hostZoom: { 'remembered.example.com': 1.5 },
    });
    assert.equal(mock.zoomOf(21), 1.5);
    assert.equal(await applyZoom(21, 1.25), 'applied');
    assert.equal(await applyZoom(22, 1.25), 'applied');
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.hostZoom.get('remembered.example.com'), 1.5, 'Chrome memory untouched while managed');

    assert.equal(await releaseZoom(21), 'released');
    assert.equal(await releaseZoom(22), 'released');
    assert.equal(mock.zoomOf(21), 1.5, 'back to what Chrome remembered');
    assert.equal(mock.zoomOf(22), 1.0, 'back to Chrome default');
    assert.deepEqual([...mock.hostZoom.entries()], [['remembered.example.com', 1.5]]);
    assert.equal(await releaseZoom(22), 'unchanged', 'releasing an unmanaged tab is a no-op');
  });

  test('applyZoom / releaseZoom swallow churn errors (closed or discarded tabs)', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true, discarded: true }],
    });
    assert.equal(await applyZoom(22, 1.25), 'skipped');
    assert.equal(await applyZoom(999, 1.25), 'skipped');
    assert.equal(await releaseZoom(999), 'skipped');
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
  });

  test('normalizeScreen with discarded tabs completes without throwing and skips them', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://a.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://b.example.com/', active: false, discarded: true },
        { id: 23, windowId: 2, url: 'chrome://settings/', active: false },
      ],
    });
    const s = await engine.normalizeScreen(EXT);
    assert.deepEqual(s, { updated: 1, applied: 1, unchanged: 0, skipped: 2 });
    assert.equal(mock.scopeOf(22), 'per-origin');
  });

  test('syncWindow ignores non-normal windows (DevTools, PiP, app popups)', async () => {
    const mock = setup({
      windows: [{ ...windowOn(DISPLAY_EXTERNAL, 5), type: 'popup' }],
      tabs: [{ id: 51, windowId: 5, url: 'https://app.example.com/widget', active: true }],
    });
    assert.equal(await engine.syncWindow(5), null);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
  });

  test('bounds re-sync short-circuits when the resolved screen is unchanged', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    await engine.syncWindow(2);
    mock.resetCalls();
    const r = await engine.syncWindow(2, { reason: 'bounds' });
    assert.equal(r.changed, false);
    assert.equal(mock.callsTo('tabs.getZoom').length, 0);

    // Drag to the other display → applies the new screen zoom.
    const b = DISPLAY_INTERNAL.bounds;
    mock.moveWindow(2, { left: b.left + 10, top: b.top + 10 });
    const moved = await engine.syncWindow(2, { reason: 'bounds' });
    assert.equal(moved.changed, true);
    assert.equal(moved.key, INT);
    assert.equal(mock.zoomOf(22), 1.0);
  });

  test('nothing is zoomed before first-run Accept (syncAll included); confirmSetup completes onboarding', async () => {
    const mock = setup({
      local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} },
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://example.org/', active: false },
      ],
    });
    const created = await engine.syncAll('startup');
    assert.deepEqual(created.sort(), [EXT, INT], 'profiles are created…');
    await engine.syncWindow(2);
    await engine.settleBackgroundWork();
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, '…but nothing is zoomed');
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0);
    assert.equal(mock.scopeOf(21), 'per-origin');
    const seeded = (await storage.getState()).screens;
    assert.equal(seeded[EXT].zoomFactor, 1.25, 'map value for 2560×1440');
    assert.equal(seeded[INT].zoomFactor, 1.0);

    const keys = await engine.confirmSetup({ screens: { [INT]: 1.0, [EXT]: 1.5 } });
    assert.deepEqual(keys.sort(), [EXT, INT]);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.equal(st.screens[EXT].zoomFactor, 1.5);
    assert.ok(!('confirmed' in st.screens[EXT]));
    assert.deepEqual(st.learnedDefaults, { '2560x1440': 1.5 }, '150% ≠ map 125% → learned');

    await engine.normalizeScreen(EXT);
    assert.equal(mock.zoomOf(21), 1.5);
    assert.equal(mock.zoomOf(22), 1.5);
  });

  test('syncDisplays creates a map-seeded profile for a new external display, opens nothing, normalizes nothing by itself', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_4K],
      windows: [windowOn(DISPLAY_EXTERNAL_4K, 4)],
      tabs: [{ id: 41, windowId: 4, url: 'https://example.com/', active: true }],
    });
    const { created, screens } = await engine.syncDisplays();
    assert.deepEqual(created, [K4]);
    const p = screens[K4];
    assert.equal(p.zoomFactor, 1.5);
    assert.equal(p.name, 'LG HDR 4K');
    assert.equal(p.isInternal, false);
    assert.deepEqual([p.width, p.height], [3840, 2160]);
    assert.equal(p.lastSeenDisplayId, DISPLAY_EXTERNAL_4K.id);
    assert.equal(typeof p.createdAt, 'number');
    assert.ok(!('confirmed' in p));
    assert.equal(mock.callsTo('windows.create').length, 0);
    assert.equal(mock.callsTo('action.openPopup').length, 0);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'the caller (syncAll) decides when to normalize');

    // Idempotent: a second pass creates nothing and changes nothing.
    const again = await engine.syncDisplays();
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.screens, screens);
  });

  test('clearSiteExceptions wipes every host\'s rows and re-normalizes every connected screen', async () => {
    const mock = setup({
      local: onboardedLocal({ siteStepDeltas: { 'news.ycombinator.com': deltaRows({ [EXT]: 1 }), 'x.example.com': deltaRows({ [INT]: -1 }) } }),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true }],
    });
    await engine.syncWindow(2);
    assert.equal(mock.zoomOf(22), 1.5);
    const results = await engine.clearSiteExceptions();
    assert.deepEqual(await deltas(), {});
    assert.ok(EXT in results && INT in results);
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('REGRESSION: overlapping applyZoom on the same tab issues a single setZoom', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://a.example.com/', active: true }],
    });
    // normalizeScreen and a focus-change syncWindow racing for the active tab.
    await Promise.all([engine.normalizeScreen(EXT), engine.syncWindow(2, { reason: 'focus' }), applyZoom(22, 1.25)]);
    assert.equal(mock.zoomOf(22), 1.25);
    assert.equal(mock.callsTo('tabs.setZoom').filter((c) => c.args[0] === 22).length, 1, 'one setZoom, not three');
    assert.equal(mock.callsTo('tabs.setZoomSettings').filter((c) => c.args[0] === 22).length, 1);
  });

  test('setScreenZoom rejects unknown screen keys instead of creating a nameless profile', async () => {
    setup({ windows: [windowOn(DISPLAY_EXTERNAL, 2)], tabs: [] });
    await assert.rejects(() => engine.setScreenZoom('ext:nope', 1.5), /Unknown screen key/);
    await assert.rejects(() => engine.setScreenZoom(EXT, 0), /Invalid zoom factor/);
    assert.ok(!('ext:nope' in (await storage.getState()).screens));
    assert.deepEqual((await storage.getState()).learnedDefaults, {});
  });

  test('setScreenZoom persists and normalizes the screen', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 21, windowId: 2, url: 'https://a.example.com/', active: true },
        { id: 22, windowId: 2, url: 'https://b.example.com/', active: false },
      ],
    });
    const s = await engine.setScreenZoom(EXT, 1.5, { awaitNormalize: true });
    assert.equal(s.updated, 2);
    assert.equal(mock.zoomOf(21), 1.5);
    assert.equal(mock.zoomOf(22), 1.5);
    assert.equal((await storage.getState()).screens[EXT].zoomFactor, 1.5);
  });

  test('renameScreen writes the name and refreshes the badge title on that screen\'s active tabs only', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 23, windowId: 2, url: 'https://example.org/', active: false },
        { id: 11, windowId: 1, url: 'https://example.com/', active: true },
      ],
    });
    await engine.syncWindow(2);
    await engine.syncWindow(1);
    mock.resetCalls();
    const s = await engine.renameScreen(EXT, '  Office   4K  ');
    assert.equal(s.name, 'Office 4K');
    assert.equal((await storage.getState()).screens[EXT].name, 'Office 4K');
    const titles = mock.callsTo('action.setTitle').map((c) => c.args[0]);
    assert.deepEqual(titles.map((t) => t.tabId), [22], 'only the external window\'s active tab');
    assert.match(titles[0].title, /^AutoZoom · Office 4K · 125%/);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'renaming never zooms');
    await assert.rejects(() => engine.renameScreen('ext:nope', 'X'), /Unknown screen key/);
  });
});

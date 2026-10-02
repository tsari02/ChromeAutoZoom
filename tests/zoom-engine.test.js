// Engine scenarios from engineering doc §10 (all seven, by name) plus the
// behavioural guarantees from the acceptance criteria. Uses _chrome-mock.js.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_2,
  windowOn,
  onboardedLocal,
} from './_chrome-mock.js';
import * as engine from '../src/lib/zoom-engine.js';
import * as storage from '../src/lib/storage.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import { applyZoom, releaseZoom } from '../src/lib/tab-zoom.js';

const EXT = 'ext:lg-ultrafine';
const INT = 'internal';

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

describe('zoom-engine — §10 scenarios', () => {
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

  test('3. onZoomChange equal to expected → no delta; +1 step → delta 1; back → entry removed', async () => {
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

    // Cmd + → 150% → +1 step, exactly one entry.
    await mock.userZoom(22, 1.5);
    assert.deepEqual(await deltas(), { 'news.ycombinator.com': 1 });

    // Cmd − back to 125% → entry removed.
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
            zoomFactor: 1.5,
            confirmed: true,
            lastSeenDisplayId: DISPLAY_EXTERNAL_2.id,
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

  test('7. Pause → every managed tab receives scope per-origin (and Chrome memory stays clean); Resume re-manages', async () => {
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
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(22), 1.25);
    mock.resetCalls();

    const paused = await engine.setEnabled(false);
    assert.equal(paused.enabled, false);
    assert.equal(paused.released, 4);
    for (const id of [11, 12, 21, 22]) assert.equal(mock.scopeOf(id), 'per-origin', `tab ${id} released`);
    assert.equal(mock.scopeOf(13), 'per-origin');
    const releases = mock.callsTo('tabs.setZoomSettings').filter((c) => c.args[1].scope === 'per-origin');
    assert.deepEqual(releases.map((c) => c.args[0]).sort(), [11, 12, 21, 22]);
    // Tabs are back at Chrome's native zoom and Chrome's memory was never written.
    for (const id of [21, 22]) assert.equal(mock.zoomOf(id), 1.0);
    assert.equal(mock.hostZoom.size, 0);
    assert.deepEqual(await deltas(), {}, 'the release reset is not mistaken for a manual zoom');

    // Paused engine does not re-manage on tab activation.
    await engine.syncTab(22);
    assert.equal(mock.scopeOf(22), 'per-origin');

    // Resume: active tabs return to per-tab at the screen zoom.
    const resumed = await engine.setEnabled(true);
    assert.equal(resumed.enabled, true);
    assert.equal(mock.scopeOf(11), 'per-tab');
    assert.equal(mock.scopeOf(21), 'per-tab');
    assert.equal(mock.zoomOf(21), 1.25);
    assert.equal(mock.zoomOf(11), 1.0);
    assert.equal(mock.scopeOf(22), 'per-origin', 'background tabs are re-managed lazily');
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
    assert.deepEqual(await deltas(), { 'tiny.example.com': -2 });
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

  test('site delta follows the site across screens (Journey 4)', async () => {
    const mock = setup({
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true },
        { id: 11, windowId: 1, url: 'https://news.ycombinator.com/news', active: true },
      ],
    });
    await engine.syncWindow(2);
    await mock.userZoom(22, 1.5); // +1 on the 125% screen
    assert.deepEqual(await deltas(), { 'news.ycombinator.com': 1 });
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

  test('syncWindow ignores non-normal windows (the setup popup, DevTools, PiP)', async () => {
    const mock = setup({
      windows: [{ ...windowOn(DISPLAY_EXTERNAL, 5), type: 'popup' }],
      tabs: [{ id: 51, windowId: 5, url: 'chrome-extension://mock-extension-id/src/setup/setup.html', active: true }],
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

  test('nothing is zoomed before onboarding is confirmed; confirmSetup completes onboarding', async () => {
    const mock = setup({
      local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} },
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    await engine.syncDisplays();
    await engine.syncWindow(2);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    assert.equal(mock.scopeOf(22), 'per-origin');

    const keys = await engine.confirmSetup({ screens: { internal: 1.0, [EXT]: 1.5 }, defaults: { external: 1.5 } });
    assert.deepEqual(keys.sort(), [EXT, INT]);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.equal(st.screens[EXT].zoomFactor, 1.5);
    assert.equal(st.screens[EXT].confirmed, true);
    assert.equal(st.defaults.external, 1.5);

    await engine.normalizeScreen(EXT);
    assert.equal(mock.zoomOf(22), 1.5);
  });

  test('syncDisplays creates unconfirmed profiles for new external displays and queues a prompt', async () => {
    const mock = setup({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2],
      windows: [windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [{ id: 11, windowId: 1, url: 'https://example.com/', active: true }],
    });
    const { created, screens } = await engine.syncDisplays();
    assert.deepEqual(created, ['ext:dell-u2723qe']);
    assert.equal(screens['ext:dell-u2723qe'].confirmed, false);
    assert.equal(screens['ext:dell-u2723qe'].zoomFactor, 1.25);
    const created1 = mock.callsTo('windows.create');
    assert.equal(created1.length, 1, 'one new-display prompt opened');
    assert.match(created1[0].args[0].url, /mode=new-display&key=ext%3Adell-u2723qe/);
    assert.equal(created1[0].args[0].type, 'popup');
    // Opened centred on that display.
    const wa = DISPLAY_EXTERNAL_2.workArea;
    assert.ok(created1[0].args[0].left > wa.left && created1[0].args[0].left < wa.left + wa.width);

    // A second request while the window is open does not open another window.
    await engine.syncDisplays();
    assert.equal(mock.callsTo('windows.create').length, 1);
    const session = await storage.getSession();
    assert.deepEqual(session.pendingSetupKeys, ['ext:dell-u2723qe']);
    assert.ok(Number.isInteger(session.setupWindowId));
  });

  test('clearSiteExceptions wipes deltas and re-normalizes every connected screen', async () => {
    const mock = setup({
      local: onboardedLocal({ siteStepDeltas: { 'news.ycombinator.com': 1, 'x.example.com': -1 } }),
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

  test('REGRESSION: N windows on one unconfirmed display + resyncAllWindows → exactly one prompt window', async () => {
    // Three normal windows on an external display whose profile exists but is
    // not yet confirmed (e.g. SW restarted between syncDisplays and the prompt).
    const unconfirmed = onboardedLocal();
    unconfirmed.screens[EXT] = { ...unconfirmed.screens[EXT], confirmed: false };
    const mock = setup({
      local: unconfirmed,
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_EXTERNAL, 3), windowOn(DISPLAY_EXTERNAL, 4)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://a.example.com/', active: true },
        { id: 33, windowId: 3, url: 'https://b.example.com/', active: true },
        { id: 44, windowId: 4, url: 'https://c.example.com/', active: true },
      ],
    });
    const results = await engine.resyncAllWindows('display-change');
    assert.equal(results.length, 3, 'all three windows synced');
    const creates = mock.callsTo('windows.create');
    assert.equal(creates.length, 1, `expected exactly one setup window, got ${creates.length}`);
    assert.match(creates[0].args[0].url, /mode=new-display&key=ext%3Alg-ultrafine/);
    const session = await storage.getSession();
    assert.deepEqual(session.pendingSetupKeys, [EXT]);
    assert.ok(Number.isInteger(session.setupWindowId));

    // Still one after a second burst while the prompt is open.
    await Promise.all([engine.resyncAllWindows('focus'), engine.syncDisplays(), engine.resyncAllWindows('focus')]);
    assert.equal(mock.callsTo('windows.create').length, 1);
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
  });

  test('setScreenZoom persists, confirms and normalizes the screen', async () => {
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
});

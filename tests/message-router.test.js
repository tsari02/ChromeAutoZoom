// message-router.js — the v3 message table (engineering doc v3 §8 / §10) and
// the A2 regression. Asserts through the mock's recorded chrome.* calls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installChromeMock,
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_4K,
  DISPLAY_EXTERNAL_1080P,
  windowOn,
  onboardedLocal,
  deltaRows,
} from './_chrome-mock.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import { handleMessage } from '../src/background/message-router.js';
import { MSG } from '../src/lib/constants.js';
import * as storage from '../src/lib/storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = 'ext:lg-ultrafine';
const INT = 'internal';

/** Send a message through the real listener and resolve with the response. */
function send(message) {
  return new Promise((resolve) => {
    const keepOpen = handleMessage(message, { id: 'mock-extension-id' }, resolve);
    assert.equal(keepOpen, true, 'listener must return true for async responses');
  });
}

describe('message-router', () => {
  beforeEach(() => invalidateDisplays());

  test('GET_POPUP_STATE.firstRun.rows lists connected displays with map values (4K → 150%, 1080p → 100%)', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_EXTERNAL_4K, DISPLAY_INTERNAL, DISPLAY_EXTERNAL_1080P],
      local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} },
      windows: [windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [{ id: 11, windowId: 1, url: 'https://example.com/', active: true }],
    });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 11, windowId: 1 });
    assert.equal(res.ok, true, res.error);
    const r = res.result;
    assert.equal(r.onboardingCompleted, false);
    assert.ok(r.firstRun, 'firstRun block present before Accept');
    assert.deepEqual(
      r.firstRun.rows.map((row) => [row.key, row.recommended, row.zoomFactor, row.width, row.height]),
      [
        ['internal', 1.0, 1.0, 1512, 982],
        ['ext:benq-gw2480', 1.0, 1.0, 1920, 1080],
        ['ext:lg-hdr-4k', 1.5, 1.5, 3840, 2160],
      ],
      'internal first, then externals sorted by name; selects pre-filled from the map',
    );
    assert.deepEqual(r.firstRun.rows.map((row) => row.name), ['Built-in Retina Display', 'BenQ GW2480', 'LG HDR 4K']);
    assert.equal(r.ladder.length, 17);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'nothing zoomed before Accept');
    assert.equal(mock.callsTo('windows.create').length, 0, 'no setup window');
    assert.equal(r.screen.key, INT, 'current screen still resolved');
  });

  test('GET_POPUP_STATE after Accept has no firstRun block', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: onboardedLocal(), windows: [windowOn(DISPLAY_EXTERNAL, 2)], tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }] });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(res.result.onboardingCompleted, true);
    assert.equal(res.result.firstRun, undefined);
  });

  test('CONFIRM_SETUP sets onboardingCompleted, seeds learned defaults for changed externals only, and normalizes in the background', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} },
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 23, windowId: 2, url: 'https://example.org/', active: false },
        { id: 11, windowId: 1, url: 'https://example.com/', active: true },
      ],
    });
    await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    const res = await send({ type: MSG.CONFIRM_SETUP, screens: { [INT]: 1.1, [EXT]: 1.5 } });
    assert.equal(res.ok, true);
    assert.deepEqual([...res.result.keys].sort(), [EXT, INT]);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.equal(st.screens[EXT].zoomFactor, 1.5);
    assert.equal(st.screens[INT].zoomFactor, 1.1);
    assert.deepEqual(st.learnedDefaults, { '2560x1440': 1.5 }, 'external 150% ≠ map 125% → learned; internal never learned');
    assert.ok(!('defaults' in mock.chrome.storage.local._dump()));
    await sleep(80); // background normalization
    assert.equal(mock.zoomOf(22), 1.5);
    assert.equal(mock.zoomOf(23), 1.5, 'background tab too');
    assert.equal(mock.zoomOf(11), 1.1);
    for (const id of [22, 23, 11]) assert.equal(mock.scopeOf(id), 'per-tab');
  });

  test('CONFIRM_SETUP with the recommended values learns nothing', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} } });
    const res = await send({ type: MSG.CONFIRM_SETUP, screens: { [INT]: 1.0, [EXT]: 1.25 } });
    assert.equal(res.ok, true);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.deepEqual(st.learnedDefaults, {});
  });

  test('GET_POPUP_STATE returns screen (with recommended), site (inherited info) and saved screens for the active tab', async () => {
    installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal({ siteStepDeltas: { 'news.ycombinator.com': deltaRows({ [EXT]: 1 }) } }),
      windows: [windowOn(DISPLAY_INTERNAL, 1), windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 11, windowId: 1, url: 'https://news.ycombinator.com/', active: true },
        { id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true },
      ],
    });
    // On the internal screen the +1 is inherited from the external one.
    let res = await send({ type: MSG.GET_POPUP_STATE, tabId: 11, windowId: 1 });
    assert.equal(res.ok, true);
    let r = res.result;
    assert.equal(r.enabled, true);
    assert.equal(r.screen.key, INT);
    assert.equal(r.screen.connected, true);
    assert.equal(r.screen.recommended, 1.0);
    assert.deepEqual([r.screen.width, r.screen.height], [1512, 982]);
    assert.equal(r.site.manageable, true);
    assert.equal(r.site.host, 'news.ycombinator.com');
    assert.equal(r.site.delta, 1);
    assert.equal(r.site.inherited, true);
    assert.equal(r.site.source, EXT);
    assert.equal(r.site.sourceName, 'LG UltraFine');
    assert.equal(r.site.expected, 1.1);
    assert.equal(r.screens.length, 2);
    assert.equal(r.screens[0].current, true);
    assert.deepEqual(r.screens.map((s) => s.recommended), [1.0, 1.25]);
    assert.equal(r.exceptionCount, 1, 'hosts with rows');

    // On the external screen it is the explicit row.
    res = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    r = res.result;
    assert.equal(r.screen.key, EXT);
    assert.equal(r.screen.recommended, 1.25);
    assert.equal(r.site.inherited, false);
    assert.equal(r.site.source, EXT);
    assert.equal(r.site.expected, 1.5);
  });

  test('GET_POPUP_STATE: recommended reflects learned overrides and disconnected profiles use their stored size', async () => {
    const local = onboardedLocal({ learnedDefaults: { '2560x1440': 1.5 } });
    local.screens['ext:office'] = { key: 'ext:office', name: 'Office', isInternal: false, width: 3840, height: 2160, zoomFactor: 1.25, lastSeenDisplayId: 'gone', createdAt: 5 };
    installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local, windows: [windowOn(DISPLAY_EXTERNAL, 2)], tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }] });
    const { result: r } = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(r.screen.recommended, 1.5, 'learned override for 2560×1440');
    const office = r.screens.find((s) => s.key === 'ext:office');
    assert.equal(office.connected, false);
    assert.equal(office.recommended, 1.5, '3840×2160 from the stored size');
  });

  test('GET_POPUP_STATE on a restricted page reports the site as unmanageable', async () => {
    installChromeMock({
      displays: [DISPLAY_INTERNAL],
      local: onboardedLocal(),
      windows: [windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [{ id: 11, windowId: 1, url: 'chrome://extensions/', active: true }],
    });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 11, windowId: 1 });
    assert.equal(res.result.site.manageable, false);
  });

  test('SET_SCREEN_ZOOM / SET_EXCLUDED / CLEAR_SITE_EXCEPTIONS through the router', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal({ siteStepDeltas: { 'example.com': deltaRows({ [EXT]: 1 }) } }),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });

    let res = await send({ type: MSG.SET_SCREEN_ZOOM, key: EXT, factor: 1.5 });
    assert.equal(res.ok, true);
    assert.equal(res.result.learned, true);
    await sleep(40);
    assert.equal(mock.zoomOf(22), 1.75, '150% screen + 1 step');
    assert.deepEqual((await storage.getState()).learnedDefaults, { '2560x1440': 1.5 });

    res = await send({ type: MSG.SET_EXCLUDED, host: 'example.com', excluded: true });
    assert.equal(res.ok, true);
    assert.equal(mock.scopeOf(22), 'per-origin');
    assert.deepEqual((await storage.getState()).siteStepDeltas, {}, 'excluding forgets the host\'s rows');
    res = await send({ type: MSG.SET_EXCLUDED, host: 'example.com', excluded: false });
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.zoomOf(22), 1.5, 'back at the screen default (no row left)');

    await storage.setSiteStepDelta('example.com', EXT, 2);
    await storage.setSiteStepDelta('other.example', INT, -1);
    res = await send({ type: MSG.CLEAR_SITE_EXCEPTIONS });
    assert.equal(res.ok, true);
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});
    assert.equal(mock.zoomOf(22), 1.5);
  });

  test('SET_ENABLED false freezes (zero release calls); SET_ENABLED true re-applies every tab', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal(),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 23, windowId: 2, url: 'https://example.org/', active: false },
      ],
    });
    await send({ type: MSG.SET_SCREEN_ZOOM, key: EXT, factor: 1.25 });
    await sleep(40);
    assert.equal(mock.scopeOf(23), 'per-tab');
    mock.resetCalls();

    let res = await send({ type: MSG.SET_ENABLED, enabled: false });
    assert.equal(res.result.enabled, false);
    assert.equal(mock.callsTo('tabs.setZoomSettings').length, 0);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0);
    assert.equal(mock.scopeOf(22), 'per-tab');
    assert.equal(mock.scopeOf(23), 'per-tab');
    assert.ok(mock.callsTo('action.setBadgeText').some((c) => c.args[0].tabId === 22 && c.args[0].text === 'OFF'));

    await mock.userZoom(23, 0.8); // drift while paused
    res = await send({ type: MSG.SET_ENABLED, enabled: true });
    assert.equal(res.result.enabled, true);
    assert.equal(mock.zoomOf(23), 1.25, 'background tab re-applied immediately');
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('REGRESSION A2: RELEASE_ALL releases every managed tab (≥1 setZoomSettings per-origin) and pauses', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal(),
      windows: [windowOn(DISPLAY_EXTERNAL, 2), windowOn(DISPLAY_INTERNAL, 1)],
      tabs: [
        { id: 22, windowId: 2, url: 'https://example.com/', active: true },
        { id: 23, windowId: 2, url: 'https://example.org/', active: false },
        { id: 11, windowId: 1, url: 'https://example.net/', active: true },
      ],
    });
    await send({ type: MSG.SET_ENABLED, enabled: true }); // manages every tab on both screens
    for (const id of [22, 23, 11]) assert.equal(mock.scopeOf(id), 'per-tab');
    mock.resetCalls();

    const res = await send({ type: MSG.RELEASE_ALL });
    assert.equal(res.ok, true);
    assert.equal(res.result.enabled, false);
    assert.equal(res.result.released, 3);
    const releases = mock.callsTo('tabs.setZoomSettings').filter((c) => c.args[1].scope === 'per-origin');
    assert.ok(releases.length >= 1, 'at least one per-origin setZoomSettings');
    assert.deepEqual(releases.map((c) => c.args[0]).sort(), [11, 22, 23]);
    for (const id of [22, 23, 11]) {
      assert.equal(mock.scopeOf(id), 'per-origin');
      assert.equal(mock.zoomOf(id), 1.0);
    }
    assert.equal((await storage.getState()).enabled, false);
    assert.equal(mock.hostZoom.size, 0, 'Chrome\'s per-origin memory never written');
  });

  test('RENAME_SCREEN trims / caps / reverts on empty; unknown key → ok:false; badge title refreshed on that screen', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal(),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 }); // resolves window 2 → EXT
    mock.resetCalls();

    let res = await send({ type: MSG.RENAME_SCREEN, key: EXT, name: '  Desk\n Monitor ' });
    assert.equal(res.ok, true);
    assert.equal(res.result.name, 'Desk Monitor');
    assert.equal((await storage.getState()).screens[EXT].name, 'Desk Monitor');
    assert.match(mock.callsTo('action.setTitle').at(-1).args[0].title, /^AutoZoom · Desk Monitor · 125%/);

    res = await send({ type: MSG.RENAME_SCREEN, key: EXT, name: 'x'.repeat(60) });
    assert.equal(res.result.name.length, 40);

    res = await send({ type: MSG.RENAME_SCREEN, key: EXT, name: '   ' });
    assert.equal(res.result.name, 'External Display', 'empty reverts to the auto name');

    res = await send({ type: MSG.RENAME_SCREEN, key: 'ext:nope', name: 'X' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown screen key/);
    assert.equal(mock.callsTo('tabs.setZoom').length, 0, 'renaming never zooms');
  });

  test('removed v2 messages (GET_SETUP_DATA, DISMISS_SETUP, OPEN_ONBOARDING, CLEAR_SITE_DELTA) return "Unknown message type"', async () => {
    const mock = installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: onboardedLocal(), windows: [windowOn(DISPLAY_EXTERNAL, 2)] });
    for (const type of ['GET_SETUP_DATA', 'DISMISS_SETUP', 'OPEN_ONBOARDING', 'CLEAR_SITE_DELTA', 'NOPE', undefined]) {
      const res = await send({ type, mode: 'onboarding', host: 'example.com' });
      assert.equal(res.ok, false, String(type));
      assert.match(res.error, /^Unknown message type: /);
    }
    assert.equal(mock.callsTo('windows.create').length, 0);
    assert.ok(!(MSG.GET_SETUP_DATA || MSG.OPEN_ONBOARDING || MSG.CLEAR_SITE_DELTA || MSG.DISMISS_SETUP), 'no constants left for them');
  });

  test('GET_POPUP_STATE tolerates a saved screen profile without a name', async () => {
    const local = onboardedLocal();
    local.screens['ext:2560x1440'] = { key: 'ext:2560x1440', isInternal: false, zoomFactor: 1.25 };
    local.screens['ext:zzz'] = { key: 'ext:zzz', name: undefined, isInternal: false, zoomFactor: 1.1 };
    installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local,
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.screens.length, 4);
    assert.equal(res.result.screens[0].key, EXT, 'current screen first');
    assert.equal(res.result.screens.find((s) => s.key === 'ext:zzz').recommended, 1.25, 'size-less external → fallback, never 100%');
  });

  test('SET_SCREEN_ZOOM with an unknown key fails cleanly (ok:false) and writes nothing', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: onboardedLocal() });
    const res = await send({ type: MSG.SET_SCREEN_ZOOM, key: 'ext:does-not-exist', factor: 1.5 });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown screen key/);
    assert.ok(!('ext:does-not-exist' in (await storage.getState()).screens));
    assert.deepEqual((await storage.getState()).learnedDefaults, {});
  });
});

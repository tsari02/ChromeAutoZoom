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
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import { handleMessage, EXTERNAL_DEFAULT_ROW } from '../src/background/message-router.js';
import { MSG, SETUP_MODE } from '../src/lib/constants.js';
import * as storage from '../src/lib/storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send a message through the real listener and resolve with the response. */
function send(message) {
  return new Promise((resolve) => {
    const keepOpen = handleMessage(message, { id: 'mock-extension-id' }, resolve);
    assert.equal(keepOpen, true, 'listener must return true for async responses');
  });
}

describe('message-router', () => {
  beforeEach(() => invalidateDisplays());

  test('GET_SETUP_DATA (onboarding, MacBook only) lists the built-in display plus the absent external class', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL], local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} } });
    const res = await send({ type: MSG.GET_SETUP_DATA, mode: SETUP_MODE.ONBOARDING });
    assert.equal(res.ok, true);
    const rows = res.result.rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.key), ['internal', EXTERNAL_DEFAULT_ROW]);
    assert.equal(rows[0].zoomFactor, 1.0);
    assert.equal(rows[1].zoomFactor, 1.25);
    assert.equal(rows[1].connected, false);
    assert.equal(res.result.ladder.length, 17);
  });

  test('GET_SETUP_DATA (onboarding, clamshell) lists externals plus the absent built-in row', async () => {
    installChromeMock({ displays: [DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2], local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} } });
    const res = await send({ type: MSG.GET_SETUP_DATA, mode: SETUP_MODE.ONBOARDING });
    const rows = res.result.rows;
    assert.deepEqual(rows.map((r) => r.key).sort(), ['ext:dell-u2723qe', 'ext:lg-ultrafine', 'internal']);
    assert.equal(rows.find((r) => r.key === 'internal').connected, false);
  });

  test('CONFIRM_SETUP responds immediately, completes onboarding and normalizes in the background', async () => {
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
    await send({ type: MSG.GET_SETUP_DATA, mode: SETUP_MODE.ONBOARDING });
    const res = await send({
      type: MSG.CONFIRM_SETUP,
      screens: { internal: 1.0, 'ext:lg-ultrafine': 1.5 },
      defaults: { internal: 1.0, external: 1.5 },
    });
    assert.equal(res.ok, true);
    const st = await storage.getState();
    assert.equal(st.onboardingCompleted, true);
    assert.equal(st.screens['ext:lg-ultrafine'].zoomFactor, 1.5);
    assert.equal(st.screens['ext:lg-ultrafine'].confirmed, true);
    await sleep(80); // background normalization
    assert.equal(mock.zoomOf(22), 1.5);
    assert.equal(mock.zoomOf(23), 1.5);
    assert.equal(mock.zoomOf(11), 1.0);
  });

  test('CONFIRM_SETUP maps the external-default row to defaults.external', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL], local: { ...onboardedLocal(), onboardingCompleted: false, screens: {} } });
    await send({ type: MSG.CONFIRM_SETUP, screens: { internal: 1.1, [EXTERNAL_DEFAULT_ROW]: 1.5 } });
    const st = await storage.getState();
    assert.deepEqual(st.defaults, { internal: 1.1, external: 1.5 });
    assert.equal(st.screens.internal.zoomFactor, 1.1);
    assert.ok(!(EXTERNAL_DEFAULT_ROW in st.screens));
  });

  test('GET_POPUP_STATE returns screen, site and saved screens for the active tab', async () => {
    installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal({ siteStepDeltas: { 'news.ycombinator.com': 1 } }),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://news.ycombinator.com/', active: true }],
    });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(res.ok, true);
    const r = res.result;
    assert.equal(r.enabled, true);
    assert.equal(r.screen.key, 'ext:lg-ultrafine');
    assert.equal(r.screen.connected, true);
    assert.equal(r.site.manageable, true);
    assert.equal(r.site.host, 'news.ycombinator.com');
    assert.equal(r.site.delta, 1);
    assert.equal(r.site.expected, 1.5);
    assert.equal(r.screens.length, 2);
    assert.equal(r.screens[0].current, true);
    assert.equal(r.exceptionCount, 1);
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

  test('SET_ENABLED / SET_SCREEN_ZOOM / SET_EXCLUDED / CLEAR_SITE_DELTA / CLEAR_SITE_EXCEPTIONS / RELEASE_ALL', async () => {
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal({ siteStepDeltas: { 'example.com': 1 } }),
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });

    let res = await send({ type: MSG.SET_SCREEN_ZOOM, key: 'ext:lg-ultrafine', factor: 1.5 });
    assert.equal(res.ok, true);
    await sleep(40);
    assert.equal(mock.zoomOf(22), 1.75, '150% screen + 1 step');

    res = await send({ type: MSG.CLEAR_SITE_DELTA, host: 'example.com' });
    assert.equal(res.ok, true);
    assert.equal(mock.zoomOf(22), 1.5);

    res = await send({ type: MSG.SET_EXCLUDED, host: 'example.com', excluded: true });
    assert.equal(res.ok, true);
    assert.equal(mock.scopeOf(22), 'per-origin');
    res = await send({ type: MSG.SET_EXCLUDED, host: 'example.com', excluded: false });
    assert.equal(mock.scopeOf(22), 'per-tab');

    res = await send({ type: MSG.SET_ENABLED, enabled: false });
    assert.equal(res.result.enabled, false);
    assert.equal(mock.scopeOf(22), 'per-origin');
    res = await send({ type: MSG.SET_ENABLED, enabled: true });
    assert.equal(mock.scopeOf(22), 'per-tab');

    await storage.setSiteStepDelta('example.com', 2);
    res = await send({ type: MSG.CLEAR_SITE_EXCEPTIONS });
    assert.equal(res.ok, true);
    assert.deepEqual((await storage.getState()).siteStepDeltas, {});

    res = await send({ type: MSG.RELEASE_ALL });
    assert.equal(res.ok, true);
    assert.equal((await storage.getState()).enabled, false);
    assert.equal(mock.scopeOf(22), 'per-origin');
    assert.equal(mock.hostZoom.size, 0);
  });

  test('OPEN_ONBOARDING falls back to the primary display when no normal window exists', async () => {
    const mock = installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: onboardedLocal(), windows: [] });
    const a = await send({ type: MSG.OPEN_ONBOARDING });
    assert.equal(a.ok, true);
    const { left } = mock.callsTo('windows.create')[0].args[0];
    const wa = DISPLAY_INTERNAL.workArea;
    assert.ok(left >= wa.left && left < wa.left + wa.width, 'opened on the primary (built-in) display');
  });

  test('GET_POPUP_STATE tolerates a saved screen profile without a name', async () => {
    const local = onboardedLocal();
    local.screens['ext:2560x1440'] = { key: 'ext:2560x1440', isInternal: false, zoomFactor: 1.25, confirmed: true };
    local.screens['ext:zzz'] = { key: 'ext:zzz', name: undefined, isInternal: false, zoomFactor: 1.1, confirmed: true };
    installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local,
      windows: [windowOn(DISPLAY_EXTERNAL, 2)],
      tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
    });
    const res = await send({ type: MSG.GET_POPUP_STATE, tabId: 22, windowId: 2 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.screens.length, 4);
    assert.equal(res.result.screens[0].key, 'ext:lg-ultrafine', 'current screen first');
  });

  test('SET_SCREEN_ZOOM with an unknown key fails cleanly (ok:false) and writes nothing', async () => {
    installChromeMock({ displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL], local: onboardedLocal() });
    const res = await send({ type: MSG.SET_SCREEN_ZOOM, key: 'ext:does-not-exist', factor: 1.5 });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown screen key/);
    assert.ok(!('ext:does-not-exist' in (await storage.getState()).screens));
  });

  test('OPEN_ONBOARDING opens exactly one setup window (even when requested concurrently) on the display of the last-focused normal window', async () => {
    // Chrome's window is on the external display; primary is the built-in one.
    const mock = installChromeMock({
      displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
      local: onboardedLocal(),
      windows: [windowOn(DISPLAY_INTERNAL, 1), windowOn(DISPLAY_EXTERNAL, 2, { focused: true })],
    });
    const [a, b, c] = await Promise.all([
      send({ type: MSG.OPEN_ONBOARDING }),
      send({ type: MSG.OPEN_ONBOARDING }),
      send({ type: MSG.OPEN_ONBOARDING }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(a.result.windowId, b.result.windowId);
    assert.equal(a.result.windowId, c.result.windowId);
    const creates = mock.callsTo('windows.create');
    assert.equal(creates.length, 1);
    assert.match(creates[0].args[0].url, /mode=onboarding/);
    const wa = DISPLAY_EXTERNAL.workArea;
    const { left, top, width, height } = creates[0].args[0];
    assert.ok(left >= wa.left && left + width <= wa.left + wa.width, `left=${left} not on the external display`);
    assert.ok(top >= wa.top && top + height <= wa.top + wa.height, `top=${top} not on the external display`);

    const again = await send({ type: MSG.OPEN_ONBOARDING });
    assert.equal(again.result.windowId, a.result.windowId);
    assert.equal(mock.callsTo('windows.create').length, 1);

    const bad = await send({ type: 'NOPE' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Unknown message type/);
  });
});

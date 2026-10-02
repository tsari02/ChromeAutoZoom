import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './_chrome-mock.js';
import * as storage from '../src/lib/storage.js';
import { SCHEMA_VERSION } from '../src/lib/constants.js';

describe('storage', () => {
  beforeEach(() => installChromeMock());

  test('getState returns defaults on an empty store', async () => {
    const s = await storage.getState();
    assert.equal(s.schemaVersion, SCHEMA_VERSION);
    assert.equal(s.enabled, true);
    assert.equal(s.onboardingCompleted, false);
    assert.deepEqual(s.defaults, { internal: 1.0, external: 1.25 });
    assert.deepEqual(s.screens, {});
    assert.deepEqual(s.siteStepDeltas, {});
    assert.deepEqual(s.excludedHosts, {});
  });

  test('initState writes defaults only for missing keys', async () => {
    const mock = installChromeMock({ local: { enabled: false } });
    await storage.initState();
    const dump = mock.chrome.storage.local._dump();
    assert.equal(dump.enabled, false);
    assert.equal(dump.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(dump.defaults, { internal: 1.0, external: 1.25 });
  });

  test('setSiteStepDelta writes integers and removes on 0', async () => {
    await storage.setSiteStepDelta('a.com', 2);
    await storage.setSiteStepDelta('b.com', -1);
    assert.deepEqual((await storage.getState()).siteStepDeltas, { 'a.com': 2, 'b.com': -1 });
    await storage.setSiteStepDelta('a.com', 0);
    assert.deepEqual((await storage.getState()).siteStepDeltas, { 'b.com': -1 });
    await storage.setSiteStepDelta('', 3); // ignored
    assert.deepEqual((await storage.getState()).siteStepDeltas, { 'b.com': -1 });
  });

  test('setExcludedHost toggles a record (not an array)', async () => {
    await storage.setExcludedHost('www.figma.com', true);
    assert.deepEqual((await storage.getState()).excludedHosts, { 'www.figma.com': true });
    await storage.setExcludedHost('www.figma.com', false);
    assert.deepEqual((await storage.getState()).excludedHosts, {});
  });

  test('concurrent storage.local read-modify-writes never lose an update (serialized queue)', async () => {
    const mock = installChromeMock({ local: { siteStepDeltas: { 'keep.example': 3 } } });
    // Two Cmd+ events on different hosts land in the same tick.
    await Promise.all([
      storage.setSiteStepDelta('a.example', 1),
      storage.setSiteStepDelta('b.example', -1),
    ]);
    assert.deepEqual(mock.chrome.storage.local._dump().siteStepDeltas, {
      'keep.example': 3,
      'a.example': 1,
      'b.example': -1,
    });

    // Mixed RMWs across keys, plus a whole-key patch, all concurrently.
    await Promise.all([
      storage.setExcludedHost('x.example', true),
      storage.setExcludedHost('y.example', true),
      storage.upsertScreen('ext:a', { zoomFactor: 1.5 }),
      storage.upsertScreen('ext:a', { lastSeenDisplayId: '9' }),
      storage.upsertScreen('ext:b', { zoomFactor: 1.1 }),
      storage.setSiteStepDelta('a.example', 0),
    ]);
    const dump = mock.chrome.storage.local._dump();
    assert.deepEqual(dump.excludedHosts, { 'x.example': true, 'y.example': true });
    assert.deepEqual(dump.screens['ext:a'], { key: 'ext:a', zoomFactor: 1.5, lastSeenDisplayId: '9' });
    assert.equal(dump.screens['ext:b'].zoomFactor, 1.1);
    assert.deepEqual(dump.siteStepDeltas, { 'keep.example': 3, 'b.example': -1 });

    // The popup's zoom choice survives a concurrent lastSeenDisplayId upsert
    // (resyncAllWindows) — the exact race the auditor reproduced.
    await Promise.all([
      storage.upsertScreen('ext:a', { zoomFactor: 2.0, confirmed: true }),
      storage.upsertScreen('ext:a', { lastSeenDisplayId: '10' }),
      storage.updateScreens((screens) => ({ ...screens, 'ext:c': { key: 'ext:c', zoomFactor: 1.25 } })),
    ]);
    const after = mock.chrome.storage.local._dump().screens;
    assert.equal(after['ext:a'].zoomFactor, 2.0);
    assert.equal(after['ext:a'].lastSeenDisplayId, '10');
    assert.equal(after['ext:a'].confirmed, true);
    assert.equal(after['ext:c'].zoomFactor, 1.25);
  });

  test('updateState passes fresh state, writes the returned partial, and skips empty results', async () => {
    const mock = installChromeMock({ local: { enabled: true } });
    const seen = [];
    const out = await storage.updateState((st) => {
      seen.push(st.enabled);
      return { enabled: false };
    });
    assert.deepEqual(seen, [true]);
    assert.equal(out.enabled, false);
    assert.equal(mock.chrome.storage.local._dump().enabled, false);
    const sets = mock.chrome.storage.local._dump();
    await storage.updateState(() => null);
    assert.deepEqual(mock.chrome.storage.local._dump(), sets, 'null result writes nothing');
  });

  test('upsertScreen merges and preserves the key', async () => {
    await storage.upsertScreen('ext:x', { name: 'X', isInternal: false, zoomFactor: 1.25, confirmed: false });
    const s = await storage.upsertScreen('ext:x', { zoomFactor: 1.5, confirmed: true, key: 'wrong' });
    assert.deepEqual(s, { key: 'ext:x', name: 'X', isInternal: false, zoomFactor: 1.5, confirmed: true });
  });

  test('session helpers: windowScreen map, setupWindowId, pendingSetupKeys (serialized writes)', async () => {
    await Promise.all([
      storage.setWindowScreen(1, 'internal'),
      storage.setWindowScreen(2, 'ext:a'),
      storage.setWindowScreen(3, 'ext:b'),
    ]);
    assert.deepEqual((await storage.getSession()).windowScreen, { 1: 'internal', 2: 'ext:a', 3: 'ext:b' });
    await storage.deleteWindowScreen(2);
    assert.equal(await storage.getWindowScreen(2), null);
    assert.equal(await storage.getWindowScreen(3), 'ext:b');

    await storage.setSetupWindowId(77);
    assert.equal((await storage.getSession()).setupWindowId, 77);
    await storage.setSetupWindowId(null);
    assert.equal((await storage.getSession()).setupWindowId, null);

    assert.equal(await storage.addPendingSetupKey('ext:a'), true);
    assert.equal(await storage.addPendingSetupKey('ext:a'), false);
    await storage.addPendingSetupKey('ext:b');
    assert.deepEqual((await storage.getSession()).pendingSetupKeys, ['ext:a', 'ext:b']);
    await storage.clearPendingSetupKeys();
    assert.deepEqual((await storage.getSession()).pendingSetupKeys, []);
  });

  test('migrate converts the v1 PRD schema to v2', async () => {
    const mock = installChromeMock({
      local: {
        enabled: true,
        onboardingCompleted: true,
        defaultInternalZoom: 1.0,
        defaultExternalZoom: 1.5,
        screens: {
          internal_builtin: { id: 'internal_builtin', name: 'Built-in Retina Display', isInternal: true, zoomFactor: 1.0, confirmed: true },
          'ext_LG UltraFine_3840x2160': { id: 'ext_LG UltraFine_3840x2160', name: 'LG UltraFine', isInternal: false, zoomFactor: 1.5, confirmed: true },
        },
        siteStepDeltas: { 'https://news.ycombinator.com': 1, 'https://zero.example.com': 0 },
        excludedOrigins: ['https://www.figma.com', 'https://docs.google.com'],
      },
    });
    const r = await storage.migrate();
    assert.deepEqual(r, { from: 1, to: SCHEMA_VERSION, migrated: true });
    const s = await storage.getState();
    assert.deepEqual(s.defaults, { internal: 1.0, external: 1.5 });
    assert.equal(s.screens.internal.isInternal, true);
    assert.equal(s.screens['ext_LG UltraFine_3840x2160'].zoomFactor, 1.5);
    assert.deepEqual(s.siteStepDeltas, { 'news.ycombinator.com': 1 });
    assert.deepEqual(s.excludedHosts, { 'www.figma.com': true, 'docs.google.com': true });
    const dump = mock.chrome.storage.local._dump();
    assert.ok(!('excludedOrigins' in dump));
    assert.ok(!('defaultExternalZoom' in dump));
  });

  test('migrate on a current-schema store is a no-op', async () => {
    installChromeMock({ local: { schemaVersion: SCHEMA_VERSION, enabled: false } });
    const r = await storage.migrate();
    assert.equal(r.migrated, false);
    assert.equal((await storage.getState()).enabled, false);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, DISPLAY_INTERNAL, DISPLAY_EXTERNAL, windowOn, onboardedLocal } from './_chrome-mock.js';
import { invalidate as invalidateDisplays } from '../src/lib/display-cache.js';
import * as scheduler from '../src/background/sync-scheduler.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const mock = installChromeMock({
    displays: [DISPLAY_INTERNAL, DISPLAY_EXTERNAL],
    local: onboardedLocal(),
    windows: [windowOn(DISPLAY_EXTERNAL, 2)],
    tabs: [{ id: 22, windowId: 2, url: 'https://example.com/', active: true }],
  });
  invalidateDisplays();
  return mock;
}

describe('sync-scheduler', () => {
  test('focus requests are single-flight with at most one trailing re-run', async () => {
    const mock = fixture();
    for (let i = 0; i < 10; i++) scheduler.request(2, 'focus');
    await sleep(50);
    const gets = mock.callsTo('windows.get').filter((c) => c.args[0] === 2);
    assert.ok(gets.length >= 1 && gets.length <= 2, `syncWindow ran ${gets.length} times`);
    assert.equal(mock.zoomOf(22), 1.25);
  });

  test('bounds requests are debounced (150 ms) into one sync', async () => {
    const mock = fixture();
    for (let i = 0; i < 20; i++) {
      scheduler.request(2, 'bounds');
      await sleep(5);
    }
    assert.equal(mock.callsTo('windows.get').length, 0, 'nothing ran during the burst');
    await sleep(220);
    assert.equal(mock.callsTo('windows.get').filter((c) => c.args[0] === 2).length, 1);
  });

  test('forget() cancels a pending debounce; invalid ids are ignored', async () => {
    const mock = fixture();
    scheduler.request(2, 'bounds');
    scheduler.forget(2);
    scheduler.request(-1, 'focus');
    scheduler.request(undefined, 'focus');
    await sleep(220);
    assert.equal(mock.callsTo('windows.get').length, 0);
  });

  test('a sync failure is caught, logged, and releases the window slot for the next request', async () => {
    const mock = fixture();
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
      // storage.getState throwing propagates out of syncWindow (safeCall does not wrap it).
      const realGet = mock.chrome.storage.local.get;
      mock.chrome.storage.local.get = async () => {
        throw new Error('boom');
      };
      scheduler.request(2, 'focus');
      await sleep(20);
      assert.equal(unhandled.length, 0, 'no unhandled rejection escaped');
      assert.ok(
        warnings.some((w) => w.includes('syncWindow failed') && w.includes('boom')),
        `expected a "syncWindow failed … boom" warning, got: ${JSON.stringify(warnings)}`,
      );
      assert.equal(mock.zoomOf(22), 1.0, 'nothing was zoomed by the failed run');

      // The in-flight slot was released: a later request runs to completion.
      mock.chrome.storage.local.get = realGet;
      scheduler.request(2, 'focus');
      await sleep(30);
      assert.equal(mock.zoomOf(22), 1.25, 'next request after a failure succeeds');
    } finally {
      console.warn = origWarn;
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

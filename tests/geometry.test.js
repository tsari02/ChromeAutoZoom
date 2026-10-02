import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDisplay,
  windowCenter,
  intersectionArea,
  distanceToRect,
  containsPoint,
  centeredRect,
} from '../src/lib/geometry.js';
import { DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2, windowOn } from './_chrome-mock.js';

const displays = [DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2];

describe('geometry', () => {
  test('windowCenter / containsPoint / intersectionArea / distanceToRect basics', () => {
    const win = { left: 100, top: 100, width: 200, height: 100 };
    assert.deepEqual(windowCenter(win), { x: 200, y: 150 });
    assert.ok(containsPoint(DISPLAY_INTERNAL.bounds, { x: 200, y: 150 }));
    assert.ok(!containsPoint(DISPLAY_INTERNAL.bounds, { x: 1512, y: 150 })); // half-open far edge
    assert.equal(intersectionArea(win, { left: 200, top: 100, width: 500, height: 500 }), 100 * 100);
    assert.equal(intersectionArea(win, { left: 400, top: 400, width: 10, height: 10 }), 0);
    assert.equal(distanceToRect({ x: 200, y: 150 }, DISPLAY_INTERNAL.bounds), 0);
    assert.equal(distanceToRect({ x: 1612, y: 150 }, DISPLAY_INTERNAL.bounds), 100);
  });

  test('center containment wins → confidence "center"', () => {
    const r = resolveDisplay(windowOn(DISPLAY_EXTERNAL, 1), displays);
    assert.equal(r.display.id, DISPLAY_EXTERNAL.id);
    assert.equal(r.confidence, 'center');
  });

  test('window straddling two displays uses center containment first', () => {
    // Center at x = 1522 → external, even though most of the area is on internal.
    const straddle = { left: 1522 - 1000, top: 100, width: 2000, height: 500, state: 'normal' };
    const r = resolveDisplay(straddle, displays);
    assert.equal(r.confidence, 'center');
    assert.equal(r.display.id, DISPLAY_EXTERNAL.id);
  });

  test('largest overlap is chosen when centers miss', () => {
    const gapDisplays = [
      { id: 'a', bounds: { left: 0, top: 0, width: 1000, height: 1000 } },
      { id: 'b', bounds: { left: 0, top: 1200, width: 1000, height: 1000 } },
    ];
    const inGap = { left: 0, top: 950, width: 1000, height: 300, state: 'normal' }; // center 1100; 50px on a, 50px on b
    const more = { left: 0, top: 980, width: 1000, height: 300, state: 'normal' }; // center 1130; 20px on a, 80px on b
    assert.equal(resolveDisplay(more, gapDisplays).display.id, 'b');
    assert.equal(resolveDisplay(inGap, gapDisplays).confidence, 'overlap');
  });

  test('stale bounds after unplug → nearest display by center-to-rect distance', () => {
    const win = windowOn(DISPLAY_EXTERNAL_2, 9); // sits on the far-right monitor
    const stillConnected = [DISPLAY_INTERNAL, DISPLAY_EXTERNAL];
    const r = resolveDisplay(win, stillConnected);
    assert.equal(r.confidence, 'nearest');
    assert.equal(r.display.id, DISPLAY_EXTERNAL.id);
  });

  test('minimized windows and windows without coordinates return null (never snap to primary)', () => {
    assert.equal(resolveDisplay({ ...windowOn(DISPLAY_EXTERNAL, 1), state: 'minimized' }, displays), null);
    assert.equal(resolveDisplay({ id: 3, state: 'normal' }, displays), null);
    assert.equal(resolveDisplay(windowOn(DISPLAY_EXTERNAL, 1), []), null);
    assert.equal(resolveDisplay(null, displays), null);
  });

  test('centeredRect centers and clamps within bounds', () => {
    const r = centeredRect({ left: 1000, top: 0, width: 2000, height: 1000 }, 420, 400);
    assert.deepEqual(r, { left: 1790, top: 300, width: 420, height: 400 });
    const small = centeredRect({ left: 0, top: 0, width: 300, height: 200 }, 420, 400);
    assert.deepEqual(small, { left: 0, top: 0, width: 300, height: 200 });
  });
});

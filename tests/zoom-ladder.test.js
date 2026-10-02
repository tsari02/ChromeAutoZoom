import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM_LADDER,
  STEP_100,
  nearestStepIndex,
  factorAtStep,
  expectedZoom,
  isSameZoom,
  isLadderValue,
  stepDelta,
  clampStep,
  formatPercent,
  formatDelta,
} from '../src/lib/zoom-ladder.js';

describe('zoom-ladder', () => {
  test('ladder is Chrome\'s 17-step scale with 100% at index 7 and 125% at index 9', () => {
    assert.equal(ZOOM_LADDER.length, 17);
    assert.equal(ZOOM_LADDER[STEP_100], 1.0);
    assert.equal(ZOOM_LADDER[9], 1.25);
    assert.equal(ZOOM_LADDER[0], 0.25);
    assert.equal(ZOOM_LADDER[16], 5.0);
  });

  test('nearestStepIndex maps exact rungs and arbitrary factors by absolute difference', () => {
    assert.equal(nearestStepIndex(1.0), 7);
    assert.equal(nearestStepIndex(1.25), 9);
    assert.equal(nearestStepIndex(1.33), 9); // pre-install 133% → 125%
    assert.equal(nearestStepIndex(1.4), 10); // closer to 150 than 125
    assert.equal(nearestStepIndex(0.1), 0);
    assert.equal(nearestStepIndex(9), 16);
    assert.equal(nearestStepIndex(NaN), STEP_100);
    assert.equal(nearestStepIndex(-1), STEP_100);
  });

  test('factorAtStep clamps to the ladder', () => {
    assert.equal(factorAtStep(-5), 0.25);
    assert.equal(factorAtStep(99), 5.0);
    assert.equal(factorAtStep(8), 1.1);
    assert.equal(clampStep(3.6), 4);
  });

  test('expectedZoom shifts the screen rung by the delta', () => {
    assert.equal(expectedZoom(1.25, 0), 1.25);
    assert.equal(expectedZoom(1.25, 1), 1.5);
    assert.equal(expectedZoom(1.0, 1), 1.1);
    assert.equal(expectedZoom(1.0, -2), 0.8);
    assert.equal(expectedZoom(1.0, 2), 1.25);
    assert.equal(expectedZoom(5.0, 3), 5.0); // clamped
    assert.equal(expectedZoom(1.25), 1.25); // default delta
  });

  test('stepDelta is the signed rung distance', () => {
    assert.equal(stepDelta(1.5, 1.25), 1);
    assert.equal(stepDelta(1.0, 1.25), -2); // Cmd+0 on a 125% screen → −2 (R5)
    assert.equal(stepDelta(1.25, 1.25), 0);
    assert.equal(stepDelta(1.1, 1.0), 1);
  });

  test('isSameZoom uses ε = 0.005 only for equality', () => {
    assert.ok(isSameZoom(1.25, 1.2501));
    assert.ok(isSameZoom(1.0, 1.0049));
    assert.ok(!isSameZoom(1.0, 1.006));
    assert.ok(!isSameZoom(1.25, 1.1));
    assert.ok(isLadderValue(1.1));
    assert.ok(!isLadderValue(1.33));
  });

  test('formatting helpers', () => {
    assert.equal(formatPercent(1.25), '125%');
    assert.equal(formatPercent(0.67), '67%');
    assert.equal(formatDelta(0), '');
    assert.equal(formatDelta(1), '+1 step');
    assert.equal(formatDelta(-2), '−2 steps');
  });
});

// zoom-map.js — resolution → recommended zoom (engineering doc v3 §4, §10) and
// the A1 / A4 regressions from the pitfalls review. Pure; no chrome mock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedZoom, sizeKey, isSizeKey, withLearnedDefault } from '../src/lib/zoom-map.js';
import { RECOMMENDED_ZOOM } from '../src/lib/constants.js';
import {
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_4K,
  DISPLAY_EXTERNAL_1080P,
  DISPLAY_NAMELESS_QHD,
} from './_chrome-mock.js';

/** Raw chrome.system.display shape: size lives under `bounds`, not top-level. */
const display = (width, height, extra = {}) => ({
  id: `${width}x${height}`,
  name: '',
  isInternal: false,
  bounds: { left: 0, top: 0, width, height },
  ...extra,
});

/** Stored screen profile shape: top-level width / height. */
const profile = (width, height, extra = {}) => ({ key: 'ext:x', isInternal: false, width, height, ...extra });

describe('zoom-map — §10 table', () => {
  test('internal → 1.0 regardless of size', () => {
    assert.equal(recommendedZoom(DISPLAY_INTERNAL), 1.0);
    assert.equal(recommendedZoom(display(3840, 2160, { isInternal: true })), 1.0);
    assert.equal(recommendedZoom(profile(5120, 2880, { isInternal: true })), 1.0);
    assert.equal(recommendedZoom({ isInternal: true }), 1.0, 'internal with no size at all');
  });

  test('1920×1080 → 1.0 (and anything ≤ 1920×1200)', () => {
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_1080P), 1.0);
    assert.equal(recommendedZoom(display(1920, 1200)), 1.0);
    assert.equal(recommendedZoom(display(1680, 1050)), 1.0);
    assert.equal(recommendedZoom(profile(1920, 1080)), 1.0);
  });

  test('2560×1440 → 1.25', () => {
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL), 1.25);
    assert.equal(recommendedZoom(DISPLAY_NAMELESS_QHD), 1.25);
    assert.equal(recommendedZoom(profile(2560, 1440)), 1.25);
  });

  test('2560×1080 → 1.1', () => {
    assert.equal(recommendedZoom(display(2560, 1080)), 1.1);
    assert.equal(recommendedZoom(profile(2560, 1080)), 1.1);
  });

  test('3840×2160 → 1.5', () => {
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K), 1.5);
    assert.equal(recommendedZoom(profile(3840, 2160)), 1.5);
  });

  test('5120×2880 → 2.0', () => {
    assert.equal(recommendedZoom(display(5120, 2880)), 2.0);
    assert.equal(recommendedZoom(profile(5120, 2880)), 2.0);
  });

  test('unknown 3440×1440 → 1.25 (fallback), as do the other wide/odd sizes', () => {
    for (const [w, h] of [
      [3440, 1440],
      [2560, 1600],
      [3008, 1692],
      [3840, 1600],
      [5120, 1440],
      [2048, 1152],
    ]) {
      assert.equal(recommendedZoom(display(w, h)), 1.25, `${w}x${h}`);
    }
  });

  test('learned override wins over the table', () => {
    const learned = { '3840x2160': 1.25, '2560x1440': 1.1, '1920x1080': 1.25 };
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K, learned), 1.25, 'table 1.5 overridden');
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL, learned), 1.1, 'fallback 1.25 overridden');
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_1080P, learned), 1.25, 'small-monitor rule overridden');
    assert.equal(recommendedZoom(profile(2560, 1440), learned), 1.1, 'profile shape too');
    assert.equal(recommendedZoom(display(3440, 1440), learned), 1.25, 'sizes not learned are untouched');
  });

  test('learned never applies to internal', () => {
    const learned = { '1512x982': 1.5, '3840x2160': 1.75 };
    assert.equal(recommendedZoom(DISPLAY_INTERNAL, learned), 1.0);
    assert.equal(recommendedZoom(display(3840, 2160, { isInternal: true }), learned), 1.0);
    assert.equal(recommendedZoom(profile(1512, 982, { isInternal: true }), learned), 1.0);
  });

  test('malformed learned values are ignored (negative, zero, NaN, string)', () => {
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K, { '3840x2160': 0 }), 1.5);
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K, { '3840x2160': -1 }), 1.5);
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K, { '3840x2160': 'big' }), 1.5);
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K, null), 1.5);
  });
});

describe('zoom-map — REGRESSION A1: raw displays, missing sizes, class detection', () => {
  test('a raw chrome.system.display entry (size under `bounds`) is classified by its real size — 4K is 150%, not the 125% fallback', () => {
    // The naïve sketch read top-level width/height → "NaNxNaN" → fallback for EVERY monitor.
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_4K), 1.5);
    assert.equal(recommendedZoom(display(2560, 1080)), 1.1);
    assert.equal(recommendedZoom(DISPLAY_EXTERNAL_1080P), 1.0);
    assert.equal(sizeKey(DISPLAY_EXTERNAL_4K), '3840x2160');
    assert.equal(sizeKey(DISPLAY_EXTERNAL), '2560x1440');
  });

  test('a stored profile with top-level width/height resolves the same as its display', () => {
    assert.equal(recommendedZoom(profile(3840, 2160)), recommendedZoom(DISPLAY_EXTERNAL_4K));
    assert.equal(recommendedZoom(profile(1920, 1080)), recommendedZoom(DISPLAY_EXTERNAL_1080P));
    assert.equal(sizeKey(profile(2560, 1440)), sizeKey(DISPLAY_EXTERNAL));
  });

  test('null / 0 / missing / NaN size on an external → external fallback (125%), never the ≤1920 → 100% rule', () => {
    // `null <= 1920` is true in JS: the naïve sketch recommended 100% for v2-migrated profiles.
    assert.equal(recommendedZoom(profile(null, null)), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(profile(undefined, undefined)), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(profile(0, 0)), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(profile(NaN, 1440)), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(profile(2560, -1)), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom({ key: 'ext:x', isInternal: false }), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom({ id: '9', name: '', isInternal: false }), RECOMMENDED_ZOOM.externalFallback, 'display without bounds');
    assert.equal(recommendedZoom({ id: '9', name: '', isInternal: false, bounds: {} }), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(null), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(undefined), RECOMMENDED_ZOOM.externalFallback);
  });

  test('a learned entry under a bogus key can never match a real screen (unknown size has no key)', () => {
    const poisoned = { '0x0': 1.1, NaNxNaN: 1.1, nullxnull: 1.1 };
    assert.equal(recommendedZoom(profile(null, null), poisoned), RECOMMENDED_ZOOM.externalFallback);
    assert.equal(recommendedZoom(profile(0, 0), poisoned), RECOMMENDED_ZOOM.externalFallback);
  });

  test('sizeKey never yields NaN or 0x0', () => {
    for (const bad of [
      profile(null, null),
      profile(undefined, undefined),
      profile(0, 0),
      profile(NaN, NaN),
      profile(-2560, 1440),
      profile('2560', null),
      { bounds: {} },
      { bounds: null },
      {},
      null,
      undefined,
      42,
    ]) {
      const k = sizeKey(bad);
      assert.equal(k, null, `sizeKey(${JSON.stringify(bad)}) → ${k}`);
    }
    assert.equal(sizeKey(profile('2560', '1440')), '2560x1440', 'numeric strings are accepted');
    assert.equal(sizeKey(profile(2559.6, 1439.5)), '2560x1440', 'rounded to integers');
  });

  test('class detection uses isInternalDisplay(): a built-in panel mislabelled isInternal:false is still 1.0', () => {
    const builtInByName = display(3024, 1964, { isInternal: false, name: 'Built-in Retina Display' });
    assert.equal(recommendedZoom(builtInByName), 1.0);
    assert.equal(recommendedZoom(display(3840, 2160, { isInternal: false, name: 'Color LCD' })), 1.0);
    assert.equal(recommendedZoom(display(3024, 1964, { isInternal: false, name: 'Liquid Retina XDR Display' })), 1.0);
    // …but the heuristic does not fire on ordinary external names.
    assert.equal(recommendedZoom(display(3840, 2160, { isInternal: false, name: 'LG HDR 4K' })), 1.5);
  });
});

describe('zoom-map — REGRESSION A4: learned-default keys must have positive dimensions', () => {
  test('isSizeKey accepts only positive WxH', () => {
    assert.ok(isSizeKey('2560x1440'));
    assert.ok(isSizeKey('1x1'));
    for (const bad of ['0x0', 'NaNxNaN', 'nullxnull', '2560x0', '0x1440', '2560×1440', '2560x1440x1', '', null, undefined, 2560, '-1x-1']) {
      assert.equal(isSizeKey(bad), false, `isSizeKey(${String(bad)})`);
    }
  });

  test('withLearnedDefault refuses malformed keys and factors, returns the input untouched', () => {
    const before = Object.freeze({ '2560x1440': 1.1 });
    for (const [k, f] of [
      ['0x0', 1.25],
      ['NaNxNaN', 1.25],
      [null, 1.25],
      [undefined, 1.25],
      ['3840x2160', 0],
      ['3840x2160', -1],
      ['3840x2160', NaN],
      ['3840x2160', 'x'],
    ]) {
      assert.equal(withLearnedDefault(before, k, f), before, `${String(k)} → ${String(f)} must be refused`);
    }
    assert.deepEqual(withLearnedDefault(before, '3840x2160', 1.25), { '2560x1440': 1.1, '3840x2160': 1.25 });
    assert.deepEqual(withLearnedDefault(undefined, '3840x2160', 1.25), { '3840x2160': 1.25 });
    // The key of a profile with unknown size is null → refused (the migration + Accept path, A4).
    assert.deepEqual(withLearnedDefault({}, sizeKey(profile(null, null)), 1.5), {});
  });
});

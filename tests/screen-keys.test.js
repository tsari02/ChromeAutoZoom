import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  slug,
  resolutionTag,
  externalKeyBase,
  buildKey,
  matchSavedScreen,
  isInternalDisplay,
  displayLabel,
  newScreenProfile,
  dimensionsOf,
  defaultScreenName,
  profileRefreshPatch,
} from '../src/lib/screen-keys.js';
import {
  DISPLAY_INTERNAL,
  DISPLAY_EXTERNAL,
  DISPLAY_EXTERNAL_2,
  DISPLAY_EXTERNAL_4K,
  DISPLAY_NAMELESS_QHD,
  onboardedLocal,
} from './_chrome-mock.js';

describe('screen-keys', () => {
  test('slug normalizes names', () => {
    assert.equal(slug('LG UltraFine'), 'lg-ultrafine');
    assert.equal(slug('DELL U2723QE'), 'dell-u2723qe');
    assert.equal(slug('  Weird  (Name) #1 '), 'weird-name-1');
    assert.equal(slug(''), '');
    assert.equal(slug('   '), '');
  });

  test('isInternalDisplay honours the flag and known built-in names', () => {
    assert.ok(isInternalDisplay(DISPLAY_INTERNAL));
    assert.ok(isInternalDisplay({ id: 'x', name: 'Color LCD', isInternal: false }));
    assert.ok(isInternalDisplay({ id: 'x', name: 'Liquid Retina XDR Display', isInternal: false }));
    assert.ok(!isInternalDisplay(DISPLAY_EXTERNAL));
  });

  test('buildKey: internal → "internal"; external → "ext:<slug>"; resolution is not part of the key', () => {
    const siblings = [DISPLAY_INTERNAL, DISPLAY_EXTERNAL];
    assert.equal(buildKey(DISPLAY_INTERNAL, siblings), 'internal');
    assert.equal(buildKey(DISPLAY_EXTERNAL, siblings), 'ext:lg-ultrafine');
    const rescaled = { ...DISPLAY_EXTERNAL, bounds: { left: 1512, top: 0, width: 1920, height: 1080 } };
    assert.equal(buildKey(rescaled, [DISPLAY_INTERNAL, rescaled]), 'ext:lg-ultrafine');
  });

  test('buildKey suffixes identical monitors #2, #3 by ascending id', () => {
    const a = { ...DISPLAY_EXTERNAL_2, id: '300' };
    const b = { ...DISPLAY_EXTERNAL_2, id: '200' };
    const c = { ...DISPLAY_EXTERNAL_2, id: '1000' };
    const all = [DISPLAY_INTERNAL, a, b, c];
    assert.equal(buildKey(b, all), 'ext:dell-u2723qe');
    assert.equal(buildKey(a, all), 'ext:dell-u2723qe#2');
    assert.equal(buildKey(c, all), 'ext:dell-u2723qe#3');
  });

  test('matchSavedScreen: by lastSeenDisplayId first', () => {
    const screens = onboardedLocal().screens;
    const renamed = { ...DISPLAY_EXTERNAL, name: 'LG UltraFine (2)' }; // same id, new name
    const m = matchSavedScreen(renamed, screens, [DISPLAY_INTERNAL, renamed]);
    assert.equal(m.key, 'ext:lg-ultrafine');
    assert.equal(m.needsIdUpdate, false);
  });

  test('matchSavedScreen: by key when the id changed (cable reconnect), flags id update', () => {
    const screens = onboardedLocal().screens;
    const reconnected = { ...DISPLAY_EXTERNAL, id: '555' };
    const m = matchSavedScreen(reconnected, screens, [DISPLAY_INTERNAL, reconnected]);
    assert.equal(m.key, 'ext:lg-ultrafine');
    assert.equal(m.needsIdUpdate, true);
  });

  test('matchSavedScreen: internal class matches even when id and name differ', () => {
    const screens = { internal: { ...onboardedLocal().screens.internal, key: 'internal', lastSeenDisplayId: '1' } };
    const laptop = { id: '42', name: 'Color LCD', isInternal: true, bounds: DISPLAY_INTERNAL.bounds };
    const m = matchSavedScreen(laptop, screens, [laptop]);
    assert.equal(m.key, 'internal');
    assert.equal(m.needsIdUpdate, true);
  });

  test('matchSavedScreen: unknown external → null; never matches an internal profile', () => {
    const screens = onboardedLocal().screens;
    assert.equal(matchSavedScreen(DISPLAY_EXTERNAL_2, screens, [DISPLAY_INTERNAL, DISPLAY_EXTERNAL_2]), null);
    assert.equal(matchSavedScreen(DISPLAY_EXTERNAL_2, {}, []), null);
  });

  test('matchSavedScreen is pure (does not mutate screens)', () => {
    const screens = onboardedLocal().screens;
    const snapshot = JSON.stringify(screens);
    matchSavedScreen({ ...DISPLAY_EXTERNAL, id: '999' }, screens, [DISPLAY_INTERNAL]);
    assert.equal(JSON.stringify(screens), snapshot);
  });

  test('nameless displays (macOS reports name: "") fall back to a resolution key, never a shared bucket', () => {
    // Exactly what Chrome returned on real macOS hardware: name "" for every display, ids "1" and "2".
    const builtin = { id: '1', name: '', isPrimary: true, isInternal: true, bounds: { left: 0, top: 0, width: 1512, height: 982 } };
    const ext = { id: '2', name: '', isPrimary: false, isInternal: false, bounds: { left: 1512, top: 0, width: 2560, height: 1440 } };
    const ext4k = { id: '3', name: '', isPrimary: false, isInternal: false, bounds: { left: 4072, top: 0, width: 3840, height: 2160 } };
    const all = [builtin, ext, ext4k];

    assert.equal(resolutionTag(ext), '2560x1440');
    assert.equal(externalKeyBase(ext), 'ext:2560x1440');
    assert.equal(buildKey(builtin, all), 'internal');
    assert.equal(buildKey(ext, all), 'ext:2560x1440');
    assert.equal(buildKey(ext4k, all), 'ext:3840x2160', 'two different nameless monitors get distinct keys');
    // Resolution is only used when the name is empty.
    assert.equal(externalKeyBase({ ...ext, name: 'LG UltraFine' }), 'ext:lg-ultrafine');

    // Two IDENTICAL nameless monitors: distinct, stable keys ordered by id.
    const twinA = { ...ext, id: '7' };
    const twinB = { ...ext, id: '9' };
    assert.equal(buildKey(twinA, [builtin, twinA, twinB]), 'ext:2560x1440');
    assert.equal(buildKey(twinB, [builtin, twinA, twinB]), 'ext:2560x1440#2');
    assert.equal(buildKey(twinB, [builtin, twinB, twinA]), 'ext:2560x1440#2', 'sibling order does not matter');

    // Labels are usable in the UI without a name.
    assert.equal(displayLabel(builtin), 'Built-in Display');
    assert.equal(displayLabel(ext), 'External Display · 2560×1440');
    assert.equal(newScreenProfile(ext, buildKey(ext, all), 1.25).name, 'External Display · 2560×1440');

    // And they round-trip through matchSavedScreen on reconnect with a new id.
    const screens = { [buildKey(ext, all)]: newScreenProfile(ext, buildKey(ext, all), 1.25) };
    const m = matchSavedScreen({ ...ext, id: '42' }, screens, [builtin, { ...ext, id: '42' }]);
    assert.equal(m?.key, 'ext:2560x1440');
    assert.equal(m?.needsIdUpdate, true);
  });

  test('displayLabel / newScreenProfile', () => {
    assert.equal(displayLabel({ name: '  ', isInternal: true }), 'Built-in Display');
    assert.equal(displayLabel(DISPLAY_EXTERNAL), 'LG UltraFine');
    const p = newScreenProfile(DISPLAY_EXTERNAL, 'ext:lg-ultrafine', 1.25);
    assert.deepEqual(p, {
      key: 'ext:lg-ultrafine',
      name: 'LG UltraFine',
      isInternal: false,
      zoomFactor: 1.25,
      confirmed: false,
      lastSeenDisplayId: DISPLAY_EXTERNAL.id,
    });
  });

  test('dimensionsOf reads `bounds` on a raw display and top-level width/height on a stored profile', () => {
    assert.deepEqual(dimensionsOf(DISPLAY_EXTERNAL), { width: 2560, height: 1440 });
    assert.deepEqual(dimensionsOf(DISPLAY_EXTERNAL_4K), { width: 3840, height: 2160 });
    assert.deepEqual(dimensionsOf({ key: 'ext:x', width: 2560, height: 1440 }), { width: 2560, height: 1440 });
    assert.deepEqual(dimensionsOf({ width: 1727.6, height: 1116.5 }), { width: 1728, height: 1117 });
    for (const bad of [
      { key: 'ext:x', width: null, height: null },
      { key: 'ext:x' },
      { width: 0, height: 0 },
      { width: NaN, height: 1440 },
      { width: -1, height: 1440 },
      { bounds: {} },
      { bounds: null },
      null,
      undefined,
      'nope',
    ]) {
      assert.equal(dimensionsOf(bad), null, `dimensionsOf(${JSON.stringify(bad)})`);
    }
    assert.equal(resolutionTag({ bounds: { width: 0, height: 1440 } }), 'unknown');
  });

  test('REGRESSION A5: defaultScreenName is profile-driven and needs no live display', () => {
    assert.equal(defaultScreenName({ key: 'internal', isInternal: true }, {}), 'MacBook Screen');
    assert.equal(defaultScreenName({ key: 'ext:a', isInternal: false }, {}), 'External Display');
    // Sibling count: N = 1 + number of OTHER external profiles.
    const one = { 'ext:a': { key: 'ext:a', isInternal: false, name: 'External Display' } };
    assert.equal(defaultScreenName({ key: 'ext:b', isInternal: false }, one), 'External Display 2');
    const two = { ...one, 'ext:b': { key: 'ext:b', isInternal: false, name: 'External Display 2' } };
    assert.equal(defaultScreenName({ key: 'ext:c', isInternal: false }, two), 'External Display 3');
    // A profile already in `screens` does not count itself (rename → empty / migration).
    assert.equal(defaultScreenName({ key: 'ext:a', isInternal: false }, one), 'External Display');
    assert.equal(defaultScreenName({ key: 'ext:b', isInternal: false }, two), 'External Display 2');
    // Internal siblings never count.
    const withInternal = { internal: { key: 'internal', isInternal: true, name: 'MacBook Screen' } };
    assert.equal(defaultScreenName({ key: 'ext:a', isInternal: false }, withInternal), 'External Display');
    // Never collides with a name another profile already holds.
    const office = { 'ext:a': { key: 'ext:a', isInternal: false, name: 'External Display 2' } };
    assert.equal(defaultScreenName({ key: 'ext:b', isInternal: false }, office), 'External Display 3');
  });

  test('defaultScreenName prefers a non-empty macOS display name when a display is given', () => {
    assert.equal(defaultScreenName({ key: 'ext:lg', isInternal: false }, {}, DISPLAY_EXTERNAL), 'LG UltraFine');
    assert.equal(defaultScreenName({ key: 'internal', isInternal: true }, {}, DISPLAY_INTERNAL), 'Built-in Retina Display');
    assert.equal(defaultScreenName({ key: 'ext:x', isInternal: false }, {}, DISPLAY_NAMELESS_QHD), 'External Display');
    assert.equal(defaultScreenName({ key: 'ext:x', isInternal: false }, {}, { ...DISPLAY_EXTERNAL, name: '   ' }), 'External Display');
    // Class can come from the display when the profile has no flag yet.
    assert.equal(defaultScreenName({}, {}, { ...DISPLAY_NAMELESS_QHD, name: '', isInternal: true }), 'MacBook Screen');
  });

  test('profileRefreshPatch: id and logical size, only when they differ (C2)', () => {
    const fresh = { key: 'ext:lg-ultrafine', lastSeenDisplayId: DISPLAY_EXTERNAL.id, width: 2560, height: 1440 };
    assert.equal(profileRefreshPatch(fresh, DISPLAY_EXTERNAL), null);
    assert.deepEqual(profileRefreshPatch({ ...fresh, width: null, height: null }, DISPLAY_EXTERNAL), { width: 2560, height: 1440 });
    assert.deepEqual(profileRefreshPatch({ ...fresh, width: 1920, height: 1080 }, DISPLAY_EXTERNAL), { width: 2560, height: 1440 });
    assert.deepEqual(profileRefreshPatch({ ...fresh, lastSeenDisplayId: '555' }, DISPLAY_EXTERNAL), { lastSeenDisplayId: DISPLAY_EXTERNAL.id });
    assert.deepEqual(profileRefreshPatch({ ...fresh, lastSeenDisplayId: '555', width: null, height: null }, DISPLAY_EXTERNAL), {
      lastSeenDisplayId: DISPLAY_EXTERNAL.id,
      width: 2560,
      height: 1440,
    });
    // A display without a usable size never blanks a known size.
    assert.equal(profileRefreshPatch(fresh, { ...DISPLAY_EXTERNAL, bounds: {} }), null);
  });
});

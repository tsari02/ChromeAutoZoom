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
} from '../src/lib/screen-keys.js';
import { DISPLAY_INTERNAL, DISPLAY_EXTERNAL, DISPLAY_EXTERNAL_2, onboardedLocal } from './_chrome-mock.js';

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
});

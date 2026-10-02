// site-deltas.js — per-(host, screen) deltas with inheritance (engineering doc
// v3 §5.2, §10) and the C3 deterministic-tiebreaker regression. Pure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDelta, withDelta, withoutHost, pruneHost, areaGap } from '../src/lib/site-deltas.js';

const HOST = 'mail.google.com';

const screen = (key, width, height, extra = {}) => ({
  key,
  name: key,
  isInternal: false,
  width,
  height,
  zoomFactor: 1.25,
  createdAt: 1_000,
  ...extra,
});

const INTERNAL = screen('internal', 1512, 982, { isInternal: true, name: 'MacBook Screen' });
const QHD = screen('ext:qhd', 2560, 1440); // area 3,686,400
const QHD2 = screen('ext:qhd#2', 2560, 1440); // identical area
const UW = screen('ext:uw', 3440, 1440); // area 4,953,600
const UHD = screen('ext:4k', 3840, 2160); // area 8,294,400
const UNKNOWN_A = screen('ext:a', null, null); // v2-migrated, size not yet seen
const UNKNOWN_B = screen('ext:b', null, null);

const row = (delta, updatedAt = 1_000) => ({ delta, updatedAt });

function stateWith(screens, rows) {
  return {
    screens: Object.fromEntries(screens.map((s) => [s.key, s])),
    siteStepDeltas: rows ? { [HOST]: rows } : {},
  };
}

describe('site-deltas — resolveDelta', () => {
  test('no rows for the host → 0, not inherited', () => {
    assert.deepEqual(resolveDelta(HOST, QHD.key, stateWith([QHD, INTERNAL], null)), { delta: 0, source: null, inherited: false });
    assert.deepEqual(resolveDelta(HOST, QHD.key, { screens: {}, siteStepDeltas: {} }), { delta: 0, source: null, inherited: false });
    assert.deepEqual(resolveDelta(HOST, QHD.key, {}), { delta: 0, source: null, inherited: false });
  });

  test('explicit row wins (even when another screen is closer in area and more recent)', () => {
    const st = stateWith([QHD, QHD2, INTERNAL], {
      [QHD.key]: row(1, 10),
      [QHD2.key]: row(3, 99_999),
    });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: 1, source: QHD.key, inherited: false });
  });

  test('inherit same class before other class', () => {
    // Internal screen asks; the 4K external row is far more recent, but the
    // other-class pool is only consulted when no same-class screen has a row.
    const laptop2 = screen('internal#2', 1512, 982, { isInternal: true });
    const st = stateWith([INTERNAL, laptop2, UHD], {
      [laptop2.key]: row(-1, 10),
      [UHD.key]: row(2, 99_999),
    });
    assert.deepEqual(resolveDelta(HOST, INTERNAL.key, st), { delta: -1, source: laptop2.key, inherited: true });

    // External asks; only the internal has a row → falls through to the other class.
    const st2 = stateWith([INTERNAL, QHD], { [INTERNAL.key]: row(1, 10) });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st2), { delta: 1, source: INTERNAL.key, inherited: true });
  });

  test('smaller |Δ area| wins over recency', () => {
    // QHD2 has the same area as QHD; UHD is much bigger but was adjusted later.
    const st = stateWith([QHD, QHD2, UHD, UW], {
      [QHD2.key]: row(1, 10),
      [UHD.key]: row(2, 99_999),
    });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: 1, source: QHD2.key, inherited: true });
    // From the ultrawide's point of view QHD2 (Δ 1.27 Mpx²) is closer than UHD (Δ 3.3 Mpx²).
    assert.equal(resolveDelta(HOST, UW.key, st).source, QHD2.key);
    // A screen the state does not know has no area → falls back to recency.
    assert.equal(resolveDelta(HOST, 'ext:never-seen', st).source, UHD.key);
  });

  test('equal area → most recent wins', () => {
    const twinA = screen('ext:twin-a', 2560, 1440);
    const twinB = screen('ext:twin-b', 2560, 1440);
    const st = stateWith([QHD, twinA, twinB], {
      [twinA.key]: row(1, 100),
      [twinB.key]: row(2, 200),
    });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: 2, source: twinB.key, inherited: true });
  });

  test('unknown sizes fall back to recency', () => {
    const st = stateWith([UNKNOWN_A, UNKNOWN_B, QHD], {
      [UNKNOWN_A.key]: row(1, 500),
      [UNKNOWN_B.key]: row(-2, 900),
    });
    // QHD knows its size but neither candidate does → both gaps are Infinity → recency.
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: -2, source: UNKNOWN_B.key, inherited: true });
    // A known-size candidate beats an unknown one regardless of recency.
    const st2 = stateWith([UNKNOWN_A, UHD, QHD], {
      [UNKNOWN_A.key]: row(1, 99_999),
      [UHD.key]: row(3, 1),
    });
    assert.equal(resolveDelta(HOST, QHD.key, st2).source, UHD.key);
    assert.equal(areaGap(QHD, UNKNOWN_A), Number.POSITIVE_INFINITY);
    assert.equal(areaGap(UNKNOWN_A, UNKNOWN_B), Number.POSITIVE_INFINITY);
    assert.equal(areaGap(QHD, UW), 3440 * 1440 - 2560 * 1440);
  });

  test('explicit 0 blocks inheritance', () => {
    const st = stateWith([INTERNAL, QHD], {
      [QHD.key]: row(1, 10),
      [INTERNAL.key]: row(0, 20),
    });
    assert.deepEqual(resolveDelta(HOST, INTERNAL.key, st), { delta: 0, source: INTERNAL.key, inherited: false });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: 1, source: QHD.key, inherited: false });
  });

  test('rows for screens that no longer exist, and malformed rows, are never inherited', () => {
    const st = stateWith([QHD], { 'ext:gone': row(2, 10), [QHD2.key]: { delta: 'x' } });
    assert.deepEqual(resolveDelta(HOST, QHD.key, st), { delta: 0, source: null, inherited: false });
  });
});

describe('site-deltas — REGRESSION C3: deterministic final tiebreaker', () => {
  // After a v2→v3 migration every fanned-out row carries the SAME updatedAt and
  // the screens have equal area. The winner must not depend on the order in
  // which Object.entries() yields rows or screens.
  const mk = (overrides = {}) =>
    Object.fromEntries(
      ['ext:a', 'ext:b', 'ext:c'].map((k) => [k, screen(k, 2560, 1440, { createdAt: 5_000, ...(overrides[k] ?? {}) })]),
    );
  const permutations = (xs) =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  function resolveForEveryOrder(screensByKey, deltas) {
    const keys = Object.keys(screensByKey);
    const results = new Set();
    let runs = 0;
    for (const screenOrder of permutations(keys)) {
      for (const rowOrder of permutations(keys)) {
        const screens = { [QHD.key]: QHD };
        for (const k of screenOrder) screens[k] = screensByKey[k];
        const rows = {};
        for (const k of rowOrder) rows[k] = { delta: deltas[k], updatedAt: 7_777 };
        const r = resolveDelta(HOST, QHD.key, { screens, siteStepDeltas: { [HOST]: rows } });
        assert.equal(r.inherited, true);
        results.add(`${r.source}:${r.delta}`);
        runs += 1;
      }
    }
    assert.equal(runs, 36, '3! × 3! orderings exercised');
    return results;
  }

  test('equal area + equal updatedAt + equal createdAt → the same source for every insertion order (key order decides)', () => {
    const results = resolveForEveryOrder(mk(), { 'ext:a': 1, 'ext:b': 2, 'ext:c': 3 });
    assert.equal(results.size, 1, `expected one deterministic answer, got ${[...results].join(', ')}`);
    assert.deepEqual([...results], ['ext:a:1'], 'lexically smallest key wins the final tiebreak');
  });

  test('equal area + equal updatedAt → the older profile (createdAt) wins before the key tiebreak', () => {
    const results = resolveForEveryOrder(mk({ 'ext:c': { createdAt: 1_000 } }), { 'ext:a': 1, 'ext:b': 2, 'ext:c': 3 });
    assert.deepEqual([...results], ['ext:c:3']);
  });

  test('recency still beats both tiebreakers', () => {
    const screens = { [QHD.key]: QHD, ...mk({ 'ext:c': { createdAt: 1_000 } }) };
    const rows = { 'ext:c': row(3, 100), 'ext:b': row(2, 300), 'ext:a': row(1, 200) };
    assert.equal(resolveDelta(HOST, QHD.key, { screens, siteStepDeltas: { [HOST]: rows } }).source, 'ext:b');
  });
});

describe('site-deltas — withDelta / pruneHost / withoutHost', () => {
  test('withDelta writes an explicit row with the given timestamp; 0 is persisted while another row is non-zero', () => {
    let d = withDelta({}, HOST, 'ext:qhd', 1, 100);
    assert.deepEqual(d, { [HOST]: { 'ext:qhd': { delta: 1, updatedAt: 100 } } });
    d = withDelta(d, HOST, 'internal', 0, 200);
    assert.deepEqual(d, {
      [HOST]: { 'ext:qhd': { delta: 1, updatedAt: 100 }, internal: { delta: 0, updatedAt: 200 } },
    });
    // Other hosts are untouched and the input is not mutated.
    const frozen = Object.freeze({ 'x.example': Object.freeze({ internal: row(2) }) });
    const out = withDelta(frozen, HOST, 'internal', -1, 5);
    assert.deepEqual(out['x.example'], { internal: row(2) });
    assert.deepEqual(frozen, { 'x.example': { internal: row(2) } });
    assert.equal(withDelta({}, HOST, 'internal', 1.9, 1)[HOST].internal.delta, 1, 'non-integers are truncated');
    assert.equal(withDelta({}, HOST, 'internal', 2, 1)[HOST].internal.delta, 2);
  });

  test('withDelta defaults updatedAt to Date.now()', () => {
    const real = Date.now;
    Date.now = () => 424242;
    try {
      assert.equal(withDelta({}, HOST, 'ext:qhd', 1)[HOST]['ext:qhd'].updatedAt, 424242);
    } finally {
      Date.now = real;
    }
  });

  test('host with all-0 rows is pruned', () => {
    let d = withDelta({}, HOST, 'ext:qhd', 1, 1);
    d = withDelta(d, HOST, 'internal', 0, 2);
    assert.ok(HOST in d, 'still a live row');
    d = withDelta(d, HOST, 'ext:qhd', 0, 3);
    assert.deepEqual(d, {}, 'every row 0 ⇒ host removed');
    assert.deepEqual(withDelta({}, HOST, 'internal', 0, 1), {}, 'a lone 0 row is pruned immediately');
    const other = { 'x.example': { internal: row(0) }, 'y.example': { internal: row(1) } };
    assert.deepEqual(pruneHost(other, 'x.example'), { 'y.example': { internal: row(1) } });
    assert.equal(pruneHost(other, 'y.example'), other, 'live host untouched (same object)');
    assert.equal(pruneHost(other, 'nope.example'), other);
  });

  test('withoutHost removes every row for the host and returns a copy', () => {
    const d = { [HOST]: { 'ext:qhd': row(1), internal: row(0) }, 'x.example': { internal: row(2) } };
    const out = withoutHost(d, HOST);
    assert.deepEqual(out, { 'x.example': { internal: row(2) } });
    assert.ok(HOST in d, 'input not mutated');
    assert.equal(withoutHost(d, 'nope.example'), d);
    assert.deepEqual(withoutHost(undefined, HOST), {});
  });
});

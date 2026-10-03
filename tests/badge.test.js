import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, deltaRows } from './_chrome-mock.js';
import { describe as describeBadge, update } from '../src/lib/badge.js';

const EXT = 'ext:lg-ultrafine';
const INT = 'internal';
const screen = { key: EXT, name: 'LG UltraFine', isInternal: false, width: 2560, height: 1440, zoomFactor: 1.25, createdAt: 2 };
const internal = { key: INT, name: 'MacBook Screen', isInternal: true, width: 1512, height: 982, zoomFactor: 1.0, createdAt: 1 };
const state = (o = {}) => ({
  enabled: true,
  onboardingCompleted: true,
  screens: { [EXT]: screen, [INT]: internal },
  siteStepDeltas: {},
  excludedHosts: {},
  ...o,
});
const tab = (url = 'https://news.ycombinator.com/') => ({ id: 1, windowId: 1, url, active: true });

describe('badge', () => {
  test('OFF when paused', () => {
    const b = describeBadge(tab(), screen, state({ enabled: false }));
    assert.equal(b.text, 'OFF');
  });

  test('excluded hosts: no badge text or colour, title still says excluded (1.1.0 polish, D25)', () => {
    const b = describeBadge(tab(), screen, state({ excludedHosts: { 'news.ycombinator.com': true } }));
    assert.equal(b.text, '');
    assert.equal(b.color, undefined);
    assert.match(b.title, /news\.ycombinator\.com is excluded/);
  });

  test('3-char percentage without % sign; empty at 100% with no delta', () => {
    assert.equal(describeBadge(tab(), screen, state()).text, '125');
    assert.equal(describeBadge(tab(), { ...screen, zoomFactor: 1.0 }, state()).text, '');
    const plusOne = describeBadge(tab(), screen, state({ siteStepDeltas: { 'news.ycombinator.com': deltaRows({ [EXT]: 1 }) } }));
    assert.equal(plusOne.text, '150');
    assert.equal(plusOne.title, 'AutoZoom · LG UltraFine · 150% · +1 step for news.ycombinator.com');
    assert.equal(describeBadge(tab(), { ...screen, zoomFactor: 5 }, state()).text, '500');
  });

  test('inherited delta: title says where it came from; an explicit 0 row shows the plain default', () => {
    const st = state({ siteStepDeltas: { 'news.ycombinator.com': deltaRows({ [EXT]: 1 }) } });
    const onInternal = describeBadge(tab(), internal, st);
    assert.equal(onInternal.text, '110', '100% + 1 inherited step');
    assert.equal(onInternal.title, 'AutoZoom · MacBook Screen · 110% · +1 step for news.ycombinator.com (inherited from LG UltraFine)');

    const corrected = state({ siteStepDeltas: { 'news.ycombinator.com': deltaRows({ [EXT]: 1, [INT]: 0 }) } });
    const afterFix = describeBadge(tab(), internal, corrected);
    assert.equal(afterFix.text, '');
    assert.equal(afterFix.title, 'AutoZoom · MacBook Screen · 100%');
    assert.equal(describeBadge(tab(), screen, corrected).text, '150', 'external keeps its own +1');
  });

  test('restricted pages show nothing', () => {
    const b = describeBadge(tab('chrome://extensions'), screen, state());
    assert.equal(b.text, '');
  });

  test('update paints tab-scoped text, colour and title', async () => {
    const mock = installChromeMock();
    await update(tab(), screen, state());
    assert.deepEqual(mock.callsTo('action.setBadgeText')[0].args[0], { tabId: 1, text: '125' });
    assert.equal(mock.callsTo('action.setBadgeBackgroundColor').length, 1);
    assert.equal(mock.callsTo('action.setTitle')[0].args[0].tabId, 1);
  });
});

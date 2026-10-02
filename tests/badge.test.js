import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './_chrome-mock.js';
import { describe as describeBadge, update } from '../src/lib/badge.js';

const screen = { key: 'ext:lg-ultrafine', name: 'LG UltraFine', isInternal: false, zoomFactor: 1.25, confirmed: true };
const state = (o = {}) => ({ enabled: true, onboardingCompleted: true, siteStepDeltas: {}, excludedHosts: {}, ...o });
const tab = (url = 'https://news.ycombinator.com/') => ({ id: 1, windowId: 1, url, active: true });

describe('badge', () => {
  test('OFF when paused', () => {
    const b = describeBadge(tab(), screen, state({ enabled: false }));
    assert.equal(b.text, 'OFF');
  });

  test('PIN for excluded hosts', () => {
    const b = describeBadge(tab(), screen, state({ excludedHosts: { 'news.ycombinator.com': true } }));
    assert.equal(b.text, 'PIN');
    assert.match(b.title, /excluded/);
  });

  test('3-char percentage without % sign; empty at 100% with no delta', () => {
    assert.equal(describeBadge(tab(), screen, state()).text, '125');
    assert.equal(describeBadge(tab(), { ...screen, zoomFactor: 1.0 }, state()).text, '');
    const plusOne = describeBadge(tab(), screen, state({ siteStepDeltas: { 'news.ycombinator.com': 1 } }));
    assert.equal(plusOne.text, '150');
    assert.equal(plusOne.title, 'AutoZoom · LG UltraFine · 150% · +1 step for news.ycombinator.com');
    assert.equal(describeBadge(tab(), { ...screen, zoomFactor: 5 }, state()).text, '500');
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

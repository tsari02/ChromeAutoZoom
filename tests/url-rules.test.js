import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isZoomableUrl, hostOf, prettyHost } from '../src/lib/url-rules.js';

describe('url-rules', () => {
  test('isZoomableUrl accepts http, https and file', () => {
    assert.ok(isZoomableUrl('https://news.ycombinator.com/'));
    assert.ok(isZoomableUrl('http://localhost:3000/app'));
    assert.ok(isZoomableUrl('file:///Users/me/doc.html'));
  });

  test('isZoomableUrl rejects restricted schemes (FR-9)', () => {
    for (const u of [
      'chrome://extensions',
      'chrome://newtab/',
      'chrome-extension://abcdefgh/popup.html',
      'devtools://devtools/bundled/inspector.html',
      'about:blank',
      'edge://settings',
      'view-source:https://example.com',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
      'javascript:void 0',
      '',
      undefined,
      null,
      'not a url',
    ]) {
      assert.equal(isZoomableUrl(u), false, `should reject ${u}`);
    }
  });

  test('isZoomableUrl rejects the Chrome Web Store', () => {
    assert.equal(isZoomableUrl('https://chromewebstore.google.com/detail/xyz'), false);
    assert.equal(isZoomableUrl('https://chrome.google.com/webstore/category/extensions'), false);
    assert.ok(isZoomableUrl('https://www.google.com/'));
  });

  test('hostOf returns the lower-cased hostname without port; "file" for file URLs; "" when unparsable', () => {
    assert.equal(hostOf('https://News.YCombinator.com:8443/item?id=1'), 'news.ycombinator.com');
    assert.equal(hostOf('http://localhost:3000/'), 'localhost');
    assert.equal(hostOf('file:///tmp/x.html'), 'file');
    assert.equal(hostOf('garbage'), '');
    assert.equal(hostOf(undefined), '');
  });

  test('http and https of the same site share a host key', () => {
    assert.equal(hostOf('http://example.com/a'), hostOf('https://example.com/b'));
  });

  test('prettyHost strips www.', () => {
    assert.equal(prettyHost('www.figma.com'), 'figma.com');
    assert.equal(prettyHost('figma.com'), 'figma.com');
    assert.equal(prettyHost(null), '');
  });
});

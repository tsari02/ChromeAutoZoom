#!/usr/bin/env node
// static-scan.mjs — CSP / MV3 hygiene checks for AutoZoom (no dependencies).
//
// Fails (exit 1) if any of these are found in shipped files (manifest.json,
// src/**):
//   - inline <script> blocks or inline on* event handlers in HTML
//   - eval( / new Function(
//   - .then( promise chains (async/await only)
//   - chrome.windows.query( (does not exist)
//   - chrome.tabs.setZoom( outside src/lib/tab-zoom.js
//   - an onMessage listener that does not `return true`
//   - manifest icon references that do not exist / wrong pixel size
//
// Usage: node scripts/static-scan.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const notes = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src'));
const js = files.filter((f) => extname(f) === '.js');
const html = files.filter((f) => extname(f) === '.html');
const rel = (f) => relative(ROOT, f);

// --- HTML ------------------------------------------------------------------
for (const f of html) {
  const text = readFileSync(f, 'utf8');
  if (/<script\b(?![^>]*\bsrc=)[^>]*>\s*[^\s<]/i.test(text) || /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(text)) {
    problems.push(`${rel(f)}: inline <script> block`);
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(text)) problems.push(`${rel(f)}: inline event handler attribute`);
  if (/javascript:/i.test(text)) problems.push(`${rel(f)}: javascript: URL`);
  for (const m of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const target = join(f, '..', m[1]);
    if (!existsSync(target)) problems.push(`${rel(f)}: script src missing: ${m[1]}`);
  }
}

// --- JS --------------------------------------------------------------------
for (const f of js) {
  const text = readFileSync(f, 'utf8');
  const r = rel(f);
  if (/\beval\s*\(/.test(text)) problems.push(`${r}: eval(`);
  if (/new\s+Function\s*\(/.test(text)) problems.push(`${r}: new Function(`);
  if (/\.then\s*\(/.test(text)) problems.push(`${r}: .then( chain`);
  if (/chrome\.windows\.query\s*\(/.test(text)) problems.push(`${r}: chrome.windows.query( does not exist`);
  if (/chrome\.tabs\.setZoom\s*\(/.test(text) && r !== 'src/lib/tab-zoom.js') {
    problems.push(`${r}: chrome.tabs.setZoom( outside src/lib/tab-zoom.js`);
  }
  if (/onMessage\.addListener\s*\(/.test(text)) {
    // The listener may be an inline function or a named import; resolve the body.
    const inline = /onMessage\.addListener\s*\(\s*(?:async\s*)?(?:function\b[^{]*|\([^)]*\)\s*=>\s*)\{/.test(text);
    const named = text.match(/onMessage\.addListener\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    let body = text;
    if (named) {
      const src = js.map((p) => readFileSync(p, 'utf8')).find((t) => new RegExp(`function\\s+${named[1]}\\s*\\(`).test(t));
      body = src ?? '';
    }
    if (!/return\s+true\s*;/.test(body)) problems.push(`${r}: onMessage listener without 'return true'`);
    if (inline && !/return\s+true\s*;/.test(text)) problems.push(`${r}: inline onMessage listener without 'return true'`);
  }
}

// setZoom ordering inside tab-zoom.js: setZoomSettings(per-tab) must appear
// before setZoom in applyZoom, and the release path must only call setZoom
// when the scope is already per-tab.
{
  const tz = readFileSync(join(ROOT, 'src/lib/tab-zoom.js'), 'utf8');
  const apply = tz.slice(tz.indexOf('export async function applyZoom'), tz.indexOf('export async function releaseZoom'));
  const iSettings = apply.indexOf('chrome.tabs.setZoomSettings(');
  const iZoom = apply.indexOf('chrome.tabs.setZoom(');
  if (!(iSettings >= 0 && iZoom > iSettings)) problems.push('src/lib/tab-zoom.js: applyZoom must call setZoomSettings before setZoom');
  if (!/scope:\s*'per-tab'/.test(tz)) problems.push("src/lib/tab-zoom.js: no scope: 'per-tab'");
  const release = tz.slice(tz.indexOf('export async function releaseZoom'));
  if (!/scope !== 'per-tab'[\s\S]*?return;[\s\S]*?chrome\.tabs\.setZoom\(/.test(release)) {
    problems.push('src/lib/tab-zoom.js: releaseZoom must bail out unless scope is already per-tab before setZoom');
  }
  notes.push(`chrome.tabs.setZoom( occurrences: ${js.filter((f) => /chrome\.tabs\.setZoom\s*\(/.test(readFileSync(f, 'utf8'))).map(rel).join(', ')}`);
}

// --- Manifest --------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) problems.push('manifest.json: manifest_version must be 3');
if (!manifest.minimum_chrome_version) problems.push('manifest.json: minimum_chrome_version missing');
if (!manifest.action) problems.push('manifest.json: "action" missing');
if (manifest.background?.type !== 'module') problems.push('manifest.json: service worker must be type: module');
if (manifest.host_permissions?.length) problems.push('manifest.json: host_permissions must be empty');
if (manifest.content_scripts?.length) problems.push('manifest.json: content_scripts must be empty');
const allowed = ['system.display', 'tabs', 'storage'];
for (const p of manifest.permissions ?? []) if (!allowed.includes(p)) problems.push(`manifest.json: unexpected permission ${p}`);

function pngSize(file) {
  const b = readFileSync(file);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const refs = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
]);
for (const ref of refs) {
  if (!ref) continue;
  const p = join(ROOT, ref);
  if (!existsSync(p)) problems.push(`manifest.json: referenced file missing: ${ref}`);
}
for (const [size, ref] of Object.entries({ ...(manifest.icons ?? {}), ...(manifest.action?.default_icon ?? {}) })) {
  const p = join(ROOT, ref);
  if (!existsSync(p)) continue;
  const s = pngSize(p);
  if (!s) problems.push(`${ref}: not a PNG`);
  else if (s.w !== Number(size) || s.h !== Number(size)) problems.push(`${ref}: is ${s.w}x${s.h}, expected ${size}x${size}`);
  else notes.push(`${ref}: PNG ${s.w}x${s.h} ✓`);
}
if (manifest.description && manifest.description.length > 132) problems.push('manifest.json: description > 132 chars');

// --- Report ----------------------------------------------------------------
console.log(`Scanned ${js.length} JS files, ${html.length} HTML files, manifest.json`);
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.log(`\n✖ ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\n✔ Static scan clean: no inline scripts/handlers, no eval/new Function, no .then( chains, no chrome.windows.query, setZoom confined to tab-zoom.js with per-tab scope first, onMessage returns true, manifest + icons valid.');

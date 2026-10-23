'use strict';
// Installable on a phone: a valid manifest whose icons exist, a service worker that never touches the API, and the page links them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pub = f => path.join(__dirname, '..', 'public', f);

test('the manifest is valid and every icon it names exists at its stated size', () => {
  const m = JSON.parse(fs.readFileSync(pub('manifest.json'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'), 'the sizes browsers require');
  for (const i of m.icons) {
    const file = fs.readFileSync(pub(i.src.replace(/^\//, '')));
    const w = file.readUInt32BE(16), hgt = file.readUInt32BE(20);   // PNG header
    assert.equal(`${w}x${hgt}`, i.sizes, `${i.src} is the size it says`);
  }
});

test('the service worker leaves the API and everything but page loads alone', () => {
  const sw = fs.readFileSync(pub('sw.js'), 'utf8');
  assert.match(sw, /startsWith\('\/api\/'\)/);
  assert.match(sw, /r\.mode !== 'navigate'/);
  assert.ok(!/cache\.addAll|caches\.open\([^)]*\)\.then\(c => c\.addAll/.test(sw), 'nothing is pre-cached');
});

test('the page links the manifest, the icon and the worker', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest.json"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(html, /serviceWorker\.register\('\/sw.js'\)/);
  assert.ok(fs.existsSync(pub('apple-touch-icon.png')));
});

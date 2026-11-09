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

test('the service worker never touches the API and keeps only the app shell', () => {
  const sw = fs.readFileSync(pub('sw.js'), 'utf8');
  assert.match(sw, /startsWith\('\/api\/'\)/);
  const shell = (/const SHELL = \[([\s\S]*?)\];/.exec(sw) || [])[1] || '';
  assert.ok(shell.includes("'/js/app.js'") && !/\/api\//.test(shell), 'the shell is the page and its scripts, never data');
  assert.match(sw, /fetch\(r\)\.then/, 'network first, so a new deploy shows straight away');
});

// Runs the worker's real code against a fake browser: what it handles, what it saves and what it serves when the network is down.
test('the worker: pages and scripts network first with a saved copy offline; the API and other pages are left alone', async () => {
  const vm = require('vm'), listeners = {}, store = new Map();
  const caches = { open: async () => ({ put: async (k, v) => { store.set(typeof k === 'string' ? k : new URL(k.url).pathname, v); }, add: async () => {} }), match: async k => { const v = store.get(typeof k === 'string' ? k : new URL(k.url).pathname); return v && v.clone(); }, keys: async () => [], delete: async () => true };
  let online = true;
  const fetchImpl = async r => { if (!online) throw new Error('offline'); return new Response(`live ${new URL(r.url).pathname}`); };
  const sandbox = { self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://club.test' }, skipWaiting() {}, clients: { claim() {} } }, caches, fetch: fetchImpl, URL, Response };
  vm.runInNewContext(fs.readFileSync(pub('sw.js'), 'utf8'), sandbox);
  const ask = (path, mode = 'cors', method = 'GET') => { let out; listeners.fetch({ request: { url: 'https://club.test' + path, mode, method }, respondWith: p => { out = p; } }); return out; };
  assert.equal(ask('/api/week'), undefined, 'the API is never handled'); assert.equal(ask('/club.html', 'navigate'), undefined, 'other pages are left to the network');
  assert.equal(ask('/js/app.js', 'cors', 'POST'), undefined); assert.equal(ask('/somewhere.css'), undefined);
  assert.equal(await (await ask('/', 'navigate')).text(), 'live /'); assert.equal(await (await ask('/js/app.js')).text(), 'live /js/app.js');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(store.has('/') && store.has('/js/app.js'), 'the page and script were saved when they loaded');
  online = false;
  assert.equal(await (await ask('/', 'navigate')).text(), 'live /', 'offline: the saved page opens');
  assert.equal(await (await ask('/?utm=x', 'navigate')).text(), 'live /', 'the same page under any query string');
  assert.equal(await (await ask('/js/app.js')).text(), 'live /js/app.js', 'offline: the saved script opens');
  assert.equal(store.has('/api/week'), false);
});

test('the page links the manifest, the icon and the worker', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest.json"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(html + fs.readFileSync(pub('js/app.js'), 'utf8'), /serviceWorker\.register\('\/sw.js'\)/);
  assert.ok(fs.existsSync(pub('apple-touch-icon.png')));
});

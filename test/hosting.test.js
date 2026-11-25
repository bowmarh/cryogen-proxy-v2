'use strict';
// Serving the app from its own Node server (Hostinger): the entry file, static files and the files search engines and AI tools read.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('the Hostinger entry file listens without the require.main guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'hostinger.js'), 'utf8');
  assert.match(src, /require\('\.\/api\/server'\)/);
  assert.match(src, /\.listen\(/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /require\.main/);
});

test('pages are compressed, re-checked each visit and carry the security headers', async () => {
  const r = await fetch(app.base + '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await r.text(), /Team CRYO-GEN/);
  const again = await fetch(app.base + '/', { headers: { 'if-none-match': r.headers.get('etag') } });
  assert.equal(again.status, 304, 'an unchanged page is not sent twice');
});

test('pictures are kept a week; missing files and paths outside public/ are 404', async () => {
  const logo = await fetch(app.base + '/logo.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('cache-control'), /max-age=604800/);
  assert.ok(Number(logo.headers.get('content-length')) < 200000, 'the logo stays small');
  assert.equal((await fetch(app.base + '/nope.html')).status, 404);
  assert.equal((await fetch(app.base + '/..%2fpackage.json')).status, 404);
});

test('robots.txt, sitemap.xml and llms.txt name this copy of the app and keep the API out', async () => {
  const robots = await (await fetch(app.base + '/robots.txt')).text();
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /User-agent: GPTBot/);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  const sitemap = await fetch(app.base + '/sitemap.xml');
  assert.match(sitemap.headers.get('content-type'), /xml/);
  assert.match(await sitemap.text(), /<loc>https?:\/\/[^<]+\/club\.html<\/loc>/);
  const llms = await (await fetch(app.base + '/llms.txt')).text();
  assert.match(llms, /^# Team CRYO-GEN/);
  assert.match(llms, /Zwift/);
});

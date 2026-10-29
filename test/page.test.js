'use strict';
// Guards for the single-page dashboard (public/index.html), which has no build step.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./helpers');

h.setEnv();
const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const externalScripts = [path.join(publicDir, 'js', 'calendar-settings.js')].map(file => fs.readFileSync(file, 'utf8'));
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('every inline script parses (a typo there would blank the whole dashboard)', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert.ok(scripts.length >= 1);
  [...scripts, ...externalScripts].forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `dashboard script ${i + 1}` })));
});

test('no placeholder credentials or WordPress login details are in the page', () => {
  for (const bad of ['application_password', 'admin_username', 'wp-json/cryogen/v1/members']) {
    assert.ok(!html.includes(bad), `the page must not contain "${bad}"`);
  }
});

test('every server route the page calls exists', async () => {
  const source = [html, ...externalScripts].join('\n');
  const paths = new Set([...source.matchAll(/['"`](\/api\/[A-Za-z0-9/_-]+)(?:\?[^'"`]*)?['"`]/g)].map(m => m[1]).filter(p => !p.endsWith('/')));
  assert.ok(paths.size >= 10, `found only ${paths.size} routes`);
  for (const p of paths) {
    // A missing route answers {error:'Not found'}; other 404s (e.g. unknown week) mean the route exists.
    const noRoute = r => r.status === 404 && r.body && r.body.error === 'Not found';
    const get = await app.get(p);
    const post = await app.post(p, {});
    assert.ok(!noRoute(get) || !noRoute(post), `${p} is called by the page but the server has no such route`);
  }
});

test('the dashboard uses real roster data only and loads the extracted calendar module', () => {
  assert.match(html, /\/js\/calendar-settings\.js/);
  assert.doesNotMatch(html, /\bMOCK\b|mock data|riders \(mock\)/i);
  assert.match(html, /Cached roster may be out of date/);
});

'use strict';
// How the server reads request URLs: no deprecated parser, and odd request targets are harmless.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const h = require('./helpers');

h.setEnv();
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

// fetch() tidies URLs before sending; a raw request sends exactly what is given.
const raw = requestPath => new Promise((resolve, reject) => {
  const u = new URL(app.base);
  http.get({ host: u.hostname, port: u.port, path: requestPath }, res => {
    let body = '';
    res.on('data', c => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('the server no longer uses the deprecated url.parse (it logged a warning on every request)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  assert.ok(!/\burl\.parse\(/.test(source));
  assert.ok(!/require\('url'\)/.test(source));
});

test('query strings are read: archive id, proxy endpoint, sign-in token', async () => {
  // like the club's real sheet: TEAM LIST is not the first tab
  app.world.sheet = { first: 'Welcome', tabs: { Welcome: { cols: ['Intro'], rows: [['hi']] }, 'TEAM LIST': { cols: ['Name'], rows: [['Alice']] } }, html: false };
  assert.equal((await app.get('/api/ttt/archive?id=1999-01-01')).status, 404);
  assert.equal((await app.get('/api/ttt/archive?id=a&id=b')).status, 404, 'repeated parameters do not crash');
  assert.equal((await app.get('/api/proxy?endpoint=ttt-sheet')).status, 200);
  assert.equal((await app.get('/api/proxy?endpoint=nope')).status, 400);
  assert.match(String((await app.get('/api/auth/wp?t=garbage')).location), /sso_error/);
});

test('odd request targets are harmless', async () => {
  assert.equal((await raw('//api/health')).status, 401, 'a leading double slash is just the same path (and still needs a login)');
  assert.equal((await raw('//evil.example/api/health')).status, 404, 'and is never read as a host followed by a path');
  assert.equal((await raw('/api/auth/status?x=%')).status, 200, 'a broken percent sign in the query is fine');
  assert.equal((await raw('/%')).status, 404);
  assert.equal((await raw('/')).status, 200, 'the page still loads');
});

test('files outside the public folder cannot be fetched', async () => {
  for (const p of ['/../api/server.js', '/%2e%2e/api/server.js', '/..%2fapi/server.js', '/public/../../api/server.js', '/index.html/../../api/server.js']) {
    const r = await raw(p);
    assert.ok(!r.body.includes('module.exports'), `${p} leaked the server source`);
  }
});

test('a date that does not exist is refused with a 400 everywhere dates are accepted, never a crash', async () => {
  const admin = await app.login('admin');
  for (const bad of ['2026-13-45', '2026-02-30', '2026-00-10', 'tomorrow', '']) {
    for (const [path, body] of [
      ['/api/ttt/new-week', { date: bad }],
      ['/api/rides', { date: bad, title: 'Ride' }],
      ['/api/ttt/seasons', { name: 'S', start: bad }],
      ['/api/zrl/round', { name: 'R', start: bad }],
      ['/api/zrl/round', { name: 'R', start: '2026-11-17', closes: bad || 'x' }],
    ]) {
      const r = await app.post(path, body, { token: admin });
      assert.ok(r.status >= 400 && r.status < 500, `${path} with "${bad}" answered ${r.status}`);
    }
  }
  assert.equal((await app.get('/api/auth/status')).status, 200, 'the server is still fine');
});

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('staff can log in with the right password only', async () => {
  const ok = await app.post('/api/login', { role: 'admin', password: 'admin-pw' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'admin');
  assert.ok(ok.body.token);
  const mod = await app.post('/api/login', { role: 'mod', password: 'mod-pw' });
  assert.equal(mod.status, 200);
  assert.equal((await app.post('/api/login', { role: 'admin', password: 'mod-pw' })).status, 401);
  assert.equal((await app.post('/api/login', { role: 'admin', password: '' })).status, 401);
  assert.equal((await app.post('/api/login', { role: 'owner', password: 'x' })).status, 400);
});

test('login is unavailable (503) when that password is not configured', async () => {
  const saved = process.env.MOD_PASSWORD;
  delete process.env.MOD_PASSWORD;
  try {
    const r = await app.post('/api/login', { role: 'mod', password: 'anything' });
    assert.equal(r.status, 503);
    assert.equal(r.body.missing, 'MOD_PASSWORD');
  } finally { process.env.MOD_PASSWORD = saved; }
});

test('admin-only routes: 401 without a login, 403 for a moderator, 200 for an admin', async () => {
  assert.equal((await app.get('/api/health')).status, 401);
  assert.equal((await app.get('/api/health', { token: await app.login('mod') })).status, 403);
  assert.equal((await app.get('/api/health', { token: await app.login('admin') })).status, 200);
});

test('forged, tampered and expired tokens are rejected', async () => {
  const secret = h.defaultSessionSecret();
  const good = await app.login('admin');
  const [payload, sig] = good.split('.');
  const asMod = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 1e6, extra: 1 })).toString('base64url');
  assert.equal((await app.get('/api/health', { token: `${asMod}.${sig}` })).status, 401, 'payload swapped, old signature');
  assert.equal((await app.get('/api/health', { token: `${payload}.${sig.slice(0, -2)}xx` })).status, 401, 'bad signature');
  assert.equal((await app.get('/api/health', { token: h.signedToken({ role: 'admin', exp: Date.now() - 1000 }, secret) })).status, 401, 'expired');
  assert.equal((await app.get('/api/health', { token: h.signedToken({ role: 'admin', exp: Date.now() + 1e6 }, 'some-other-secret') })).status, 401, 'signed with the wrong secret');
  assert.equal((await app.get('/api/health', { token: h.signedToken({ role: 'admin', exp: Date.now() + 1e6 }, secret) })).status, 200, 'a correctly signed token works');
  assert.equal((await app.get('/api/health', { headers: { Authorization: 'Basic abc' } })).status, 401);
});

test('a member session is never treated as staff', async () => {
  const member = await app.memberSession('1002');
  assert.equal((await app.get('/api/health', { token: member })).status, 401);
  assert.equal((await app.post('/api/ttt/auto-assign', {}, { token: member })).status, 401);
  assert.equal((await app.post('/api/members/1000', { tier: 'half' }, { token: member })).status, 401);
  // even a hand-signed member token claiming role "admin" fails without the secret
  assert.equal((await app.get('/api/health', { token: h.signedToken({ role: 'admin', exp: Date.now() + 1e6 }, 'guess') })).status, 401);
});

test('unknown API routes 404, preflight is answered, and the page is served', async () => {
  assert.equal((await app.get('/api/nope')).status, 404);
  const pre = await fetch(`${app.base}/api/login`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  const page = await app.get('/');
  assert.equal(page.status, 200);
  assert.match(String(page.body), /Team CRYO-GEN/);
});

test('oversized or non-JSON request bodies are refused and the server keeps serving', async () => {
  // An oversized body makes the server drop the connection (or answer 413); either is fine.
  const big = await fetch(`${app.base}/api/login`, { method: 'POST', body: JSON.stringify({ role: 'admin', password: 'x'.repeat(30000) }) })
    .then(r => r.status, () => 'dropped');
  assert.ok(big === 413 || big === 'dropped', `unexpected: ${big}`);
  const bad = await fetch(`${app.base}/api/login`, { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await app.get('/api/auth/status')).status, 200);
});

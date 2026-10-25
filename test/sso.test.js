'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());

const errorOf = r => decodeURIComponent((/#sso_error=(.+)$/.exec(r.location || '') || [])[1] || '');

test('status tells the page whether sign-in is on', async () => {
  const r = await app.get('/api/auth/status');
  assert.equal(r.body.sso, true);
  assert.equal(r.body.url, 'https://cryogen.team/club-login');
  assert.equal(r.body.requireLogin, false);
});

test('a valid link signs the rider in as themselves, with the roster name', async () => {
  const r = await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1002', name: 'Whatever WP says' })}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /\/#sso=/);
  const session = /#sso=(.+)$/.exec(r.location)[1];
  const me = await app.get('/api/me', { token: session });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { zwid: '1002', name: 'Rider 2', tier: 'full', status: 'active', associate: false }); // last duplicate record wins
});

test('each link works once', async () => {
  const t = h.ssoToken({ zwid: '1002' });
  assert.match((await app.get(`/api/auth/wp?t=${t}`)).location, /#sso=/);
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${t}`)), /already used/);
});

test('expired, forged, over-long and garbage links are refused', async () => {
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1002', expiresInMs: -1000 })}`)), /expired/);
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1002', secret: 'wrong-secret' })}`)), /not valid/);
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1002', expiresInMs: 3 * 3600 * 1000 })}`)), /expired/, 'a link valid for hours is not accepted');
  assert.match(errorOf(await app.get('/api/auth/wp?t=garbage')), /not valid/);
  assert.match(errorOf(await app.get('/api/auth/wp')), /not valid/);
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: 'abc' })}`)), /not valid/, 'non-numeric Zwift ID');
});

test('tampering with the signed part invalidates the link', async () => {
  const [payload, sig] = h.ssoToken({ zwid: '1002' }).split('.');
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), zwid: '1000' })).toString('base64url');
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${other}.${sig}`)), /not valid/);
});

test('a member who has left cannot sign in', async () => {
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1001' })}`)), /no longer active/);
});

test('a rider missing from the roster signs in only if WordPress supplied a name', async () => {
  const ok = await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '55555', name: 'Newbie Nora' })}`);
  const me = await app.get('/api/me', { token: /#sso=(.+)$/.exec(ok.location)[1] });
  assert.equal(me.body.name, 'Newbie Nora');
  assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '55556', name: '' })}`)), /not in the club roster/);
});

test('/api/me needs a member session', async () => {
  assert.equal((await app.get('/api/me')).status, 401);
  assert.equal((await app.get('/api/me', { token: await app.login('admin') })).status, 401);
});

test('without WP_SSO_SECRET the hand-off is refused and the button stays hidden', async () => {
  const saved = process.env.WP_SSO_SECRET;
  delete process.env.WP_SSO_SECRET;
  try {
    assert.equal((await app.get('/api/auth/status')).body.sso, false);
    assert.match(errorOf(await app.get(`/api/auth/wp?t=${h.ssoToken({ zwid: '1002' })}`)), /not set up/);
  } finally { process.env.WP_SSO_SECRET = saved; }
});

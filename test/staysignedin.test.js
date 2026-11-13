'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const totp = require('../lib/totp');

h.setEnv();
let app, owner;
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
const nextCode = secret => { skew += 30000; return totp.code(secret, Date.now()); };
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => { Date.now = realNow; return app.close(); });
beforeEach(async () => { app.world.db = {}; owner = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.token; });
const post = (p, b, t) => app.post(p, b, { token: t });
async function enrol(token) {
  const setup = await post('/api/auth/totp/setup', {}, token), secret = setup.body.secret.replace(/\s/g, '');
  assert.equal((await post('/api/auth/totp/enable', { code: totp.code(secret, Date.now()) }, token)).status, 200);
  return secret;
}

test('"trust this device": after one code, the next sign-in on that device skips the code; another device still needs it; sign out everywhere ends it', async () => {
  const secret = await enrol(owner);
  const s1 = await app.post('/api/login', { role: 'owner', password: 'owner-pw' }); assert.equal(s1.body.twoFactor, true);
  const ok = await post('/api/auth/2fa', { challenge: s1.body.challenge, code: nextCode(secret), trust: true });
  assert.equal(ok.status, 200); assert.ok(ok.body.trustToken, 'a device token comes back when asked');
  const again = await app.post('/api/login', { role: 'owner', password: 'owner-pw', trust: ok.body.trustToken });
  assert.ok(again.body.token, 'no code needed on the trusted device'); assert.equal(again.body.twoFactor, undefined);
  const other = await app.post('/api/login', { role: 'owner', password: 'owner-pw', trust: 'someone-elses-guess' });
  assert.equal(other.body.twoFactor, true, 'another device still needs the code');
  assert.equal((await post('/api/auth/signout-all', {}, again.body.token)).status, 200);
  skew += 1000;
  const after = await app.post('/api/login', { role: 'owner', password: 'owner-pw', trust: ok.body.trustToken });
  assert.equal(after.body.twoFactor, true, 'sign out everywhere ends trusted devices');
});

test('"keep me signed in": a renewal token gives a fresh session, works once, and stops after sign out everywhere', async () => {
  const r = await post('/api/auth/remember', {}, owner); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.refresh);
  const res1 = await app.post('/api/auth/resume', { refresh: r.body.refresh });
  assert.equal(res1.status, 200, JSON.stringify(res1.body)); assert.equal(res1.body.owner, true);
  assert.equal((await app.get('/api/access/me', { token: res1.body.token })).status, 200, 'the new session works');
  assert.equal((await app.post('/api/auth/resume', { refresh: r.body.refresh })).status, 401, 'a renewal token works once: it is swapped each time');
  assert.equal((await post('/api/auth/signout-all', {}, res1.body.token)).status, 200);
  skew += 1000;
  assert.equal((await app.post('/api/auth/resume', { refresh: res1.body.refresh })).status, 401, 'sign out everywhere ends it');
});

test('a rider can stay signed in too; nobody signed out gets a renewal token', async () => {
  const rider = await app.memberSession('1002');
  const r = await post('/api/auth/remember', {}, rider); assert.equal(r.status, 200);
  const back = await app.post('/api/auth/resume', { refresh: r.body.refresh });
  assert.equal(back.status, 200); assert.equal(back.body.role, 'member'); assert.equal(back.body.zwid, '1002');
  assert.equal((await app.post('/api/auth/remember', {})).status, 400);
  assert.equal((await app.post('/api/auth/resume', { refresh: 'made-up' })).status, 401);
});

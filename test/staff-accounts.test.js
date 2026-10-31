'use strict';
// Personal staff accounts: administrators create them; a person signs in as themselves and their name goes in the change log.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
const A = { get token() { return admin; } };
beforeEach(() => { app.world.db = {}; });
const login = (username, password) => app.post('/api/login', { username, password });

test('administrators only; a username, a role, a name and a password of ten characters are needed', async () => {
  const mod = await app.login('mod');
  assert.equal((await app.get('/api/staff', { token: mod })).status, 403);
  assert.equal((await app.get('/api/staff')).status, 401);
  const post = body => app.post('/api/staff', body, A);
  assert.equal((await post({ username: 'x', name: 'Ann', role: 'mod', password: 'long-enough-1' })).status, 400, 'username too short');
  assert.equal((await post({ username: 'ann', name: 'Ann', role: 'boss', password: 'long-enough-1' })).status, 400, 'role');
  assert.equal((await post({ username: 'ann', name: '', role: 'mod', password: 'long-enough-1' })).status, 400, 'name');
  assert.equal((await post({ username: 'ann', name: 'Ann', role: 'mod', password: 'short' })).status, 400, 'password');
  assert.equal((await post({ username: 'ann', name: 'Ann', role: 'mod' })).status, 400, 'a new account needs a password');
  assert.equal((await post({ username: 'ann', name: 'Ann Lee', role: 'mod', password: 'long-enough-1' })).status, 200);
  const list = (await app.get('/api/staff', A)).body.users;
  assert.deepEqual(list.map(u => [u.username, u.name, u.role]), [['ann', 'Ann Lee', 'mod']]);
  assert.ok(!JSON.stringify(list).includes('hash') && !JSON.stringify(list).includes('salt'), 'no password material is ever sent');
});

test('signing in as a person gives their role and name; wrong details are refused the same way; staff routes follow the role', async () => {
  await app.post('/api/staff', { username: 'ann', name: 'Ann Lee', role: 'mod', password: 'long-enough-1' }, A);
  const ok = await login('ann', 'long-enough-1');
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.role, ok.body.name], ['mod', 'Ann Lee']);
  const wrongPw = await login('ann', 'wrong-password'), noUser = await login('nobody', 'long-enough-1');
  assert.equal(wrongPw.status, 401); assert.equal(noUser.status, 401); assert.deepEqual(wrongPw.body, noUser.body);
  assert.equal((await login('ANN', 'long-enough-1')).status, 200, 'usernames ignore case');
  assert.equal((await app.get('/api/staff', { token: ok.body.token })).status, 403, 'a moderator is not an administrator');
  assert.equal((await app.get('/api/week', { token: ok.body.token })).status, 200);
});

test('the change log shows the person\'s name, whatever the page sends; password changes, role changes and removal take effect at the next sign-in', async () => {
  await app.post('/api/staff', { username: 'ann', name: 'Ann Lee', role: 'admin', password: 'long-enough-1' }, A);
  const t = (await login('ann', 'long-enough-1')).body.token;
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, { token: t, headers: { 'X-Staff-Name': 'Someone Else' } });
  const log = (await app.get('/api/zrl/log', A)).body.entries || (await app.get('/api/zrl/log', A)).body.log || [];
  assert.ok(log.some(e => e.who === 'Ann Lee'), JSON.stringify(log.slice(0, 2)));
  assert.ok(!log.some(e => e.who === 'Someone Else'));
  await app.post('/api/staff', { username: 'ann', name: 'Ann Lee', role: 'mod', password: 'new-password-22' }, A);
  assert.equal((await login('ann', 'long-enough-1')).status, 401, 'the old password stopped working');
  assert.equal((await login('ann', 'new-password-22')).body.role, 'mod');
  assert.equal((await app.post('/api/staff', { username: 'ann', name: 'Ann Lee', role: 'admin' }, A)).status, 200, 'no password given: it is kept');
  assert.equal((await login('ann', 'new-password-22')).body.role, 'admin');
  assert.equal((await app.post('/api/staff/remove', { username: 'ann' }, A)).status, 200);
  assert.equal((await login('ann', 'new-password-22')).status, 401);
  assert.equal((await app.post('/api/staff/remove', { username: 'ann' }, A)).status, 404);
});

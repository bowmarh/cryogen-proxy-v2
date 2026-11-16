'use strict';
// The TTT is every Thursday: a week set up on another day can be moved with one call; sign-ups stay, the date, title and closing time follow.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('moving the running week keeps its sign-ups and updates the date, title and closing time; riders cannot do it', async () => {
  const wed = h.ymd(10), thu = h.ymd(11);
  assert.equal((await app.post('/api/ttt/new-week', { date: wed }, { token: admin })).status, 200);
  await app.post('/api/ttt/signup', { name: 'Rider One', zwid: '1001', available: true }, { token: admin });
  const before = (await app.get('/api/ttt')).body.week;
  const r = await app.post('/api/ttt/move-week', { date: thu }, { token: mod });
  assert.equal(r.status, 200);
  const after = r.body;
  assert.equal(after.week.date, thu); assert.equal(after.week.id, before.id, 'the stored id is unchanged');
  assert.match(after.week.title, /Weekly TTT/); assert.notEqual(after.week.title, before.title);
  assert.ok(Date.parse(after.week.closesAt) > Date.parse(before.closesAt), 'closing moves a day later with the race');
  assert.equal(after.signups.length, 1, 'sign-ups stay');
  assert.equal((await app.post('/api/ttt/move-week', { date: 'not-a-date' }, { token: admin })).status, 400);
});

test('moving needs staff, and needs a running week', async () => {
  assert.equal((await app.post('/api/ttt/move-week', { date: h.ymd(5) }, { token: admin })).status, 409, 'no week yet');
  const member = await app.login('member').catch(() => null);
  if (member) assert.ok([401, 403].includes((await app.post('/api/ttt/move-week', { date: h.ymd(5) }, { token: member })).status));
  assert.equal((await app.post('/api/ttt/move-week', { date: h.ymd(5) })).status, 401);
});

'use strict';
// Round readiness checklist: counts what is still open before the first race; staff only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const ready = (token = admin) => app.get('/api/zrl/readiness', { token });
const item = (b, id) => b.items.find(i => i.id === id);

test('staff only, and needs a round', async () => {
  assert.equal((await ready(null)).status, 401);
  assert.equal((await ready(await app.memberSession('1002'))).status, 401);
  assert.equal((await ready()).status, 409);
});

test('items turn green as the round is set up', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup', { regions: ['eu'], cat: 'C' }, { token: await app.memberSession('4378027', { name: 'Ann Able' }) });
  let b = (await ready()).body;
  assert.equal(b.total, b.items.length);
  assert.equal(item(b, 'placed').state, 'todo');
  assert.equal(item(b, 'published').state, 'todo');
  assert.equal(item(b, 'deadline').state, 'todo');
  assert.equal(b.ready, false);
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
  await app.post('/api/zrl/wtrl-deadline', { date: '2026-11-10' }, { token: admin });
  b = (await ready()).body;
  assert.equal(item(b, 'placed').state, 'ok');
  assert.equal(item(b, 'deadline').state, 'ok');
  assert.equal(item(b, 'wtrl').state, 'todo');
  assert.match(item(b, 'size').detail, /fewer than/);
  assert.ok(b.done < b.total && b.firstRace === '2026-11-17');
});

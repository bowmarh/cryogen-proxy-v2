'use strict';
// Change log: staff and members' ZRL changes are recorded (who, when, what) newest first, capped, with no secrets.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());

const log = (token = admin) => app.get('/api/zrl/log', { token });

beforeEach(async () => {
  app.world.db = {};
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 2 }, { token: admin });
});

test('changes are recorded newest first with who made them; only staff can read the log', async () => {
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup', { regions: ['eu'], cat: 'C' }, { token: await app.memberSession('4378027', { name: 'Ann Able' }) });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: mod });
  assert.equal((await log(null)).status, 401);
  assert.equal((await log(await app.memberSession('1002'))).status, 401);
  const e = (await log(mod)).body.entries;
  assert.deepEqual(e.map(x => x.route), ['zrl/assign', 'zrl/signup', 'zrl/teams', 'zrl/round']);
  assert.deepEqual([e[0].role, e[0].who], ['mod', '']);
  assert.equal(e[1].role, 'member'); assert.match(e[1].who, /Ann/);
  assert.match(e[0].what, /team=cryo-gen-alpha/); assert.match(e[0].what, /key=4378027/);
  assert.equal(e[2].what, 'teams=1', 'lists are counted, not copied');
  assert.ok(Date.parse(e[0].ts) <= Date.now());
});

test('secrets never reach the log, failed requests are not logged, and the log is capped', async () => {
  await app.post('/api/zrl/round-delete', { confirm: 'wrong', password: 'hunter2', token: 'abc' }, { token: admin });   // refused: wrong confirmation
  assert.ok(!(await log()).body.entries.some(x => x.route === 'zrl/round-delete'), 'a refused request changed nothing');
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'nope' }], password: 'hunter2', token: 'abc' }, { token: admin });   // also refused
  await app.post('/api/zrl/status', { open: false, password: 'hunter2', secret: 's3', token: 'tok' }, { token: admin });
  const text = JSON.stringify((await log()).body.entries);
  assert.ok(!/hunter2|s3|tok/.test(text.replace(/token/g, '')), 'no secret values');
  assert.match(text, /open=false/);
  for (let i = 0; i < 6; i++) await app.post('/api/zrl/status', { open: i % 2 === 0 }, { token: admin });
  assert.ok((await log()).body.entries.length <= 100, 'the page is capped');
});

test('only the latest 500 entries are kept', async () => {
  for (let i = 0; i < 505; i++) await app.post('/api/zrl/status', { open: i % 2 === 0 }, { token: admin });
  assert.equal(app.world.db['cg:zrl:log'].length, 500);
  assert.equal((await log()).body.entries.length, 100, 'and a page shows the newest 100');
});

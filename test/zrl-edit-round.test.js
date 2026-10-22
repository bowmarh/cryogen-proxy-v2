'use strict';
// Correcting a round's name and dates without losing the sign-ups and teams.
const { test, before, after, beforeEach } = require('node:test');
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
beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Team Tempo', start: '2026-10-27', closes: '2026-10-26' }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
  app.world.discord.length = 0;
});
const edit = (body, token = admin) => app.post('/api/zrl/round-edit', body, { token });
const view = () => app.get('/api/zrl', { token: admin }).then(r => r.body);

test('staff only, and the dates must be real', async () => {
  assert.equal((await edit({ name: 'R', start: '2026-11-17' }, null)).status, 401);
  assert.equal((await edit({ name: 'R', start: '2026-11-17' }, await app.memberSession('1002'))).status, 401);
  assert.equal((await edit({ name: '', start: '2026-11-17' })).status, 400);
  assert.equal((await edit({ name: 'R', start: '2026-13-45' })).status, 400);
  assert.equal((await edit({ name: 'R', start: '2026-11-17', closes: 'soon' })).status, 400);
});

test('new name and dates; sign-ups, teams and placements stay; nothing is announced', async () => {
  const r = await edit({ name: 'Round 2: Team Tempo', start: '2026-11-17', closes: '2026-11-12', weeks: 6 });
  assert.equal(r.status, 200);
  const v = await view();
  assert.deepEqual([v.round.name, v.round.start, v.round.id], ['Round 2: Team Tempo', '2026-11-17', '2026-11-17']);
  assert.ok(v.round.closesAt.startsWith('2026-11-12T'), v.round.closesAt);
  assert.equal(v.round.open, true);
  assert.equal(v.signups.length, 1);
  assert.equal(v.round.teams.length, 1);
  assert.equal(v.assign['4378027'], 'cryo-gen-alpha');
  assert.equal(app.world.discord.length, 0, 'editing posts nothing');
});

test('clearing the close date, and starting dates that clash with an archived round', async () => {
  assert.equal((await edit({ name: 'Team Tempo', start: '2026-10-27', closes: '' })).status, 200);
  assert.equal((await view()).round.closesAt, null);
  await app.post('/api/zrl/round', { name: 'Next', start: '2026-12-01', closes: h.ymd(20) }, { token: admin });   // archives the first
  assert.equal((await edit({ name: 'Next', start: '2026-10-27' })).status, 409, 'an earlier round already started that day');
  assert.equal((await edit({ name: 'Next', start: '2026-12-01' })).status, 200, 'keeping its own date is fine');
});

test('new dates start the reminder and close clean', async () => {
  app.world.db['cg:zrl:sent'] = { '2026-10-27:reminder': 'x', '2026-10-27:close': 'x', '2026-10-27:published': 'x' };
  await edit({ name: 'Round 2', start: '2026-11-17', closes: '2026-11-12' });
  assert.deepEqual(Object.keys(app.world.db['cg:zrl:sent']), ['2026-10-27:published']);
});

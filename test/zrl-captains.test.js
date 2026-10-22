'use strict';
// Captains: a rider with the star becomes captain automatically; staff can choose by hand, clear, or move a spare volunteer.
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
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }, { name: 'CRYO-GEN Gamma', region: 'eu', captain: '1000' }, { name: 'CRYO-GEN Empty', region: 'am' }] }, { token: admin });
});
const join = (name, zwid, extra = {}) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C', ...extra });
const put = (key, team) => app.post('/api/zrl/assign', { key, team }, { token: admin });
const captain = (body, token = admin) => app.post('/api/zrl/captain', body, { token });
const teams = async () => Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(t => [t.id, t]));

test('choosing a captain by hand is staff only, from the team\'s own riders, with a Zwift ID', async () => {
  await join('Rider 2', '1002'); await join('No Id Nick', ''); await join('Bob Baker', '2436518');
  await put('1002', 'cryo-gen-alpha'); await put('no id nick', 'cryo-gen-alpha'); await put('2436518', 'cryo-gen-beta');
  const member = await app.memberSession('1002');
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '1002' }, null)).status, 401);
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '1002' }, member)).status, 401);
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '2436518' })).status, 400, 'on another team');
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: 'nobody' })).status, 400);
  const noId = await captain({ team: 'cryo-gen-alpha', key: 'no id nick' });
  assert.equal(noId.status, 400); assert.match(noId.body.error, /no Zwift ID/);
  assert.equal((await captain({ team: 'nope', key: '1002' })).status, 404);
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '1002' })).status, 200);
  const alpha = (await teams())['cryo-gen-alpha'];
  assert.deepEqual([alpha.captain, alpha.captainName], ['1002', 'Rider 2']);
});

test('a rider with the star becomes captain as soon as they are on a team; no star, no captain; an existing captain stays', async () => {
  await join('Rider 2', '1002', { captain: true }); await join('Ann Able', '4378027'); await join('Bob Baker', '2436518'); await join('Rider 0', '1000', { captain: true });
  await put('4378027', 'cryo-gen-beta'); await put('2436518', 'cryo-gen-beta');
  assert.equal((await teams())['cryo-gen-beta'].captain, '', 'nobody on Beta has the star');
  await put('1002', 'cryo-gen-alpha');
  await put('1000', 'cryo-gen-gamma');
  const t = await teams();
  assert.deepEqual([t['cryo-gen-alpha'].captain, t['cryo-gen-alpha'].captainName], ['1002', 'Rider 2']);
  assert.equal(t['cryo-gen-gamma'].captain, '1000', 'kept');
  assert.equal(t['cryo-gen-empty'].captain, '', 'no riders, no captain');
});

test('a volunteer without a Zwift ID cannot captain; ticking the star later makes a rider captain', async () => {
  await join('No Id Nick', '', { captain: true }); await join('Ann Able', '4378027');
  await put('no id nick', 'cryo-gen-alpha'); await put('4378027', 'cryo-gen-alpha');
  assert.equal((await teams())['cryo-gen-alpha'].captain, '');
  await join('Ann Able', '4378027', { captain: true });   // she ticks the star
  assert.equal((await teams())['cryo-gen-alpha'].captain, '4378027');
});

test('several stars in one team: the earliest sign-up captains it, and the others can be moved to a team that has none', async () => {
  await join('Rider 2', '1002', { captain: true, preferred: 'cryo-gen-alpha' });
  await new Promise(r => setTimeout(r, 15));
  await join('Ann Able', '4378027', { captain: true, preferred: 'cryo-gen-alpha' });
  const plan = (await app.post('/api/zrl/auto-assign', {}, { token: admin })).body.plan;
  assert.deepEqual(plan.moves.filter(m => m.captain).map(m => m.name), ['Rider 2'], 'the preview shows the same captain');
  await app.post('/api/zrl/auto-assign', { apply: true }, { token: admin });
  const t = await teams();
  assert.equal(t['cryo-gen-alpha'].captain, '1002', 'first to sign up');
  await put('4378027', 'cryo-gen-beta');   // the spare volunteer moves to a team without a captain
  const after = await teams();
  assert.deepEqual([after['cryo-gen-alpha'].captain, after['cryo-gen-beta'].captain, after['cryo-gen-beta'].captainName], ['1002', '4378027', 'Ann Able']);
});

test('when several starred riders arrive on a team together (an import), the earliest sign-up is the captain', async () => {
  await join('Rider 2', '1002', { captain: true });
  await new Promise(r => setTimeout(r, 15));
  await join('Ann Able', '4378027', { captain: true });
  // placed in one go, later sign-up listed first, as an import could do
  app.world.db['cg:zrl:assign'] = { 4378027: 'cryo-gen-alpha', 1002: 'cryo-gen-alpha' };
  await app.post('/api/zrl/status', { open: true }, { token: admin });   // any change triggers the pick
  assert.equal((await teams())['cryo-gen-alpha'].captain, '1002');
});

test('a captain cleared by hand stays cleared; choosing one again unlocks automatic picking', async () => {
  await join('Rider 2', '1002', { captain: true }); await join('Ann Able', '4378027', { captain: true });
  await put('1002', 'cryo-gen-alpha');
  assert.equal((await teams())['cryo-gen-alpha'].captain, '1002');
  await captain({ team: 'cryo-gen-alpha', key: '' });
  await put('4378027', 'cryo-gen-alpha');   // another change: still no captain
  assert.equal((await teams())['cryo-gen-alpha'].captain, '', 'deliberately cleared');
  await captain({ team: 'cryo-gen-alpha', key: '4378027' });
  assert.equal((await teams())['cryo-gen-alpha'].captain, '4378027');
});

test('clearing the captain in the team editor also stops automatic picking', async () => {
  await join('Rider 2', '1002', { captain: true }); await put('1002', 'cryo-gen-alpha');
  assert.equal((await teams())['cryo-gen-alpha'].captain, '1002');
  const list = Object.values(await teams()).map(t => ({ name: t.name, region: t.region, slot: t.slot, captain: t.id === 'cryo-gen-alpha' ? '' : t.captain }));
  await app.post('/api/zrl/teams', { teams: list }, { token: admin });
  await join('Ann Able', '4378027', { captain: true }); await put('4378027', 'cryo-gen-alpha');
  assert.equal((await teams())['cryo-gen-alpha'].captain, '');
});

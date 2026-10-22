'use strict';
// Choosing captains from a team's own riders, and picking them from the volunteers.
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
  const join = (name, zwid, extra = {}) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C', ...extra });
  await join('Rider 2', '1002', { captain: true }); await join('Ann Able', '4378027'); await join('No Id Nick', '', { captain: true });
  await join('Bob Baker', '2436518'); await join('Rider 0', '1000', { captain: true });
  for (const [k, t] of [['1002', 'cryo-gen-alpha'], ['4378027', 'cryo-gen-alpha'], ['no id nick', 'cryo-gen-alpha'], ['2436518', 'cryo-gen-beta'], ['1000', 'cryo-gen-gamma']]) await app.post('/api/zrl/assign', { key: k, team: t }, { token: admin });
});
const captain = (body, token = admin) => app.post('/api/zrl/captain', body, { token });
const auto = (token = admin) => app.post('/api/zrl/captains-auto', {}, { token });
const teams = async () => Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(t => [t.id, t]));

test('both are staff only', async () => {
  const member = await app.memberSession('1002');
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '1002' }, null)).status, 401);
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '1002' }, member)).status, 401);
  assert.equal((await auto(null)).status, 401);
  assert.equal((await auto(member)).status, 401);
});

test('pick a captain from the team\'s riders; the rider then sees the team as theirs to register', async () => {
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '4378027' })).status, 200);
  const alpha = (await teams())['cryo-gen-alpha'];
  assert.deepEqual([alpha.captain, alpha.captainName], ['4378027', 'Ann Able']);
  await captain({ team: 'cryo-gen-alpha', key: '1002' });
  const mine = (await app.get('/api/zrl/mine', { token: await app.memberSession('1002') })).body;
  assert.equal(mine.captainOf[0].name, 'CRYO-GEN Alpha');
  assert.equal(mine.captainOf[0].captainName, 'Rider 2', 'named from the club roster');
});

test('the captain must be on that team and have a Zwift ID; an empty choice clears it', async () => {
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: '2436518' })).status, 400, 'on another team');
  assert.equal((await captain({ team: 'cryo-gen-alpha', key: 'nobody' })).status, 400);
  const noId = await captain({ team: 'cryo-gen-alpha', key: 'no id nick' });
  assert.equal(noId.status, 400); assert.match(noId.body.error, /no Zwift ID/);
  assert.equal((await captain({ team: 'nope', key: '1002' })).status, 404);
  assert.equal((await captain({ team: 'cryo-gen-gamma', key: '' })).status, 200);
  assert.equal((await teams())['cryo-gen-gamma'].captain, '');
});

test('pick from the volunteers: only teams with riders and no captain; an existing captain is never replaced', async () => {
  const r = await auto();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.captains.picked, [{ team: 'CRYO-GEN Alpha', name: 'Rider 2' }], 'no Id Nick volunteered too but has no ID');
  assert.deepEqual(r.body.captains.missing, ['CRYO-GEN Beta'], 'Beta has riders but no volunteer; Empty has no riders so is not listed');
  const t = await teams();
  assert.equal(t['cryo-gen-alpha'].captain, '1002');
  assert.equal(t['cryo-gen-gamma'].captain, '1000', 'kept');
  assert.equal(t['cryo-gen-beta'].captain, '');
  assert.deepEqual((await auto()).body.captains.picked, [], 'running it again changes nothing');
});

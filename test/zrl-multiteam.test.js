'use strict';
// A rider can ride for several ZRL teams (different leagues and race times).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(async () => { app.world.db = {}; await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(20), closes: h.ymd(10), weeks: 2 }, { token: admin }); });

const view = token => app.get('/api/zrl', { token }).then(r => r.body);
const place = (key, team, extra = {}) => app.post('/api/zrl/assign', { key, team, ...extra }, { token: admin });
const teamsSetup = () => app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Bravo', region: 'am' }, { name: 'CRYO-GEN Charlie', region: 'eu' }] }, { token: admin });

test('staff put one rider on several teams, take one off, or clear them all', async () => {
  await teamsSetup();
  await app.post('/api/zrl/signup-edit', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' }, { token: admin });
  assert.equal((await place('4378027', 'cryo-gen-alpha')).status, 200);
  assert.equal((await place('4378027', 'cryo-gen-bravo', { add: true })).status, 200);
  assert.equal((await place('4378027', 'cryo-gen-bravo', { add: true })).status, 200, 'adding twice changes nothing');
  assert.equal((await place('4378027', '', { add: true })).status, 400);
  let v = await view(admin);
  assert.deepEqual(v.placements['4378027'], ['cryo-gen-alpha', 'cryo-gen-bravo']);
  assert.equal(v.assign['4378027'], 'cryo-gen-alpha', 'the first team still shows in assign');
  assert.equal((await place('4378027', 'cryo-gen-alpha', { remove: true })).status, 200);
  assert.deepEqual((await view(admin)).placements['4378027'], ['cryo-gen-bravo']);
  assert.equal((await place('4378027', 'cryo-gen-charlie')).status, 200, 'without add, it replaces');
  assert.deepEqual((await view(admin)).placements['4378027'], ['cryo-gen-charlie']);
  assert.equal((await place('4378027', 'cryo-gen-bravo', { remove: true })).status, 200);
  assert.equal((await place('4378027', 'cryo-gen-charlie', { remove: true })).status, 200);
  assert.deepEqual((await view(admin)).placements, {});
});

test('the rider sees every team they ride for once published, and each team lists them', async () => {
  await teamsSetup();
  const t = await app.memberSession('4378027', { name: 'Ann Able' });
  await app.post('/api/zrl/signup', { regions: ['eu', 'am'], cat: 'C', also: ['cryo-gen-bravo', 'nope'] }, { token: t });
  const mine = async () => (await app.get('/api/zrl/mine', { token: t })).body;
  assert.deepEqual((await mine()).signup.also, ['cryo-gen-bravo'], 'the request is kept, unknown teams dropped');
  assert.equal((await view(admin)).signups.find(s => s.key === '4378027').also.length, 1, 'staff see the request');
  await place('4378027', 'cryo-gen-alpha');
  await place('4378027', 'cryo-gen-bravo', { add: true });
  assert.deepEqual((await mine()).teams, [], 'nothing shows before publishing');
  await app.post('/api/zrl/status', { published: true }, { token: admin });
  const m = await mine();
  assert.equal(m.placed, true);
  assert.deepEqual(m.teams.map(x => x.name), ['CRYO-GEN Alpha', 'CRYO-GEN Bravo']);
  assert.ok(m.teams.every(x => x.riders.some(r => r.name === 'Ann Able')), 'listed on both');
  assert.ok(m.teams.every(x => x.weeks.length === 2));
});

test('captains of either team can answer for the rider, and a captain must be on the team', async () => {
  await teamsSetup();
  await app.post('/api/zrl/signup-edit', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' }, { token: admin });
  await app.post('/api/zrl/signup-edit', { name: 'Cap Two', zwid: '1002', regions: ['am'], cat: 'C' }, { token: admin });
  await place('4378027', 'cryo-gen-alpha'); await place('4378027', 'cryo-gen-bravo', { add: true }); await place('1002', 'cryo-gen-bravo');
  assert.equal((await app.post('/api/zrl/captain', { team: 'cryo-gen-bravo', key: '4378027' }, { token: admin })).status, 200, 'on bravo, so allowed');
  assert.equal((await app.post('/api/zrl/captain', { team: 'cryo-gen-charlie', key: '4378027' }, { token: admin })).status, 400, 'not on charlie');
  const cap = await app.memberSession('1002', { name: 'Cap Two' });
  await app.post('/api/zrl/captain', { team: 'cryo-gen-bravo', key: '1002' }, { token: admin });
  assert.equal((await app.post('/api/zrl/availability', { week: 0, status: 'yes', zwid: '4378027' }, { token: cap })).status, 200, 'the captain of one of the rider\'s teams');
});

test('removing a team takes riders off it but keeps their other teams', async () => {
  await teamsSetup();
  await app.post('/api/zrl/signup-edit', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' }, { token: admin });
  await place('4378027', 'cryo-gen-alpha'); await place('4378027', 'cryo-gen-bravo', { add: true });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Bravo', region: 'am' }] }, { token: admin });
  assert.deepEqual((await view(admin)).placements['4378027'], ['cryo-gen-bravo']);
});

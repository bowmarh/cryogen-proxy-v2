'use strict';
// Rollover: starting the next round archives this one and can carry the teams, the placed riders and their captains over.
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

const state = async () => (await app.get('/api/zrl', { token: admin })).body;
const start2 = (extra = {}) => app.post('/api/zrl/round', { name: 'Round 3', start: '2027-04-13', closes: h.ymd(10), ...extra }, { token: admin });

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', league: 'Mint', slot: 'Tue 18:15 UTC', captain: '1002' },
    { name: 'CRYO-GEN Beta', region: 'ap', league: 'Pink', slot: 'Tue 08:30 UTC', captain: '9999' },
    { name: 'CRYO-GEN Gamma', region: 'am', league: '', slot: 'hand set' }] }, { token: admin });
  const people = [['Rider 2', '1002', true], ['Ann Able', '4378027', true], ['Bob Baker', '2436518', true], ['Out Olly', '1000', false]];
  for (const [n, z, inn] of people) await app.post('/api/zrl/signup', { name: n, zwid: z, in: inn, regions: inn ? ['eu'] : [], cat: 'C' });
  await app.post('/api/zrl/signup', { name: 'Loose Larry', zwid: '2000', regions: ['eu'], cat: 'C' });   // in, but never placed
  for (const [z, t] of [['1002', 'cryo-gen-alpha'], ['4378027', 'cryo-gen-alpha'], ['2436518', 'cryo-gen-beta'], ['1000', 'cryo-gen-beta']]) await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
});

test('carrying riders keeps the placed riders on their teams, the captain who is still there, and recalculates race times', async () => {
  assert.equal((await start2({ carryRiders: true })).status, 200);
  const s = await state();
  assert.equal(s.round.name, 'Round 3'); assert.equal(s.round.open, true); assert.equal(s.round.published, false);
  assert.deepEqual(s.signups.map(x => x.name).sort(), ['Ann Able', 'Bob Baker', 'Rider 2'], 'only riders who are in and placed');
  assert.ok(s.signups.every(x => x.in));
  assert.deepEqual(Object.entries(s.assign).sort(), [['1002', 'cryo-gen-alpha'], ['2436518', 'cryo-gen-beta'], ['4378027', 'cryo-gen-alpha']]);
  const t = Object.fromEntries(s.round.teams.map(x => [x.id, x]));
  assert.equal(t['cryo-gen-alpha'].captain, '1002', 'still on the team, still captain');
  assert.equal(t['cryo-gen-beta'].captain, '', 'a captain who is not carried over is dropped');
  assert.equal(t['cryo-gen-alpha'].slot, 'Tue 17:15 UTC', 'Mint is 7:15 PM in Paris: one hour earlier in UTC once summer time starts');
  assert.equal(t['cryo-gen-beta'].slot, 'Tue 09:30 UTC', 'Pink follows Sydney, back to standard time in April');
  assert.equal(t['cryo-gen-gamma'].slot, '', 'no league colour, no guess');
  const archived = JSON.parse(app.world.db['cg:zrl:archive']['2026-11-17']);
  assert.equal(archived.signups.length, 5, 'the old round keeps everyone');
});

test('without the riders, teams carry over empty with no captains and fresh race times', async () => {
  assert.equal((await start2()).status, 200);
  const s = await state();
  assert.equal(s.signups.length, 0); assert.deepEqual(s.assign, {});
  assert.deepEqual(s.round.teams.map(t => t.captain), ['', '', '']);
  assert.deepEqual(s.round.teams.map(t => t.name), ['CRYO-GEN Alpha', 'CRYO-GEN Beta', 'CRYO-GEN Gamma']);
});

test('a carried rider can still change their own sign-up and keeps their place; the first ever round ignores the option', async () => {
  await start2({ carryRiders: true });
  const ann = await app.memberSession('4378027');
  assert.equal((await app.post('/api/zrl/signup', { regions: ['eu', 'am'], cat: 'B' }, { token: ann })).status, 200);
  const s = await state();
  assert.equal(s.assign['4378027'], 'cryo-gen-alpha', 'still on their team');
  assert.deepEqual(s.signups.find(x => x.zwid === '4378027').regions, ['eu', 'am']);
  app.world.db = {};
  assert.equal((await start2({ carryRiders: true })).status, 200, 'no earlier round: nothing to carry, no error');
});

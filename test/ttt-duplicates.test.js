'use strict';
// One rider is one Zwift ID: spelling or sign-in method must not give a rider two TTT sign-ups.
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
  await app.post('/api/ttt/new-week', { date: h.ymd(9) }, { token: admin });
});
const week = token => app.get('/api/ttt', { token }).then(r => r.body);
const guest = (name, zwid, extra = {}) => app.post('/api/ttt/signup', { name, zwid, preferred: [], ...extra });
const teamId = async () => (await week(admin)).week.teams[0].id;

test('spacing and case alone never make a second sign-up', async () => {
  await guest('Larry Stranko', '');
  await guest('  larry   stranko ', '');
  const w = await week(admin);
  assert.equal(w.signups.length, 1);
});

test('once line-ups are out, a re-sign-up under another spelling is not treated as a late sign-up', async () => {
  const team = await teamId();
  await app.post('/api/ttt/status', { published: true }, { token: admin });
  await guest('Larry Stranko (Cryo-Gen)', '2304344', { preferred: [team] });
  const posts = app.world.discord.length;
  await guest('Larry Stranko (Cryo-Gen, BON)', '2304344', { preferred: [team] });
  assert.equal(app.world.discord.length, posts, 'no second "late sign-up" or waitlist message');
  assert.equal((await week(admin)).signups.length, 1);
});

test('the same Zwift ID under a different spelling updates the one sign-up, which keeps its name, queue place and team', async () => {
  await guest('Larry Stranko (Cryo-Gen)', '2304344', { style: 'casual' });
  const first = (await week(admin)).signups[0];
  const team = await teamId();
  await app.post('/api/ttt/assign', { name: 'Larry Stranko (Cryo-Gen)', teams: [team] }, { token: admin });
  await guest('Larry Stranko (Cryo-Gen, BON)', '2304344', { style: 'race', captain: true });
  const w = await week(admin);
  assert.equal(w.signups.length, 1, 'no second sign-up');
  assert.equal(w.signups[0].name, 'Larry Stranko (Cryo-Gen)', 'the first spelling stays, so the team place stays');
  assert.deepEqual([w.signups[0].style, w.signups[0].captain, w.signups[0].ts], ['race', true, first.ts], 'answers updated, queue place kept');
  assert.deepEqual(w.assign['larry stranko (cryo-gen)'], [team]);
});

test('a signed-in member who earlier signed up as a guest under another name gets one sign-up, and My TTT finds it', async () => {
  await guest('Rider Zero (guest spelling)', '1000');
  const member = await app.memberSession('1000', { name: 'Rick DB' });
  assert.equal((await app.post('/api/ttt/signup', { preferred: [], style: 'race' }, { token: member })).status, 200);
  const w = await week(admin);
  assert.equal(w.signups.length, 1);
  assert.equal(w.signups[0].style, 'race');
  const mine = (await app.get('/api/ttt/mine', { token: member })).body;
  assert.equal(mine.signup.style, 'race', 'found by Zwift ID although the names differ');
});

test('different riders with different IDs stay separate; riders with no ID are matched by name only', async () => {
  await guest('Ann Able', '4378027'); await guest('Bob Baker', '2436518'); await guest('No Id Nick', ''); await guest('No Id Nick', '');
  assert.equal((await week(admin)).signups.length, 3);
});

test('withdrawing removes every sign-up carrying the rider\'s Zwift ID', async () => {
  await guest('Larry Stranko', '2304344');
  // a legacy second entry, as an earlier version could create
  const db = app.world.db['cg:ttt:signups'];
  db['larry s.'] = JSON.stringify({ ...JSON.parse(db['larry stranko']), name: 'Larry S.', ts: '2999-01-01T00:00:00.000Z' });
  await app.post('/api/ttt/withdraw', { name: 'Larry Stranko', zwid: '2304344' });
  assert.deepEqual(Object.keys(app.world.db['cg:ttt:signups'] || {}), []);
});

test('existing duplicates are merged when the page loads: earliest name and place, latest answers, team places combined, captaincy follows', async () => {
  await guest('Larry Stranko (Cryo-Gen)', '2304344', { preferred: [] });
  const [t1, t2] = (await week(admin)).week.teams.map(t => t.id);
  const db = app.world.db['cg:ttt:signups'];
  const old = JSON.parse(db['larry stranko (cryo-gen)']);
  db['larry stranko (cryo-gen)'] = JSON.stringify({ ...old, ts: '2026-10-22T10:50:45.907Z', style: 'casual', captain: true });
  db[' larry  stranko (cryo-gen ,  bon)'] = JSON.stringify({ ...old, name: ' larry  stranko (cryo-gen ,  BON)', ts: '2026-10-22T21:47:41.038Z', style: 'race', captain: false });
  app.world.db['cg:ttt:assign'] = { ' larry  stranko (cryo-gen ,  bon)': JSON.stringify([t2]), 'larry stranko (cryo-gen)': JSON.stringify([t1]) };
  const weekJson = JSON.parse(app.world.db['cg:ttt:week']);
  app.world.db['cg:ttt:week'] = JSON.stringify({ ...weekJson, captains: { [t2]: ' larry  stranko (cryo-gen ,  bon)' } });
  const w = await week(admin);
  assert.equal(w.signups.length, 1);
  const s = w.signups[0];
  assert.deepEqual([s.name, s.ts, s.style, s.captain], ['Larry Stranko (Cryo-Gen)', '2026-10-22T10:50:45.907Z', 'race', false], 'the later answers win, even un-ticking captain');
  assert.deepEqual(w.assign['larry stranko (cryo-gen)'].sort(), [t1, t2].sort());
  assert.equal(Object.keys(w.assign).length, 1);
  assert.equal(JSON.parse(app.world.db['cg:ttt:week']).captains[t2], 'larry stranko (cryo-gen)');
  assert.equal((await week(admin)).signups.length, 1, 'merging again changes nothing');
});

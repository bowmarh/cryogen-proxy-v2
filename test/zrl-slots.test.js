'use strict';
// Race times for a whole league at once, and the team editor keeping what it is not editing.
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
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', league: 'Lime', division: 'Division 1', grade: 'Open B' },
    { name: 'CRYO-GEN Beta', region: 'eu', league: 'Lime' }, { name: 'CRYO-GEN Gamma', region: 'am', league: 'Indigo' },
  ] }, { token: admin });
});
const slot = (body, token = admin) => app.post('/api/zrl/team-slot', body, { token });
const teams = async () => Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(t => [t.id, t]));

test('one race time for several teams: staff only, real teams only', async () => {
  assert.equal((await slot({ teams: ['cryo-gen-alpha'], slot: 'x' }, null)).status, 401);
  assert.equal((await slot({ teams: ['cryo-gen-alpha'], slot: 'x' }, await app.memberSession('1002'))).status, 401);
  assert.equal((await slot({ teams: [], slot: 'x' })).status, 400);
  assert.equal((await slot({ teams: ['nope'], slot: 'x' })).status, 400);
  assert.equal((await slot({ teams: ['cryo-gen-alpha'], slot: 'y'.repeat(50) })).status, 400, 'too long');
});

test('a league gets its race time in one go; other teams are untouched; an empty time clears it', async () => {
  assert.equal((await slot({ teams: ['cryo-gen-alpha', 'cryo-gen-beta'], slot: 'Tue 17:00 UTC' })).status, 200);
  let t = await teams();
  assert.deepEqual([t['cryo-gen-alpha'].slot, t['cryo-gen-beta'].slot, t['cryo-gen-gamma'].slot], ['Tue 17:00 UTC', 'Tue 17:00 UTC', '']);
  await slot({ teams: ['cryo-gen-beta'], slot: '' });
  t = await teams();
  assert.equal(t['cryo-gen-beta'].slot, '');
  assert.equal(t['cryo-gen-alpha'].slot, 'Tue 17:00 UTC');
});

test('saving the team editor keeps the league, and a captain\'s name when the captain is unchanged', async () => {
  await app.post('/api/zrl/signup', { name: 'Zed Not In Roster', zwid: '7777777', regions: ['eu'], cat: 'C', captain: true });
  await app.post('/api/zrl/assign', { key: '7777777', team: 'cryo-gen-alpha' }, { token: admin });
  let t = await teams();
  assert.deepEqual([t['cryo-gen-alpha'].captain, t['cryo-gen-alpha'].captainName], ['7777777', 'Zed Not In Roster'], 'picked automatically from the star');
  const list = Object.values(t).map(x => ({ name: x.name, region: x.region, slot: 'Tue 19:00 UTC', captain: x.captain }));
  assert.equal((await app.post('/api/zrl/teams', { teams: list }, { token: admin })).status, 200);
  t = await teams();
  assert.deepEqual([t['cryo-gen-alpha'].league, t['cryo-gen-alpha'].division, t['cryo-gen-gamma'].league], ['Lime', 'Division 1', 'Indigo']);
  assert.equal(t['cryo-gen-alpha'].captainName, 'Zed Not In Roster', 'the name is not lost when the ID is not in the club roster');
});

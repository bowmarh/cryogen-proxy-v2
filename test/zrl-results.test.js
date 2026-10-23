'use strict';
// Results and standings: staff enter each team's finish and points per race; everyone sees the standings per division.
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

const save = (week, rows, token = admin) => app.post('/api/zrl/results', { week, rows }, { token });
const standings = token => app.get('/api/zrl/standings', { token }).then(r => r.body);

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(-14), closes: h.ymd(-20), weeks: 3 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }, { name: 'CRYO-GEN Beta', region: 'eu', division: 'Division 1' },
    { name: 'CRYO-GEN Gamma', region: 'am', division: 'Division 2' }, { name: 'CRYO-GEN Quiet', region: 'am', division: 'Division 2' }] }, { token: admin });
});

test('entering results is staff only and validated; blanks clear an entry', async () => {
  const rows = [{ team: 'cryo-gen-alpha', pos: 3, pts: 120 }];
  assert.equal((await save(0, rows, null)).status, 401);
  assert.equal((await save(0, rows, await app.memberSession('1002'))).status, 401);
  assert.equal((await save(9, rows)).status, 400, 'no such week');
  assert.equal((await save(0, [])).status, 400);
  assert.equal((await save(0, [{ team: 'nope', pos: 1 }])).status, 404);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: 0 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: 2.5 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pts: -1 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pts: 'lots' }])).status, 400);
  assert.equal((await save(0, rows)).status, 200);
  assert.equal((await standings()).groups[0].teams[0].total, 120);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: '', pts: '' }])).status, 200);
  assert.deepEqual((await standings()).groups, [], 'cleared');
});

test('standings rank teams within their division by total points, then best finish, with shared ranks for ties; teams with nothing yet are left out', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 2, pts: 100 }, { team: 'cryo-gen-beta', pos: 1, pts: 120 }, { team: 'cryo-gen-gamma', pos: 5, pts: 50 }]);
  await save(1, [{ team: 'cryo-gen-alpha', pos: 1, pts: 130 }, { team: 'cryo-gen-beta', pos: 4, pts: 110 }]);
  const s = await standings();
  assert.equal(s.dates.length, 3);
  assert.deepEqual(s.groups.map(g => g.name), ['Division 1', 'Division 2']);
  const d1 = s.groups[0].teams;
  assert.deepEqual(d1.map(t => [t.name, t.total, t.best, t.rank, t.races]), [['CRYO-GEN Alpha', 230, 1, 1, 2], ['CRYO-GEN Beta', 230, 1, 1, 2]], 'level on points and best finish: shared rank');
  assert.deepEqual(d1[0].weeks.map(w => w && [w.pos, w.pts]), [[2, 100], [1, 130], null]);
  assert.deepEqual(s.groups[1].teams.map(t => t.name), ['CRYO-GEN Gamma'], 'a team with no result is not listed');
  assert.equal(s.entries, undefined, 'the public does not get the raw entries');
});

test('staff also get the raw entries with notes, and starting the next round archives and clears the results', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 1, pts: 150, note: 'won the sprint' }]);
  const staff = await standings(admin);
  assert.equal(staff.entries['0:cryo-gen-alpha'].note, 'won the sprint');
  await app.post('/api/zrl/round', { name: 'Round 3', start: h.ymd(30), closes: h.ymd(25) }, { token: admin });
  assert.deepEqual((await standings()).groups, []);
  const id = Object.keys(app.world.db['cg:zrl:archive'])[0];
  assert.equal(JSON.parse(app.world.db['cg:zrl:archive'][id]).results['0:cryo-gen-alpha'].pts, 150);
});

test('level on points, the better best finish ranks higher; more points always wins', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 3, pts: 100 }, { team: 'cryo-gen-beta', pos: 2, pts: 100 }]);
  assert.deepEqual((await standings()).groups[0].teams.map(t => [t.name, t.rank]), [['CRYO-GEN Beta', 1], ['CRYO-GEN Alpha', 2]]);
  await save(1, [{ team: 'cryo-gen-alpha', pts: 5 }]);
  assert.deepEqual((await standings()).groups[0].teams.map(t => [t.name, t.rank]), [['CRYO-GEN Alpha', 1], ['CRYO-GEN Beta', 2]], 'points count even with no position');
});

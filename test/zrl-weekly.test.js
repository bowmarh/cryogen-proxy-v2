'use strict';
// Weekly: riders say whether they can race, captains pick the line-up, staff see the gaps, the health panel warns before a race.
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

const ZW = ['1002', '4378027', '2436518'];
let cap, ann, bob, outsider;
beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 3 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', league: 'Mint' }, { name: 'CRYO-GEN Beta', region: 'eu', league: 'Pink' }] }, { token: admin });
  for (const [n, z] of [['Rider 2', '1002'], ['Ann Able', '4378027'], ['Bob Baker', '2436518']]) await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
  await app.post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' }, { token: admin });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
  await app.post('/api/zrl/assign', { key: '2436518', team: 'cryo-gen-beta' }, { token: admin });
  await app.post('/api/zrl/captain', { team: 'cryo-gen-alpha', key: '1002' }, { token: admin });
  await app.post('/api/zrl/status', { published: true, announce: false }, { token: admin });
  [cap, ann, bob] = await Promise.all(ZW.map(z => app.memberSession(z)));
});
const avail = (body, token) => app.post('/api/zrl/availability', body, { token });
const lineup = (body, token) => app.post('/api/zrl/lineup', body, { token });
const mine = token => app.get('/api/zrl/mine', { token }).then(r => r.body);

test('a rider answers for themselves; others cannot answer for them, but the captain and staff can', async () => {
  assert.equal((await avail({ week: 0, status: 'yes' }, null)).status, 401);
  assert.equal((await avail({ week: 0, status: 'yes' }, ann)).status, 200);
  assert.equal((await avail({ week: 9, status: 'yes' }, ann)).status, 400, 'no such week');
  assert.equal((await avail({ week: 0, status: 'sure' }, ann)).status, 400);
  assert.equal((await avail({ week: 0, status: 'no', zwid: '4378027' }, bob)).status, 403, 'a rider on another team');
  assert.equal((await avail({ week: 1, status: 'maybe', zwid: '4378027' }, cap)).status, 200, 'their captain');
  assert.equal((await avail({ week: 2, status: 'no', zwid: '4378027' }, admin)).status, 200, 'staff');
  const m = await mine(ann);
  assert.deepEqual(m.weeks.map(w => [w.date, w.mine]), [['2026-11-17', 'yes'], ['2026-11-24', 'maybe'], ['2026-12-01', 'no']]);
  assert.equal((await avail({ week: 0, status: '' }, ann)).status, 200);
  assert.equal((await mine(ann)).weeks[0].mine, '', 'cleared');
});

test('the captain picks the line-up from their own riders; nobody who said no; at most five; riders see who is racing', async () => {
  await avail({ week: 0, status: 'no' }, ann);
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['1002'] }, ann)).status, 403, 'a rider is not the captain');
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['2436518'] }, cap)).status, 400, 'on another team');
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['4378027'] }, cap)).status, 400, 'said no');
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['1','2','3','4','5','6'] }, cap)).status, 400, 'too many');
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-beta', zwids: ['2436518'] }, cap)).status, 403, 'not their team');
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['1002'] }, cap)).status, 200);
  assert.equal((await lineup({ week: 1, team: 'cryo-gen-alpha', zwids: ['1002', '4378027'] }, admin)).status, 200, 'staff may too');
  const c = (await mine(cap)).captainOf[0].weeks;
  assert.deepEqual(c[0].lineup, ['1002']);
  assert.deepEqual(c[0].riders.map(r => [r.name, r.status]), [['Rider 2', ''], ['Ann Able', 'no']]);
  const a = await mine(ann);
  assert.deepEqual([a.weeks[0].picked, a.weeks[1].picked], [false, true]);
  assert.deepEqual(a.weeks[1].lineup.sort(), ['Ann Able', 'Rider 2']);
  assert.equal((await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: [] }, cap)).status, 200, 'empty clears it');
  assert.deepEqual((await mine(cap)).captainOf[0].weeks[0].lineup, []);
});

test('a rider not on a published team has nothing to answer; staff see every team and week', async () => {
  const lone = await app.memberSession('1000');
  assert.equal((await avail({ week: 0, status: 'yes' }, lone)).status, 400);
  await avail({ week: 0, status: 'yes' }, ann); await avail({ week: 0, status: 'maybe' }, cap);
  await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['1002'] }, cap);
  assert.equal((await app.get('/api/zrl/weekly', { token: cap })).status, 401);
  const w = (await app.get('/api/zrl/weekly', { token: admin })).body;
  assert.equal(w.weeks.length, 3);
  const alpha = w.weeks[0].teams.find(t => t.id === 'cryo-gen-alpha');
  assert.deepEqual([alpha.riders, alpha.lineup, alpha.yes, alpha.maybe, alpha.no], [2, 1, 1, 1, 0]);
});

test('starting the next round archives the weekly answers and starts clean', async () => {
  await avail({ week: 0, status: 'yes' }, ann);
  await app.post('/api/zrl/round', { name: 'Round 3', start: '2027-01-12', closes: h.ymd(10) }, { token: admin });
  const state = (await app.get('/api/zrl', { token: admin })).body;
  assert.equal(state.round.name, 'Round 3');
  assert.deepEqual(app.world.db['cg:zrl:weekly'] || {}, {}, 'cleared for the new round');
  const archived = JSON.parse(app.world.db['cg:zrl:archive']['2026-11-17']);
  assert.equal(archived.weekly.avail['0:4378027'], 'yes');
});

test('staff get the weekly answers and line-ups with the page data; nobody else does', async () => {
  await avail({ week: 0, status: 'yes' }, ann);
  await lineup({ week: 0, team: 'cryo-gen-alpha', zwids: ['1002'] }, cap);
  const staff = (await app.get('/api/zrl', { token: admin })).body;
  assert.equal(staff.weekly.avail['0:4378027'], 'yes');
  assert.deepEqual(staff.weekly.lineup['0:cryo-gen-alpha'], ['1002']);
  assert.equal((await app.get('/api/zrl', { token: ann })).body.weekly, undefined);
  assert.equal((await app.get('/api/zrl')).body.weekly, undefined);
});

'use strict';
// The staff "This week" page: what needs attention and what is coming up.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const week = (token = admin) => app.get('/api/week', { token });
const post = (path, body, token = admin) => app.post(path, body, { token });

test('staff only', async () => {
  assert.equal((await week(null)).status, 401);
  assert.equal((await week(await app.memberSession('1002', { name: 'Rider Two' }))).status, 401);
  assert.equal((await week(mod)).status, 200);
});

test('an empty club has nothing coming up and no problems reading', async () => {
  const w = (await week()).body;
  assert.deepEqual(w.upcoming, []);
  assert.deepEqual(w.problems, []);
  assert.equal(w.windowDays, 7);
});

test('coming up lists the TTT, ZRL races, rides and ride cover inside seven days, soonest first, and not later ones', async () => {
  await post('/api/ttt/new-week', { date: h.ymd(3) });
  await post('/api/zrl/round', { name: 'Round 2', start: h.ymd(5), closes: h.ymd(2), weeks: 3 });
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] });
  await post('/api/zrl/signup-edit', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' });
  await post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' });
  await post('/api/rides', { title: 'Sunday spin', date: h.ymd(2) });
  await post('/api/rides', { title: 'Far away ride', date: h.ymd(20) });
  const w = (await week()).body;
  const kinds = w.upcoming.map(u => u.kind);
  assert.ok(kinds.includes('TTT') && kinds.includes('ZRL') && kinds.includes('Ride'), kinds.join());
  assert.equal(w.upcoming.filter(u => u.kind === 'ZRL').length, 1, 'only race 1 is inside the week');
  assert.ok(!w.upcoming.some(u => /Far away/.test(u.title)));
  assert.deepEqual(w.upcoming.map(u => u.atMs), [...w.upcoming.map(u => u.atMs)].sort((a, b) => a - b));
  assert.equal(w.upcoming.find(u => u.kind === 'ZRL').level, 'warn', 'a team with no full line-up is flagged');
  assert.match(w.upcoming.find(u => u.kind === 'Ride').note, /0 RSVPs/);
});

test('needs attention carries the ZRL checklist, health warnings and associate requests, worst first', async () => {
  await post('/api/zrl/round', { name: 'Round 2', start: h.ymd(5), closes: h.ymd(2), weeks: 2 });
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] });
  await post('/api/zrl/signup-edit', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' });
  const nora = await app.memberSession('5551', { name: 'Newbie Nora', associate: true });
  await app.get('/api/assoc/status', { token: nora });
  app.world.db['cg:assoc:requests'] = { 5551: JSON.stringify({ zwid: '5551', name: 'Newbie Nora', at: new Date().toISOString(), status: 'pending' }) };
  const w = (await week()).body;
  const ids = w.attention.map(a => a.id);
  assert.ok(ids.includes('zrl:placed'), ids.join());
  assert.ok(ids.includes('assoc:requests'));
  const order = { fail: 0, warn: 1, todo: 2 };
  assert.deepEqual(w.attention.map(a => order[a.level]), w.attention.map(a => order[a.level]).sort((a, b) => a - b));
  assert.equal(w.attention.find(a => a.id === 'zrl:placed').level, 'warn', 'the first race is under a week away');
  assert.ok(w.attention.every(a => a.go), 'each item says which tab to open');
});

test('a moderator does not see platform problems, only the club ones', async () => {
  const forAdmin = (await week(admin)).body.attention.filter(a => a.go === 'admin').length;
  const forMod = (await week(mod)).body.attention.filter(a => a.go === 'admin').length;
  assert.equal(forMod, 0);
  assert.ok(forAdmin > 0, 'the same page shows an admin the platform problems');
});

test('every series has one status line, and the next thing to do is named', async () => {
  const r = (await app.get('/api/week', { token: admin })).body;
  assert.deepEqual(r.series.map(s => s.id), ['zrl', 'ttt', 'ladder', 'drs']);
  for (const s of r.series) { assert.ok(['ok', 'warn', 'todo', 'idle'].includes(s.state)); assert.ok(s.text.length > 5); assert.ok(s.go); }
});

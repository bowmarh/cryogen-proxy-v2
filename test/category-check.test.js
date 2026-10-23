'use strict';
// Category check: declared category against ZwiftPower's (ZwiftRacing.app club data), and riders placed above their class.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => { delete process.env.ZWIFTRACING_API_KEY; app.close(); });

const club = riders => ({ clubId: 2740, name: 'Team CRYO-GEN', riders });
const rider = (riderId, zpCategory, velo = 'Gold') => ({ riderId, name: `R${riderId}`, zpCategory, race: { current: { mixed: { category: { name: velo, number: 7 } } } } });
const check = (q = '', token = admin) => app.get(`/api/zrl/category-check${q}`, { token });

beforeEach(async () => {
  process.env.ZWIFTRACING_API_KEY = 'zr-secret-key';
  app.world.db = {};
  world.zr = { status: 200, seen: [], calls: [], byPath: { 'POST /api/public/riders': { body: [] } }, body: club([rider(1002, 'B'), rider(4378027, 'C'), rider(2436518, 'A'), rider(9001, 'D')]) };
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Cee', region: 'eu', grade: 'Grade C' }, { name: 'CRYO-GEN Bee', region: 'eu', grade: 'Grade B' }] }, { token: admin });
  for (const [n, z, cat, t] of [['Rider 2', '1002', 'C', 'cryo-gen-cee'], ['Ann Able', '4378027', 'C', 'cryo-gen-bee'], ['Bob Baker', '2436518', 'A', 'cryo-gen-cee'], ['Nobody Nick', '5555', 'B', ''], ['Dee Dee', '9001', 'B', '']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat });
    if (t) await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
  }
});

test('staff only; needs the key; their answers are explained', async () => {
  assert.equal((await check('', null)).status, 401);
  assert.equal((await check('', await app.memberSession('1002'))).status, 401);
  world.zr = { status: 429, seen: [], body: { retryAfter: 300 } };
  let r = await check(); assert.equal(r.status, 429); assert.match(r.body.error, /once every ten minutes.*300 seconds/);
  world.zr = { status: 401, seen: [], body: {} }; assert.equal((await check()).status, 502);
  delete process.env.ZWIFTRACING_API_KEY; r = await check(); assert.equal(r.status, 503);
});

test('riders who understated, are placed above their class, overstated, or are not in the club data', async () => {
  const r = await check();
  assert.equal(r.status, 200);
  assert.deepEqual(world.zr.seen[0], { path: '/api/public/clubs/2740', auth: 'zr-secret-key' });
  assert.deepEqual(r.body.understated.map(x => [x.name, x.declared, x.zp]), [['Rider 2', 'C', 'B']], 'Rider 2 says C but ZwiftPower says B');
  assert.deepEqual(r.body.overstated.map(x => [x.name, x.declared, x.zp]), [['Dee Dee', 'B', 'D']], 'saying B when ZwiftPower says D is harmless');
  assert.deepEqual(r.body.misplaced.map(x => [x.name, x.zp, x.teamCat, x.team]), [['Bob Baker', 'A', 'C', 'CRYO-GEN Cee'], ['Rider 2', 'B', 'C', 'CRYO-GEN Cee']], 'an A and a B rider on a C team; a C rider on a B team (Ann) is fine');
  assert.deepEqual(r.body.notFound.map(x => x.name), ['Nobody Nick']);
  assert.equal(r.body.clubRiders, 4); assert.equal(r.body.stale, false);
});

test('the club list is kept: a second check does not call them again, and a refused refresh uses the kept copy', async () => {
  await check();
  const first = world.zr.calls.length;
  await check();
  assert.equal(world.zr.calls.length, first, 'no second call within the hour');
  assert.equal((await check('?fresh=1')).status, 200);
  assert.equal(world.zr.calls.length, first, 'refreshing is allowed at most every ten minutes');
  const kept = JSON.parse(app.world.db['cg:zrl:zrclub']); kept.at -= 11 * 60000; app.world.db['cg:zrl:zrclub'] = JSON.stringify(kept);
  world.zr = { status: 429, seen: [], calls: [], body: { retryAfter: 300 } };
  const r = await check('?fresh=1');
  assert.equal(r.status, 200); assert.equal(r.body.stale, true, 'they said wait: the kept copy is used and marked');
  assert.equal(r.body.understated.length, 1);
});

test('riders outside the club are looked up in one batch; those with no profile are said so; the answers are kept', async () => {
  world.zr.byPath = { 'POST /api/public/riders': { body: [rider(5555, 'C', 'Silver')] } };   // 5555 is outside the club; 9001 is inside; nobody else is wanted
  await app.post('/api/zrl/signup', { name: 'Ghost Gary', zwid: '6666', regions: ['eu'], cat: 'B' });
  const r = await check();
  assert.equal(r.status, 200);
  const batch = world.zr.calls.filter(c => c.method === 'POST');
  assert.equal(batch.length, 1, 'one batch request');
  assert.deepEqual(batch[0].body.sort(), [5555, 6666], 'only the riders outside the club, as numbers');
  assert.deepEqual([r.body.looked, r.body.lookedUpNow], [1, 2]);
  assert.deepEqual(r.body.understated.filter(x => x.outsideClub), [], 'B declared, C by ZwiftPower: stronger declared, so not understated');
  assert.deepEqual(r.body.overstated.filter(x => x.outsideClub).map(x => [x.name, x.zp]), [['Nobody Nick', 'C']]);
  assert.deepEqual(r.body.notFound.map(x => [x.name, x.noProfile]), [['Ghost Gary', true]], 'asked about, but ZwiftRacing.app has no profile');
  await check();
  assert.equal(world.zr.calls.filter(c => c.method === 'POST').length, 1, 'kept: not asked again');
});

test('a refused or failed individual lookup is explained and does not break the check', async () => {
  world.zr.byPath = { 'POST /api/public/riders': { status: 429, body: { retryAfter: 300 } } };
  const r = await check();
  assert.equal(r.status, 200); assert.match(r.body.lookupNote, /asked us to wait/);
  assert.deepEqual(r.body.notFound.map(x => [x.name, x.noProfile]), [['Nobody Nick', false]], 'still not found, and not wrongly called profile-less');
  assert.equal(r.body.looked, 0);
});

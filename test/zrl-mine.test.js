'use strict';
// What a signed-in rider sees of their ZRL sign-up and team, and what a captain sees of the team they register.
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
});
const mine = token => app.get('/api/zrl/mine', { token });
const join = (name, zwid, extra = {}) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C', comments: `secret note from ${name}`, ...extra });
const put = (key, team) => app.post('/api/zrl/assign', { key, team }, { token: admin });

async function setup() {
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', slot: 'Tue 19:00 UK', captain: '1002', division: 'Division 1', grade: 'Open B' },
    { name: 'CRYO-GEN Beta', region: 'eu' },
  ] }, { token: admin });
  await join('Rider 0', '1000'); await join('Rider 2', '1002'); await join('Ann Able', '4378027'); await join('Bob Baker', '2436518'); await join('Free Fred', '1004');
  for (const k of ['1000', '1002', '4378027']) await put(k, 'cryo-gen-alpha');
  await put('2436518', 'cryo-gen-beta');
}

test('only a signed-in rider has a "mine" view', async () => {
  assert.equal((await mine(null)).status, 401);
  assert.equal((await mine(admin)).status, 401, 'staff use the staff panel');
  delete app.world.db['cg:zrl:round'];
  assert.deepEqual((await mine(await app.memberSession('1000'))).body, { round: null });
});

test('a rider sees their team only once it is published, with names and categories but no IDs or comments', async () => {
  await setup();
  const rider = await app.memberSession('1000');
  const before = (await mine(rider)).body;
  assert.deepEqual([before.placed, before.team, before.captainOf], [true, null, []]);
  await app.post('/api/zrl/status', { published: true }, { token: admin });
  const after = (await mine(rider)).body;
  assert.equal(after.team.name, 'CRYO-GEN Alpha');
  assert.deepEqual(after.team.riders.map(r => r.name).sort(), ['Ann Able', 'Rider 0', 'Rider 2']);
  const text = JSON.stringify(after);
  for (const secret of ['4378027', '2436518', 'secret note', 'Bob Baker', 'CRYO-GEN Beta']) assert.ok(!text.includes(secret), `leaks ${secret}`);
  assert.equal(after.captainOf.length, 0);
});

test('a rider who is not placed is told so; their sign-up is returned', async () => {
  await setup();
  const r = (await mine(await app.memberSession('1000'))).body;
  assert.equal(r.signup.in, true);
  await app.post('/api/zrl/withdraw', { name: 'Rider 0', zwid: '1000' }, { token: await app.memberSession('1000') });
  const gone = (await mine(await app.memberSession('1000', { nonce: 'again-nonce-1234567890' }))).body;
  assert.deepEqual([gone.signup, gone.placed], [null, false]);
});

test('a captain sees the team they captain straight away, with Zwift IDs and the registration block, but not other teams', async () => {
  await setup();
  const cap = (await mine(await app.memberSession('1002'))).body;
  assert.equal(cap.team, null, 'unpublished: no "your team" for a rider');
  assert.equal(cap.captainOf.length, 1);
  const t = cap.captainOf[0];
  assert.equal(t.name, 'CRYO-GEN Alpha');
  assert.deepEqual(t.riders.map(r => [r.name, r.zwid]).sort(), [['Ann Able', '4378027'], ['Rider 0', '1000'], ['Rider 2', '1002']]);
  assert.equal(t.riders[0].isCaptain, true, 'captain first');
  assert.match(t.text, /^CRYO-GEN Alpha — Division 1 · Open B — Europe — Tue 19:00 UK\nCaptain: Rider 2 \(1002\)/);
  assert.equal(t.ids.split('\n').length, 3);
  assert.deepEqual(t.issues, ['3 riders, 10 expected']);
  const text = JSON.stringify(cap);
  for (const secret of ['secret note', 'Bob Baker', '2436518']) assert.ok(!text.includes(secret), `leaks ${secret}`);
});

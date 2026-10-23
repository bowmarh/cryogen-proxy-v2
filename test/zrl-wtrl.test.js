'use strict';
// WTRL registration tracker: captains tick "registered", staff set the deadline, the health panel and Discord chase the rest.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, cap, ann;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const posts = channel => app.world.discord.filter(p => p.channel === channel).map(p => p.body.content);
const teams = async () => Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(t => [t.id, t]));
const mark = (body, token) => app.post('/api/zrl/wtrl-registered', body, { token });

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(20), closes: h.ymd(-1), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }] }, { token: admin });
  for (const [n, z, t] of [['Rider 2', '1002', 'cryo-gen-alpha'], ['Ann Able', '4378027', 'cryo-gen-alpha'], ['Bob Baker', '2436518', 'cryo-gen-beta']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
    await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
  }
  await app.post('/api/zrl/captain', { team: 'cryo-gen-alpha', key: '1002' }, { token: admin });
  const r = JSON.parse(app.world.db['cg:zrl:round']); app.world.db['cg:zrl:round'] = JSON.stringify({ ...r, open: false });
  await app.post('/api/zrl/status', { published: true, announce: false }, { token: admin });
  app.world.discord.length = 0;
  [cap, ann] = await Promise.all([app.memberSession('1002'), app.memberSession('4378027')]);
});

test('only the captain or staff can mark a team registered; it shows on the team and in the captain view', async () => {
  assert.equal((await mark({ team: 'cryo-gen-alpha' }, null)).status, 401);
  assert.equal((await mark({ team: 'cryo-gen-alpha' }, ann)).status, 403, 'a rider is not the captain');
  assert.equal((await mark({ team: 'cryo-gen-beta' }, cap)).status, 403, 'not their team');
  assert.equal((await mark({ team: 'nope' }, admin)).status, 404);
  assert.equal((await mark({ team: 'cryo-gen-alpha' }, cap)).status, 200);
  assert.equal((await teams())['cryo-gen-alpha'].wtrlRegistered, true);
  assert.equal((await teams())['cryo-gen-beta'].wtrlRegistered, false);
  assert.equal((await app.get('/api/zrl/mine', { token: cap })).body.captainOf[0].registered, true);
  assert.equal((await mark({ team: 'cryo-gen-alpha', registered: false }, cap)).status, 200);
  assert.equal((await teams())['cryo-gen-alpha'].wtrlRegistered, false, 'the mark comes off');
  assert.equal((await mark({ team: 'cryo-gen-beta' }, admin)).status, 200, 'staff can for any team');
});

test('the deadline is staff only, must be a real date, and can be removed', async () => {
  const set = (date, token = admin) => app.post('/api/zrl/wtrl-deadline', { date }, { token });
  assert.equal((await set(h.ymd(5), cap)).status, 401);
  assert.equal((await set('31 Feb')).status, 400);
  assert.equal((await set(h.ymd(5))).status, 200);
  const deadline = (await app.get('/api/zrl', { token: admin })).body.round.wtrlDeadline;
  assert.ok(Date.parse(deadline) > Date.now());
  assert.equal((await set('')).status, 200);
  assert.equal((await app.get('/api/zrl', { token: admin })).body.round.wtrlDeadline, null);
});

test('three days before the deadline the admins hear which teams are not registered, once, and only if some are', async () => {
  await app.post('/api/zrl/wtrl-deadline', { date: h.ymd(10) }, { token: admin });
  assert.deepEqual(await tick(), [], 'ten days out');
  await app.post('/api/zrl/wtrl-deadline', { date: h.ymd(2) }, { token: admin });
  await mark({ team: 'cryo-gen-alpha' }, cap);
  assert.deepEqual(await tick(), ['zrl-wtrl']);
  const text = posts('admin')[0];
  assert.match(text, /1 team is not marked as registered/);
  assert.match(text, /Beta/); assert.ok(!/Alpha/.test(text));
  assert.deepEqual(await tick(), [], 'once');
});

test('nothing is said when every team is registered', async () => {
  await app.post('/api/zrl/wtrl-deadline', { date: h.ymd(2) }, { token: admin });
  await mark({ team: 'cryo-gen-alpha' }, cap); await mark({ team: 'cryo-gen-beta' }, admin);
  assert.deepEqual(await tick(), []);
  assert.equal(app.world.discord.length, 0);
});

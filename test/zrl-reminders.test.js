'use strict';
// Race-week reminders: ask the riders five days out, tell the captains' channel two days out which line-ups are missing.
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

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const posts = channel => app.world.discord.filter(p => p.channel === channel).map(p => p.body.content);
const setRound = patch => { const r = JSON.parse(app.world.db['cg:zrl:round']); app.world.db['cg:zrl:round'] = JSON.stringify({ ...r, ...patch }); };

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(8), closes: h.ymd(-1), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }, { name: 'CRYO-GEN Empty', region: 'am' }] }, { token: admin });
  for (const [n, z, t] of [['Rider 2', '1002', 'cryo-gen-alpha'], ['Ann Able', '4378027', 'cryo-gen-alpha'], ['Bob Baker', '2436518', 'cryo-gen-beta']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
    await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
  }
  await app.post('/api/zrl/captain', { team: 'cryo-gen-alpha', key: '1002' }, { token: admin });
  setRound({ open: false });
  await app.post('/api/zrl/status', { published: true, announce: false }, { token: admin });
  app.world.discord.length = 0;
});

test('nothing before the rosters are out, nothing a week ahead', async () => {
  setRound({ published: false, start: h.ymd(3) });
  assert.deepEqual(await tick(), [], 'not published');
  setRound({ published: true, start: h.ymd(8) });
  assert.deepEqual(await tick(), []);
  assert.equal(app.world.discord.length, 0);
});

test('five days out the riders are asked once; two days out the captains are told which teams have no full line-up, once', async () => {
  setRound({ start: h.ymd(4) });
  assert.deepEqual(await tick(), ['zrl-avail-1']);
  assert.match(posts('public')[0], /race 1 is on .*Can you race\?/s);
  assert.equal(posts('admin').length, 0, 'the captains are not nagged yet');
  assert.deepEqual(await tick(), [], 'not repeated');

  setRound({ start: h.ymd(1) });
  assert.deepEqual(await tick(), ['zrl-lineup-1']);
  const nudge = posts('admin')[0];
  assert.match(nudge, /2 teams have not picked a full line-up of 5/);
  assert.match(nudge, /Alpha \(captain Rider 2\)/); assert.match(nudge, /Beta/);
  assert.ok(!/Empty/.test(nudge), 'a team with no riders is not chased');
  assert.deepEqual(await tick(), [], 'once');
});

test('a team with a full line-up is not chased, and nothing is said when everyone is sorted', async () => {
  setRound({ start: h.ymd(1) });
  const cap = await app.memberSession('1002');
  await app.post('/api/zrl/lineup', { week: 0, team: 'cryo-gen-alpha', zwids: ['1002', '4378027'] }, { token: cap });
  await app.post('/api/zrl/lineup', { week: 0, team: 'cryo-gen-beta', zwids: ['2436518'] }, { token: admin });
  setRound({ racing: 2 });   // two ride a week here, so a pair is a full line-up; Beta has one rider and is still short
  assert.deepEqual(await tick(), ['zrl-avail-1', 'zrl-lineup-1'], 'a late start still sends both, once');
  assert.ok(!/Alpha/.test(posts('admin')[0]) && /Beta/.test(posts('admin')[0]));
});

test('a race that has started gets nothing', async () => {
  setRound({ start: h.ymd(0) });
  assert.deepEqual(await tick(), []);
});

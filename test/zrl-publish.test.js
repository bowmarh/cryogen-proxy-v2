'use strict';
// Publishing the rosters: riders can see their team, and the club is told once.
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
  await app.post('/api/zrl/round', { name: 'Round 2 · Team Tempo', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha @everyone', region: 'eu', captain: '1002' }, { name: 'CRYO-GEN Beta', region: 'ap' },
  ] }, { token: admin });
  const join = (name, zwid) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C' });
  await join('Rider 2', '1002'); await join('Secret Sam', '4378027'); await join('Bob Baker', '2436518'); await join('Free Fred', '1004');
  for (const [k, t] of [['1002', 'cryo-gen-alpha-everyone'], ['4378027', 'cryo-gen-alpha-everyone'], ['2436518', 'cryo-gen-beta']]) await app.post('/api/zrl/assign', { key: k, team: t }, { token: admin });
  app.world.discord.length = 0;
});
const publish = (body = { published: true }) => app.post('/api/zrl/status', body, { token: admin });
const posts = channel => app.world.discord.filter(p => p.channel === channel).map(p => p.body.content);

test('publishing posts to the club channel and tells the admins what is still missing', async () => {
  assert.equal((await publish()).status, 200);
  const [pub] = posts('public'), [adm] = posts('admin');
  assert.match(pub, /rosters are out/);
  assert.match(pub, /3 riders are on 2 teams/);
  assert.match(pub, /Europe\*\*: 1 team, 2 riders/);
  assert.match(pub, /Asia-Pacific\*\*: 1 team, 1 riders/);
  assert.match(pub, /My ZRL/);
  for (const secret of ['Secret Sam', 'Bob Baker', 'Rider 2', '4378027']) assert.ok(!pub.includes(secret), `public post names ${secret}`);
  assert.ok(!/@everyone/.test(pub.replace(/\\@everyone|@​everyone/g, '')), 'a team name cannot ping everyone');
  assert.match(adm, /1 team has no captain: CRYO-GEN Beta/);
  assert.match(adm, /2 teams have fewer than 10 riders/);
  assert.match(adm, /1 rider is still without a team/);
  for (const p of app.world.discord) assert.deepEqual(p.body.allowed_mentions, { parse: [] }, 'a name like @everyone in a team name cannot ping anyone');
});

test('it is announced once per round; unpublishing and publishing again stays quiet', async () => {
  await publish();
  assert.equal(app.world.discord.length, 2);
  await publish({ published: false });
  await publish();
  assert.equal(app.world.discord.length, 2, 'no second announcement');
});

test('staff can publish without an announcement, and that does not use up the announcement', async () => {
  await publish({ published: true, announce: false });
  assert.equal(app.world.discord.length, 0);
  const rider = await app.memberSession('1002');
  assert.equal((await app.get('/api/zrl/mine', { token: rider })).body.team.name, 'CRYO-GEN Alpha @everyone', 'riders can see their team');
  await publish({ published: false });
  await publish();
  assert.equal(posts('public').length, 1, 'a later publish still announces');
});

test('only staff can publish', async () => {
  assert.equal((await app.post('/api/zrl/status', { published: true })).status, 401);
  assert.equal((await app.post('/api/zrl/status', { published: true }, { token: await app.memberSession('1002') })).status, 401);
  assert.equal(app.world.discord.length, 0);
});

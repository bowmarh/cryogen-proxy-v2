'use strict';
// Recruit post: staff ask the club for riders in a time zone; open places and race times are in the message; once a day per zone.
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

const recruit = (body, token = admin) => app.post('/api/zrl/recruit', body, { token });
const posts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Pink', region: 'ap', slot: 'Tue 08:30 UTC' }, { name: 'CRYO-GEN Crimson', region: 'ap', slot: 'Tue 06:30 UTC' }, { name: 'CRYO-GEN Mint', region: 'eu' }] }, { token: admin });
  app.world.discord.length = 0;
});

test('staff only; the message says how many places are open and when they race', async () => {
  assert.equal((await recruit({}, null)).status, 401);
  assert.equal((await recruit({}, await app.memberSession('1002'))).status, 401);
  assert.equal((await recruit({ region: 'mars' })).status, 400);
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['ap'], cat: 'C' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-pink' }, { token: admin });
  const r = await recruit({});
  assert.equal(r.status, 200); assert.equal(r.body.open, 19, '2 teams x 10 places - 1 placed');
  const text = posts()[0];
  assert.match(text, /Asia-Pacific: 19 places open on 2 teams/);
  assert.match(text, /Tue 08:30 UTC · Tue 06:30 UTC/);
  assert.match(text, /Sign in at .* → 🚀 ZRL and tick Asia-Pacific/);
});

test('a zone with no team yet says so and counts the interested; once a day per zone; closed sign-ups refuse', async () => {
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['am'], cat: 'C' });
  assert.equal((await recruit({ region: 'am' })).status, 200);
  assert.match(posts()[0], /Americas: we want to start a team/); assert.match(posts()[0], /1 rider is interested so far/);
  assert.equal((await recruit({ region: 'am' })).status, 429, 'same zone, same day');
  assert.equal((await recruit({ region: 'eu' })).status, 200, 'another zone is fine');
  await app.post('/api/zrl/status', { open: false }, { token: admin });
  assert.equal((await recruit({ region: 'ap' })).status, 409);
  assert.equal(posts().length, 2, 'nothing more was posted');
});

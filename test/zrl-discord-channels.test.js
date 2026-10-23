'use strict';
// The ZRL has its own Discord channels, falls back to the TTT ones when they are not set, and never moves the TTT's posts.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ DISCORD_WEBHOOK_ZRL_PUBLIC: 'http://discord.test/zrl-public', DISCORD_WEBHOOK_ZRL_ADMIN: 'http://discord.test/zrl-admin' });
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(() => {
  app.world.db = {}; app.world.discord.length = 0;
  process.env.DISCORD_WEBHOOK_ZRL_PUBLIC = 'http://discord.test/zrl-public';
  process.env.DISCORD_WEBHOOK_ZRL_ADMIN = 'http://discord.test/zrl-admin';
});
const channels = () => app.world.discord.map(p => p.channel);

async function zrlWeek() {
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
  await app.post('/api/zrl/status', { published: true }, { token: admin });
}

test('with their own webhooks, every ZRL post goes to the ZRL channels and none to the TTT ones', async () => {
  await zrlWeek();
  assert.deepEqual([...new Set(channels())].sort(), ['zrl-admin', 'zrl-public']);
  assert.equal(channels().filter(c => c === 'zrl-public').length, 2, 'round open, rosters out');
  assert.equal(channels().filter(c => c === 'zrl-admin').length, 1, 'the to-do list');
});

test('the TTT keeps using its own channels', async () => {
  await app.post('/api/ttt/new-week', { date: h.ymd(9) }, { token: admin });
  const week = (await app.get('/api/ttt', { token: admin })).body.week;
  const r = await app.post('/api/ttt/results', { weekId: week.id, results: { [week.teams[0].id]: { time: '24:31', position: 2, of: 9 } } }, { token: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(channels().length >= 2, 'the new-week announcement and the results post');
  assert.ok(channels().every(c => c === 'public' || c === 'admin'), `TTT posts stay on the TTT channels, got ${channels()}`);
});

test('without their own webhooks the ZRL falls back to the TTT channels, so nothing is lost', async () => {
  delete process.env.DISCORD_WEBHOOK_ZRL_PUBLIC; delete process.env.DISCORD_WEBHOOK_ZRL_ADMIN;
  await zrlWeek();
  assert.deepEqual([...new Set(channels())].sort(), ['admin', 'public']);
  process.env.DISCORD_WEBHOOK_ZRL_PUBLIC = 'http://discord.test/zrl-public';   // only one of the two set: the other falls back
  app.world.discord.length = 0;
  await app.post('/api/zrl/status', { published: false }, { token: admin });
  await app.post('/api/zrl/round', { name: 'Round 3', start: '2027-01-12', closes: h.ymd(20) }, { token: admin });
  assert.deepEqual(channels(), ['zrl-public']);
});

test('the health panel says where the ZRL posts go', async () => {
  const get = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'discord').detail;
  assert.match(await get(), /ZRL club channel: own channel · ZRL admin channel: own channel/);
  delete process.env.DISCORD_WEBHOOK_ZRL_ADMIN;
  assert.match(await get(), /ZRL club channel: own channel · ZRL admin channel: shares the TTT admin channel/);
  delete process.env.DISCORD_WEBHOOK_ZRL_PUBLIC;
  assert.match(await get(), /ZRL club channel: shares the TTT club channel/);
});

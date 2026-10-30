'use strict';
// Direct messages from the automation: the rider who steps into a Ladder line-up, the scoring four, and a captain whose team is short; only with automatic messages on.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald', 'Emerald'];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const A = { get token() { return admin; } };
const ID = i => String(2000 + i), D = i => `${1000 + i}`.padStart(18, '1');
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); process.env.DISCORD_BOT_TOKEN = 'bot'; });
const link = async n => { for (let i = 0; i < n; i++) await app.post('/api/comms/link', { zwid: ID(i), discordId: D(i) }, A); };

test('a replacement is told by DM, once, and only when automatic messages are on', async () => {
  await link(7);
  for (let i = 0; i < 7; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const t = new Date(Date.now() + 5 * 86400000);
  const m = (await app.post('/api/ladder/match', { opponent: 'X', challenger: 'us', date: t.toISOString().slice(0, 10), time: '19:30', eventLink: 'https://www.zwift.com/events/view/5' }, A)).body.matches[0];
  await app.post('/api/ladder/auto-lineup', { match: m.id }, A);
  let v = (await app.get('/api/ladder', A)).body.matches[0];
  await app.post('/api/ladder/availability', { match: m.id, zwid: v.lineup[0], status: 'no' }, A);
  assert.equal(world.dms.length, 0, 'automatic messages are off');
  v = (await app.get('/api/ladder', A)).body.matches[0];
  await app.post('/api/comms/auto', { nudge: true }, A);
  await app.post('/api/ladder/availability', { match: m.id, zwid: v.lineup[0], status: 'no' }, A);
  assert.equal(world.dms.length, 1);
  assert.match(world.dms[0].body.content, /you're now in the Ladder line-up for CRYO-GEN v X/);
  assert.match(world.dms[0].body.content, /automatic message/);
});

test('the scoring four are told their role when it is picked two days out', async () => {
  await link(6);
  await app.post('/api/comms/auto', { nudge: true }, A);
  const start = Date.now() + 40 * 3600000;
  await app.post('/api/drs/season', { name: 'A', division: 'P', threshold: 5000, time: new Date(start).toISOString().slice(11, 16), tz: 'UTC' }, A);
  for (let i = 0; i < 6; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  await app.post('/api/drs/stage', { type: 'scratch', date: new Date(start).toISOString().slice(0, 10) }, A);
  await tick();
  const texts = world.dms.map(d => d.body.content).filter(t => /^Hi, for CRYO-GEN DIRT stage 1/.test(t));
  assert.equal(texts.length, 6);
  assert.equal(texts.filter(t => /one of the scoring four/.test(t)).length, 4);
  assert.equal(texts.filter(t => /in support/.test(t)).length, 2);
});

test('a captain whose team has no line-up two days before the race gets a DM too', async () => {
  await link(1);
  await app.post('/api/comms/auto', { nudge: true }, A);
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(1), closes: h.ymd(10), weeks: 2 }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Lad 0', zwid: ID(0), regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/assign', { key: ID(0), team: 'alpha' }, A);
  await app.post('/api/zrl/captain', { team: 'alpha', key: ID(0) }, A);
  const r = JSON.parse(app.world.db['cg:zrl:round']); app.world.db['cg:zrl:round'] = JSON.stringify({ ...r, open: false, published: true, autoFix: { place: true, lineups: false } });
  await tick();
  const mine = world.dms.filter(d => /has not picked a full line-up of 5/.test(d.body.content));
  assert.equal(mine.length, 1);
  await tick();
  assert.equal(world.dms.filter(d => /has not picked a full line-up/.test(d.body.content)).length, 1, 'once');
});

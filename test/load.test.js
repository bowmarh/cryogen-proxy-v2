'use strict';
// A big club and a bad day: 300 riders across 40 teams, and Discord down for part of the round. Nothing may crash, every rider must end up
// handled without a crash, nobody who said no may be picked, and the messages must go out once Discord is back.
const { test, before, after } = require('node:test');
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
const A = { get token() { return admin; } };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body);

test('300 riders, 40 teams, Discord down while sign-ups close: the run completes and the messages follow when Discord is back', async () => {
  const t0 = Date.now();
  const cats = ['A', 'B', 'C', 'D'], N = 300;
  await app.post('/api/zrl/round', { name: 'Big round', start: h.ymd(9), closes: h.ymd(5), weeks: 4 }, A);
  const teams = Array.from({ length: 40 }, (_, i) => ({ name: `Team ${String(i + 1).padStart(2, '0')}`, region: i % 4 === 3 ? 'am' : 'eu', grade: `Open ${cats[i % 4]}`, league: 'Purple' }));
  assert.equal((await app.post('/api/zrl/teams', { teams }, A)).status, 200);
  for (let i = 0; i < N; i++) {
    const r = await app.post('/api/zrl/signup', { name: `Big Rider ${i}`, zwid: String(10000 + i), regions: [i % 4 === 3 ? 'am' : 'eu'], cat: cats[i % 4], captain: i % 25 === 0 });
    assert.equal(r.status, 200, `sign-up ${i}`);
  }
  // Sign-ups close while Discord is failing: the close must still happen, and the announcement waits.
  const round = JSON.parse(app.world.db['cg:zrl:round']);
  app.world.db['cg:zrl:round'] = JSON.stringify({ ...round, closesAt: new Date(Date.now() - 60000).toISOString() });
  app.world.discord.length = 0; app.world.discordFail = 50;
  const r1 = await tick();
  assert.equal(r1.failed, undefined, JSON.stringify(r1.failed));
  let v = (await app.get('/api/zrl', A)).body;
  assert.equal(v.round.open, false);
  const placed = Object.keys(v.placements).length, unplaced = (v.unplaced || []).length;
  assert.ok(placed >= 200, `placed ${placed}`);   // the rest are riders no team in their zone and category has room for
  assert.ok(Object.keys(app.world.db['cg:outbox'] || {}).length >= 1, 'the announcement is waiting in the outbox');
  assert.equal(app.world.discord.length, 0, 'nothing got through yet');

  // Discord comes back: the next run delivers what was waiting, once.
  app.world.discordFail = 0;
  await tick();
  assert.ok(app.world.discord.some(d => /teams suggested automatically/.test(d.body.content || '')), 'the announcement arrived');
  assert.equal(Object.keys(app.world.db['cg:outbox'] || {}).length, 0);
  const count = app.world.discord.length;
  await tick();
  assert.equal(app.world.discord.length, count, 'and is not sent twice');

  // Publish, everyone answers (every seventh says no), line-ups are filled for the whole club in one go.
  await app.post('/api/zrl/status', { published: true }, A);
  v = (await app.get('/api/zrl', A)).body;
  const riders = v.signups.filter(s => s.zwid);
  for (const [i, s] of riders.entries()) await app.post('/api/zrl/availability', { week: 0, zwid: s.zwid, status: i % 7 === 0 ? 'no' : 'yes' }, A);
  const fix = (await app.post('/api/zrl/fix', { only: ['lineups'], apply: true }, A)).body.applied;
  assert.ok(fix.steps.some(s => s.id === 'lineups' && s.count >= 20), JSON.stringify(fix.steps.map(s => [s.id, s.count])));
  v = (await app.get('/api/zrl', A)).body;
  const said = new Set(riders.filter((s, i) => i % 7 === 0).map(s => s.zwid));
  for (const [field, list] of Object.entries(v.weekly.lineup)) {
    if (!field.startsWith('0:')) continue;
    assert.ok(list.length <= 5, `${field} has ${list.length}`);
    assert.ok(!list.some(z => said.has(z)), `${field} picked someone who said no`);
  }
  const week = await app.get('/api/week', A);
  assert.equal(week.status, 200);
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs < 60, `took ${secs}s`);
  console.log(`# load: ${N} riders, placed ${placed}, unplaced ${unplaced}, ${secs.toFixed(1)}s`);
});

test('the riders who could not be placed are named in Needs attention with the reason, counted', async () => {
  const week = (await app.get('/api/week', A)).body;
  const item = week.attention.find(a => a.id === 'zrl:placed');
  assert.ok(item, JSON.stringify(week.attention.map(a => a.id)));
  assert.match(item.detail, /riders? ha(s|ve) no team yet\./);
  assert.match(item.detail, /cannot \(.*(full or there is none|no free place)/);
});

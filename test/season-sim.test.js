'use strict';
// A whole ZRL round played through the scheduler, the way a club week goes: sign-ups, close, automatic placement, answers, line-ups, results.
// If a change breaks the hand-off between two steps, this is the test that says so.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const A = { get token() { return admin; } };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body);
const adminPosts = () => app.world.discord.filter(d => d.channel === 'admin').map(d => d.body.content);

before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

test('a ZRL round from sign-up to results runs with nothing for the staff to do but look', async () => {
  const riders = Array.from({ length: 12 }, (_, i) => [`Sim Rider ${i + 1}`, String(3000 + i), i < 6 ? 'B' : 'C']);
  await app.post('/api/zrl/round', { name: 'Sim round', start: h.ymd(9), closes: h.ymd(5), weeks: 3 }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Sim Alpha', region: 'eu', grade: 'Open B', league: 'Purple' }, { name: 'Sim Beta', region: 'eu', grade: 'C', league: 'Purple' }] }, A);
  for (const [name, zwid, cat] of riders) assert.equal((await app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat, captain: zwid === '3000' || zwid === '3006' })).status, 200);

  // Sign-ups close on their own: riders are placed, captains named (the volunteers), race times set, the admin channel told.
  const round = JSON.parse(app.world.db['cg:zrl:round']);
  app.world.db['cg:zrl:round'] = JSON.stringify({ ...round, closesAt: new Date(Date.now() - 60000).toISOString() });
  app.world.discord.length = 0;
  await tick();
  let v = (await app.get('/api/zrl', A)).body;
  assert.equal(v.round.open, false, 'closed by the scheduler');
  assert.equal(Object.keys(v.placements).length, 12, 'everyone placed');
  const alpha = v.round.teams.find(t => t.name === 'Sim Alpha');
  const beta = v.round.teams.find(t => t.name === 'Sim Beta');
  assert.ok(alpha.captain && beta.captain && alpha.captain !== beta.captain, 'each team has its own volunteer captain');
  assert.deepEqual([alpha.captain, beta.captain].sort(), ['3000', '3006']);
  assert.ok(adminPosts().some(c => /teams suggested automatically/.test(c)), 'staff told once');

  // Publish, then the riders answer: two say no for race 1, the rest yes.
  await app.post('/api/zrl/status', { published: true }, A);
  for (const [, zwid] of riders) await app.post('/api/zrl/availability', { week: 0, zwid, status: ['3001', '3007'].includes(zwid) ? 'no' : 'yes' }, A);
  await app.post('/api/zrl/fix', { only: ['lineups'], apply: true }, A);
  v = (await app.get('/api/zrl', A)).body;
  const lineA = v.weekly.lineup['0:sim-alpha'], lineB = v.weekly.lineup['0:sim-beta'] || [];
  assert.equal(lineA.length, 5);
  assert.ok(![...lineA, ...lineB].some(z => z === '3001' || z === '3007'), 'nobody who said no is picked');

  // A captain changes their mind: "Pick for me" after a rider drops out moves the line-up on without the dropped rider.
  const cap = { token: await app.memberSession('3000', { name: 'Sim Rider 1' }) };
  await app.post('/api/zrl/availability', { week: 0, zwid: lineA[1], status: 'no' }, A);
  await app.post('/api/zrl/lineup', { team: 'sim-alpha', week: 0, zwids: lineA.filter(z => z !== lineA[1]) }, cap);
  const again = await app.post('/api/zrl/lineup', { team: 'sim-alpha', week: 0, auto: true }, cap);
  assert.equal(again.body.zwids.length, 5);
  assert.ok(!again.body.zwids.includes(lineA[1]));

  // Results come in and the standings can be posted.
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'sim-alpha', pos: 3, pts: 12 }, { team: 'sim-beta', pos: 7, pts: 6 }] }, A);
  app.world.discord.length = 0;
  assert.equal((await app.post('/api/zrl/post-standings', {}, A)).status, 200);
  assert.ok(app.world.discord.length >= 1);

  // A second scheduled run repeats nothing, and nothing is stuck in the outbox.
  app.world.discord.length = 0;
  await tick(); await tick();
  assert.equal(app.world.discord.filter(d => /teams suggested automatically/.test(d.body.content || '')).length, 0, 'no repeat announcements');
  assert.equal(Object.keys(app.world.db['cg:outbox'] || {}).length, 0);
  const week = (await app.get('/api/week', A)).body;
  assert.ok(!week.attention.some(a => a.level === 'fail'), JSON.stringify(week.attention.filter(a => a.level === 'fail')));
});

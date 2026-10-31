'use strict';
// ZRL one-click fixes: place, captain, race time, class and line-up steps from the readiness list; preview first, then apply; and the scheduled automatic runs.
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
const A = { get token() { return admin; } };
const view = () => app.get('/api/zrl', A).then(r => r.body);
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(1), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B', league: 'Purple' }, { name: 'Beta', region: 'am', grade: 'C' }] }, A);
  for (const [name, zwid, regions, cat] of [['Rider Zero', '1000', ['eu'], 'B'], ['Rider Two', '1002', ['eu'], 'B'], ['Rider Three', '1003', ['eu'], 'C'], ['Rider Four', '1004', ['am'], 'C']]) await app.post('/api/zrl/signup', { name, zwid, regions, cat });
});

test('readiness marks what can be fixed in one click', async () => {
  const r = (await app.get('/api/zrl/readiness', A)).body;
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.placed.fix, true); assert.equal(by.captains.fix, false, 'no team has riders yet');
  assert.equal(by.ids.fix, false, 'a missing Zwift ID needs a person');
  assert.equal(by.wtrl.fix, false);
});

test('preview changes nothing; apply places riders, picks captains and sets the league time; the rest is listed', async () => {
  await app.post('/api/zrl/signup-edit', { key: '1003', captain: true }, A);
  const pre = (await app.post('/api/zrl/fix', {}, A)).body.plan;
  assert.ok(pre.total > 0);
  assert.deepEqual(pre.steps.map(s => s.id), ['placed', 'captains', 'times', 'lineups']);
  assert.equal((await view()).placements['1000'], undefined, 'nothing moved by a preview');
  const done = (await app.post('/api/zrl/fix', { apply: true }, A)).body.applied;
  assert.equal(done.steps.find(s => s.id === 'placed').count, 4);
  const v = await view();
  const alpha = v.round.teams.find(t => t.name === 'Alpha'), beta = v.round.teams.find(t => t.name === 'Beta');
  assert.equal(alpha.captain, '1003', 'the volunteer');
  assert.ok(beta.captain, 'nobody volunteered: the strongest rider with an ID');
  assert.match(alpha.slot, /UTC$/, 'the Purple league time');
  assert.equal(done.left.find(l => l.id === 'times' && l.title === 'Beta') !== undefined, true, 'Beta has no league colour');
  const again = (await app.post('/api/zrl/fix', { apply: true }, A)).body.applied;
  assert.equal(again.steps.filter(s => s.id !== 'times').length, 0, 'a second run has nothing left to do');
});

test('only the checks asked for are run, and only staff may', async () => {
  const r = (await app.post('/api/zrl/fix', { only: ['placed'] }, A)).body.plan;
  assert.deepEqual(r.steps.map(s => s.id), ['placed']);
  assert.equal((await app.post('/api/zrl/fix', { only: ['nope'] }, A)).status, 400);
  assert.equal((await app.post('/api/zrl/fix', {})).status, 401);
  assert.equal((await app.post('/api/zrl/fix', {}, { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
});

test('a rider below the team class moves to a team that suits, or is listed when there is none', async () => {
  await app.post('/api/zrl/signup-edit', { key: '1003', cat: 'A' }, A);
  await app.post('/api/zrl/assign', { key: '1003', team: 'alpha' }, A);   // an A rider on a B team
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }, { name: 'Gamma', region: 'eu', grade: 'A' }] }, A);
  const plan = (await app.post('/api/zrl/fix', { only: ['class'] }, A)).body.plan;
  assert.match(plan.steps[0].lines[0], /Rider Three \(A\): Alpha → Gamma/);
  await app.post('/api/zrl/fix', { only: ['class'], apply: true }, A);
  assert.equal((await view()).placements['1003'][0], 'gamma');
  await app.post('/api/zrl/assign', { key: '1003', team: 'alpha' }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }], }, A);
  const none = (await app.post('/api/zrl/fix', { only: ['class'] }, A)).body.plan;
  assert.equal(none.total, 0);
  assert.match(none.left[0].detail, /no other team in their zone has a place/);
});

test('line-ups are filled from the answers: yes first, nobody who said no, and what cannot be filled is listed', async () => {
  for (const [n, z] of [['Rider Five', '1005'], ['Rider Six', '1006'], ['Rider Seven', '1007']]) await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/fix', { only: ['placed'], apply: true }, A);
  await app.post('/api/zrl/availability', { week: 0, zwid: '1000', status: 'no' }, A);
  await app.post('/api/zrl/availability', { week: 0, zwid: '1002', status: 'yes' }, A);
  await app.post('/api/zrl/availability', { week: 0, zwid: '1003', status: 'maybe' }, A);
  const done = (await app.post('/api/zrl/fix', { only: ['lineups'], apply: true }, A)).body.applied;
  const alpha = (await view()).weekly.lineup['0:alpha'];
  assert.equal(alpha.length, 5);
  assert.ok(!alpha.includes('1000'), 'said no');
  assert.deepEqual(alpha.slice(0, 2).sort(), ['1002', '1003'], 'yes and maybe first');
  assert.ok(done.left.some(l => /Beta/.test(l.title) && /find 4 subs/.test(l.detail)), 'Beta has only one rider');
  assert.ok(done.steps[0].lines.some(l => /not answered/.test(l)));
});

test('when sign-ups close the teams are suggested automatically and the admin channel is told; it can be switched off', async () => {
  const round = JSON.parse(app.world.db['cg:zrl:round']);
  app.world.db['cg:zrl:round'] = JSON.stringify({ ...round, closesAt: new Date(Date.now() - 60000).toISOString() });
  await tick();
  const v = await view();
  assert.equal(v.round.open, false);
  assert.equal(v.placements['1000'][0], 'alpha');
  assert.ok(app.world.discord.some(d => d.channel === 'admin' && /teams suggested automatically/.test(d.body.content)));

  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 3', start: h.ymd(1), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Rider Zero', zwid: '1000', regions: ['eu'], cat: 'B' });
  assert.equal((await app.post('/api/zrl/auto-settings', { place: false }, A)).body.autoFix.place, false);
  const r2 = JSON.parse(app.world.db['cg:zrl:round']);
  app.world.db['cg:zrl:round'] = JSON.stringify({ ...r2, closesAt: new Date(Date.now() - 60000).toISOString() });
  await tick();
  assert.equal((await view()).placements['1000'], undefined, 'switched off: left for the staff');
});

test('a captain can have the line-up picked for them, from the answers, and only for their own team', async () => {
  for (const [n, z] of [['Rider Five', '1005'], ['Rider Six', '1006']]) await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/fix', { only: ['placed'], apply: true }, A);
  await app.post('/api/zrl/captain', { team: 'alpha', key: '1002' }, A);
  await app.post('/api/zrl/availability', { week: 0, zwid: '1000', status: 'no' }, A);
  await app.post('/api/zrl/availability', { week: 0, zwid: '1005', status: 'yes' }, A);
  const cap = { token: await app.memberSession('1002', { name: 'Rider Two' }) };
  const r = await app.post('/api/zrl/lineup', { team: 'alpha', week: 0, auto: true }, cap);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.zwids.includes('1005') && !r.body.zwids.includes('1000'));
  const other = { token: await app.memberSession('1004', { name: 'Rider Four' }) };
  assert.equal((await app.post('/api/zrl/lineup', { team: 'alpha', week: 0, auto: true }, other)).status, 403);
});

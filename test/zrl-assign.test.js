'use strict';
// ZRL auto-assign (the plan) and manual moves.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();

// The plan is a pure function, so it is tested directly.
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const { planAssignments } = require('../lib/zrl')({ HttpError, teamId: n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), text: x => x });
const team = (id, region, grade, captain = '') => ({ id, name: id, region, grade, captain });
const rider = (key, o = {}) => ({ key, name: key, zwid: /^\d+$/.test(key) ? key : '', in: true, cat: 'C', regions: ['eu'], commit: 'full', preferred: '', captain: false, ts: `2026-08-${String(10 + (o.n || 0)).padStart(2, '0')}`, ...o });
const where = plan => Object.fromEntries(plan.moves.map(m => [m.key, m.team]));

test('plan: a rider rides their own category or a weaker one, never a stronger one', () => {
  const teams = [team('b-team', 'eu', 'Open B'), team('c-team', 'eu', 'C')];
  const plan = planAssignments({ teams, assign: {}, signups: [rider('a-rider', { cat: 'A' }), rider('b-rider', { cat: 'B' }), rider('d-rider', { cat: 'D' })] });
  assert.equal(where(plan)['a-rider'], undefined, 'an A rider cannot drop into a B team');
  assert.match(plan.unplaced[0].reason, /category A/);
  assert.equal(where(plan)['b-rider'], 'b-team', 'a close category match breaks the tie');
  assert.ok(['b-team', 'c-team'].includes(where(plan)['d-rider']));
});

test('plan: the right time zone, the team they asked for, and teams nearest to full first', () => {
  const teams = [team('eu1', 'eu', 'C'), team('eu2', 'eu', 'C'), team('am1', 'am', 'C')];
  const assign = { x1: 'eu2', x2: 'eu2' };   // eu2 already has two riders
  const plan = planAssignments({ teams, assign, signups: [
    rider('r1', { n: 1 }), rider('r2', { n: 2, regions: ['am'] }), rider('r3', { n: 3, preferred: 'eu1' }), rider('r4', { n: 4, regions: ['ap'] }),
  ] });
  const w = where(plan);
  assert.equal(w.r3, 'eu1', 'asked-for team first');
  assert.equal(w.r1, 'eu2', 'nearest to full');
  assert.equal(w.r2, 'am1', 'time zone respected');
  assert.equal(w.r4, undefined);
  assert.match(plan.unplaced[0].reason, /none|full/, 'no Asia-Pacific team');
});

test('plan: full-season riders get the places before reserves; teams are never over-filled', () => {
  const plan = planAssignments({ teams: [team('t', 'eu', 'C')], assign: {}, rosterSize: 2, signups: [
    rider('reserve', { n: 1, commit: 'reserve' }), rider('early', { n: 2 }), rider('late', { n: 3 }),
  ] });
  assert.deepEqual(Object.keys(where(plan)).sort(), ['early', 'late']);
  assert.equal(plan.unplaced[0].key, 'reserve');
  assert.equal(plan.teams[0].after, 2);
});

test('plan: one captain proposal per team without a captain; riders already on teams or not racing are left alone', () => {
  const teams = [team('t1', 'eu', 'C'), team('t2', 'eu', 'C', '999')];
  const plan = planAssignments({ teams, assign: { onteam: 't2' }, signups: [
    rider('1001', { n: 1, captain: true, preferred: 't1' }), rider('1002', { n: 2, captain: true, preferred: 't1' }),
    rider('1003', { n: 3, captain: true, preferred: 't2' }), rider('onteam'), rider('out', { in: false }), rider('nozone', { regions: [] }),
  ] });
  assert.deepEqual(Object.keys(plan.captains), ['t1'], 'first captain-minded rider only; t2 already has one');
  assert.equal(plan.captains.t1.zwid, '1001');
  assert.equal(where(plan).onteam, undefined);
  assert.equal(where(plan).out, undefined);
  assert.match(plan.unplaced.find(u => u.key === 'nozone').reason, /no time zone/);
});

// ── through the server ──
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
const auto = (body = {}, token = admin) => app.post('/api/zrl/auto-assign', body, { token });
const view = token => app.get('/api/zrl', { token }).then(r => r.body);
const join = (name, zwid, extra = {}) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C', ...extra });

test('auto-assign: staff only, needs teams, previews without changing anything, then applies', async () => {
  assert.equal((await auto({}, null)).status, 401);
  assert.equal((await auto({}, await app.memberSession('1002'))).status, 401);
  assert.equal((await auto()).status, 409, 'no teams yet');
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', grade: 'C' }, { name: 'CRYO-GEN Beta', region: 'am', grade: 'B' }] }, { token: admin });
  await join('Ann Able', '4378027', { captain: true });
  await join('Bob Baker', '2436518');
  await join('Cal Cole', '1381556', { regions: ['ap'] });
  const preview = await auto();
  assert.equal(preview.status, 200);
  assert.equal(preview.body.plan.summary.placed, 2);
  assert.equal(preview.body.plan.unplaced[0].name, 'Cal Cole');
  assert.deepEqual((await view(admin)).assign, {}, 'preview changes nothing');
  const done = await auto({ apply: true });
  assert.deepEqual(done.body.assigned, { placed: 2, unplaced: 1 });
  const v = await view(admin);
  assert.deepEqual(Object.keys(v.assign).sort(), ['2436518', '4378027']);
  assert.equal(v.round.teams[0].captain, '4378027', 'a captain-minded rider becomes the captain of a team without one');
  assert.equal((await view()).assign, undefined);
});

test('manual moves: put a rider on a team, take them off, unknown rider or team refused', async () => {
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await join('Ann Able', '4378027');
  const move = (key, team, token = admin) => app.post('/api/zrl/assign', { key, team }, { token });
  assert.equal((await move('4378027', 'cryo-gen-alpha', null)).status, 401);
  assert.equal((await move('nobody', 'cryo-gen-alpha')).status, 404);
  assert.equal((await move('4378027', 'nope')).status, 400);
  assert.equal((await move('4378027', 'cryo-gen-alpha')).status, 200);
  assert.equal((await view(admin)).assign['4378027'], 'cryo-gen-alpha');
  assert.equal((await move('4378027', '')).status, 200);
  assert.deepEqual((await view(admin)).assign, {});
});

test('a team holds at most ten racing riders: the eleventh is refused by assign and by the rider edit, a swap is fine', async () => {
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }] }, { token: admin });
  const ids = Array.from({ length: 11 }, (_, i) => String(7000000 + i));
  for (const [i, z] of ids.entries()) await join(`Rider ${i}`, z);
  const move = (key, body = {}) => app.post('/api/zrl/assign', { key, ...body }, { token: admin });
  for (const z of ids.slice(0, 10)) assert.equal((await move(z, { team: 'cryo-gen-alpha' })).status, 200);
  const over = await move(ids[10], { team: 'cryo-gen-alpha' });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Alpha is full \(10\/10\)/);
  assert.equal((await move(ids[10], { team: 'cryo-gen-alpha', add: true })).status, 409, 'adding a second team is held to it too');
  assert.equal((await app.post('/api/zrl/signup-edit', { key: ids[10], team: 'cryo-gen-alpha' }, { token: admin })).status, 409, 'and so is the rider edit');
  assert.equal((await move(ids[0], { team: 'cryo-gen-alpha' })).status, 200, 'a rider already on the team can be re-saved');
  assert.equal((await move(ids[10], { team: 'cryo-gen-beta' })).status, 200, 'another team has room');
  assert.equal((await move(ids[9], { team: '' })).status, 200);
  assert.equal((await move(ids[10], { team: 'cryo-gen-alpha' })).status, 200, 'room again once someone leaves');
});

'use strict';
// A rider on several ZRL teams answers "can you race?" for each team separately (or once for all of them).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());

const post = (path, body, token = admin) => app.post(path, body, { token });
let rider;
beforeEach(async () => {
  app.world.db = {};
  await post('/api/zrl/round', { name: 'Round 2', start: h.ymd(4), closes: h.ymd(2), weeks: 2 });
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Bravo', region: 'am' }] });
  rider = await app.memberSession('1002', { name: 'Rider 2' });
  await app.post('/api/zrl/signup', { regions: ['eu', 'am'], cat: 'C' }, { token: rider });
  await post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' });
  await post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-bravo', add: true });
  await post('/api/zrl/status', { published: true });
});
const mine = async () => (await app.get('/api/zrl/mine', { token: rider })).body.teams;
const answer = (body, token = rider) => app.post('/api/zrl/availability', { week: 0, ...body }, { token });

test('an answer for one team leaves the other unanswered', async () => {
  assert.equal((await answer({ status: 'yes', team: 'cryo-gen-alpha' })).status, 200);
  const t = await mine();
  assert.equal(t.find(x => x.id === 'cryo-gen-alpha').weeks[0].mine, 'yes');
  assert.equal(t.find(x => x.id === 'cryo-gen-bravo').weeks[0].mine, '');
  assert.equal((await answer({ status: 'no', team: 'cryo-gen-bravo' })).status, 200);
  assert.deepEqual((await mine()).map(x => [x.id, x.weeks[0].mine]), [['cryo-gen-alpha', 'yes'], ['cryo-gen-bravo', 'no']]);
});

test('an answer with no team is for all their teams and replaces team-by-team answers', async () => {
  await answer({ status: 'no', team: 'cryo-gen-bravo' });
  await answer({ status: 'maybe' });
  assert.deepEqual((await mine()).map(x => x.weeks[0].mine), ['maybe', 'maybe']);
  await answer({ status: 'yes', team: 'cryo-gen-alpha' });
  assert.deepEqual((await mine()).map(x => x.weeks[0].mine), ['yes', 'maybe'], 'one team can differ from the shared answer');
  await answer({ status: '', team: 'cryo-gen-alpha' });
  assert.deepEqual((await mine()).map(x => x.weeks[0].mine), ['maybe', 'maybe'], 'clearing it falls back to the shared answer');
});

test('a team they are not on is refused; a captain can answer only for their own team', async () => {
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Bravo', region: 'am' }, { name: 'CRYO-GEN Charlie', region: 'eu' }] });
  assert.equal((await answer({ status: 'yes', team: 'cryo-gen-charlie' })).status, 400);
  await post('/api/zrl/signup-edit', { name: 'Cap Three', zwid: '1003', regions: ['eu'], cat: 'C' });
  await post('/api/zrl/assign', { key: '1003', team: 'cryo-gen-alpha' });
  await post('/api/zrl/captain', { team: 'cryo-gen-alpha', key: '1003' });
  const cap = await app.memberSession('1003', { name: 'Rider 3' });
  assert.equal((await answer({ status: 'yes', team: 'cryo-gen-alpha', zwid: '1002' }, cap)).status, 200, "the captain of Alpha, for Alpha");
  assert.equal((await answer({ status: 'yes', team: 'cryo-gen-bravo', zwid: '1002' }, cap)).status, 403, 'not for Bravo');
});

test('a line-up refuses a rider who said no for that team, but not one who said no for the other team', async () => {
  await answer({ status: 'no', team: 'cryo-gen-bravo' });
  const pick = team => post('/api/zrl/lineup', { team, week: 0, zwids: ['1002'] });
  assert.equal((await pick('cryo-gen-bravo')).status, 400);
  assert.equal((await pick('cryo-gen-alpha')).status, 200);
});

test('the staff counts and the subs finder use the answer for that team', async () => {
  await answer({ status: 'yes', team: 'cryo-gen-alpha' });
  await answer({ status: 'no', team: 'cryo-gen-bravo' });
  const w = (await app.get('/api/zrl/weekly', { token: admin })).body.weeks[0].teams;
  assert.deepEqual(w.map(t => [t.id, t.yes, t.no]), [['cryo-gen-alpha', 1, 0], ['cryo-gen-bravo', 0, 1]]);
  const subs = team => app.get(`/api/zrl/subs?team=${team}&week=0`, { token: admin }).then(r => r.body.bench.map(b => b.status));
  assert.deepEqual(await subs('cryo-gen-alpha'), ['yes']);
  assert.deepEqual(await subs('cryo-gen-bravo'), [], 'said no for Bravo, so not on its bench');
});

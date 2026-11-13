'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
const post = (p, b, t) => app.post(p, b, { token: t });

test('team change: a rider asks, the captain of the team they would join (or staff) approves and the move is made; others cannot decide; one open request each', async () => {
  const admin = await app.login('admin'), R = '5001', C = '5002', X = '5003';
  await post('/api/zrl/round', { name: 'R', start: h.ymd(5), closes: h.ymd(-1), weeks: 2 }, admin);
  await post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }, { name: 'Bravo', region: 'eu', grade: 'Open B' }] }, admin);
  for (const [z, t] of [[R, 'alpha'], [C, 'bravo'], [X, 'alpha']]) { await app.post('/api/zrl/signup', { name: `Rider ${z}`, zwid: z, regions: ['eu'], cat: 'B' }); await post('/api/zrl/assign', { key: z, team: t }, admin); }
  await post('/api/zrl/captain', { team: 'bravo', key: C }, admin);
  const rider = await app.memberSession(R, { name: 'Rider 5001' }), cap = await app.memberSession(C, { name: 'Rider 5002' }), other = await app.memberSession(X, { name: 'Rider 5003' });
  assert.equal((await app.get('/api/me/team-change')).status, 401);
  const mine = (await app.get('/api/me/team-change', { token: rider })).body; assert.deepEqual(mine.current.map(t => t.id), ['alpha']); assert.equal(mine.teams.length, 2);
  assert.equal((await post('/api/me/team-change', { to: 'nope' }, rider)).status, 404); assert.equal((await post('/api/me/team-change', { to: 'alpha' }, rider)).status, 409, 'already on it');
  const made = await post('/api/me/team-change', { to: 'bravo', note: 'Closer race times for me' }, rider); assert.equal(made.status, 200); assert.equal(made.body.request.from, 'alpha');
  assert.equal((await post('/api/me/team-change', { to: 'bravo' }, rider)).status, 409, 'one open request at a time');
  assert.equal((await app.get('/api/team-changes', { token: other })).status, 403, 'a rider who is not a captain sees nothing');
  const list = (await app.get('/api/team-changes', { token: cap })).body; assert.equal(list.requests.length, 1); assert.equal(list.requests[0].toName, 'Bravo');
  const id = made.body.request.id; assert.equal((await post('/api/team-changes/decide', { id, action: 'approve' }, other)).status, 403);
  const ok = await post('/api/team-changes/decide', { id, action: 'approve' }, cap); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.request.status, 'approved');
  const after = (await app.get('/api/me/team-change', { token: rider })).body; assert.deepEqual(after.current.map(t => t.id), ['bravo'], 'moved off Alpha, onto Bravo');
  assert.equal((await post('/api/team-changes/decide', { id, action: 'approve' }, cap)).status, 409, 'already dealt with');
  const again = await post('/api/me/team-change', { to: 'alpha' }, rider); assert.equal(again.status, 200); assert.equal((await post('/api/team-changes/decide', { id: again.body.request.id, action: 'decline', reason: 'Alpha is full' }, admin)).body.request.status, 'declined', 'staff can decide too');
  const third = await post('/api/me/team-change', { to: 'alpha' }, rider); assert.equal((await post('/api/me/team-change/cancel', { id: third.body.request.id }, rider)).status, 200);
});

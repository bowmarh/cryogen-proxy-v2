'use strict';
// The staff rider profile: teams across the club, Discord link, and staff notes. Staff only.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { const world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });
const A = { get token() { return admin; } };

test('staff only, and the Zwift ID must be numbers', async () => {
  assert.equal((await app.get('/api/profile?zwid=1002')).status, 401);
  assert.equal((await app.get('/api/profile?zwid=1002', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401, 'a rider cannot read staff notes');
  assert.equal((await app.get('/api/profile?zwid=abc', A)).status, 400);
  assert.equal((await app.post('/api/profile', { zwid: '1002', note: 'x' })).status, 401);
  assert.equal((await app.post('/api/profile', { zwid: '1002' }, A)).status, 400, 'nothing to save');
});

test('notes and details save, merge, clear and are logged with who made them', async () => {
  assert.deepEqual((await app.get('/api/profile?zwid=1002', A)).body.details, {});
  const a = await app.post('/api/profile', { zwid: '1002', tz: 'UK evenings', trainer: 'Kickr', note: 'Wants a C team', by: 'Hanna K' }, A);
  assert.equal(a.status, 200);
  await app.post('/api/profile', { zwid: '1002', bike: 'Canyon' }, A);
  const d = (await app.get('/api/profile?zwid=1002', A)).body.details;
  assert.deepEqual([d.tz, d.trainer, d.bike, d.note, d.by], ['UK evenings', 'Kickr', 'Canyon', 'Wants a C team', '']);
  await app.post('/api/profile', { zwid: '1002', trainer: '' }, A);
  assert.equal((await app.get('/api/profile?zwid=1002', A)).body.details.trainer, undefined, 'an emptied field is removed');
  assert.equal((await app.post('/api/profile', { zwid: '1002', note: 'x'.repeat(801) }, A)).status, 400, 'length limit');
  assert.ok(app.world.db['cg:rider:details']['1002'], 'kept in its own key (and backed up)');
});

test('the profile lists the rider\'s teams in ZRL, the Ladder and the DIRT Series', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', grade: 'Open B' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Rider Two', zwid: '1002', regions: ['eu'], cat: 'C' });
  await app.post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' }, A);
  await app.post('/api/ladder/roster', { zwid: '1002' }, A);
  const t = (await app.get('/api/profile?zwid=1002', A)).body.teams;
  assert.deepEqual(t.zrl.teams, ['CRYO-GEN Alpha']);
  assert.equal(t.zrl.signedUp, true);
  assert.deepEqual(t.ladder, ['CRYO-GEN']);
  assert.deepEqual(t.drs, []);
  assert.deepEqual((await app.get('/api/profile?zwid=1003', A)).body.teams.zrl, { signedUp: false, teams: [] });
});

test('the club roster now carries the extra power and rating numbers, and still no age, weight or height', async () => {
  const r = (await app.get('/api/roster')).body.riders[0];
  assert.ok(r.power && 'wkg1200' in r.power);
  const raw = JSON.stringify((await app.get('/api/roster')).body);
  assert.doesNotMatch(raw, /"weight"|"height"|"age"|"gender"/);
});

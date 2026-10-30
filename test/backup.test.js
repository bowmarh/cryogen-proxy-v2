'use strict';
// Backups: a quiet daily copy of the ZRL and TTT data, kept in Redis; admins can download, take one now, or restore one.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const backups = (token = admin) => app.get('/api/admin/backups', { token });
const state = async () => (await app.get('/api/zrl', { token: admin })).body;

beforeEach(async () => {
  app.world.db = {};
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
});

test('the scheduled tick takes one quiet copy a day; backups are admin only', async () => {
  assert.deepEqual(await tick(), [], 'a backup is not an event: nothing is reported or posted');
  await tick(); await tick();
  const list = (await backups()).body.backups;
  assert.equal(list.length, 1, 'one a day');
  assert.equal(list[0].kind, 'auto');
  assert.equal((await backups(null)).status, 401);
  assert.equal((await backups(mod)).status, 403, 'a moderator is not an admin');
  assert.equal((await app.post('/api/admin/backup-now', {}, { token: mod })).status, 403);
  assert.equal((await app.get('/api/admin/backup-download', { token: mod })).status, 403);
  assert.equal((await app.post('/api/admin/restore', { id: list[0].id, confirm: 'RESTORE' }, { token: mod })).status, 403);
});

test('a download holds the round, sign-ups and placements, live or from a stored copy', async () => {
  const live = (await app.get('/api/admin/backup-download', { token: admin })).body;
  assert.equal(JSON.parse(live.data['cg:zrl:round'].v).name, 'Round 2');
  assert.equal(JSON.parse(live.data['cg:zrl:signups'].v['4378027']).name, 'Ann Able');
  assert.equal(live.data['cg:zrl:assign'].v['4378027'], 'cryo-gen-alpha');
  await tick();
  const id = (await backups()).body.backups[0].id;
  const stored = (await app.get(`/api/admin/backup-download?id=${encodeURIComponent(id)}`, { token: admin })).body;
  assert.equal(stored.data['cg:zrl:assign'].v['4378027'], 'cryo-gen-alpha');
  assert.equal((await app.get('/api/admin/backup-download?id=nope', { token: admin })).status, 404);
});

test('restoring needs the word RESTORE, brings the data back, and keeps a safety copy of what it replaced', async () => {
  const id = (await app.post('/api/admin/backup-now', {}, { token: admin })).body.id;
  await app.post('/api/zrl/round-delete', { confirm: '2026-11-17' }, { token: admin });   // the mistake
  assert.equal((await state()).round, null);
  assert.equal((await app.post('/api/admin/restore', { id, confirm: 'yes' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/admin/restore', { id: 'nope', confirm: 'RESTORE' }, { token: admin })).status, 404);
  const r = await app.post('/api/admin/restore', { id, confirm: 'RESTORE' }, { token: admin });
  assert.equal(r.status, 200);
  const s = await state();
  assert.equal(s.round.name, 'Round 2');
  assert.equal(s.signups[0].name, 'Ann Able'); assert.equal(s.assign['4378027'], 'cryo-gen-alpha');
  const kinds = (await backups()).body.backups.map(b => b.kind);
  assert.ok(kinds.includes('pre-restore'), 'the state before the restore was kept');
  // going back to the safety copy returns to what was there before the restore: the round was gone
  await app.post('/api/admin/restore', { id: r.body.safety, confirm: 'RESTORE' }, { token: admin });
  assert.equal((await state()).round, null, 'an undo for the restore itself');
});

test('old copies are pruned; the health row reports the last automatic copy', async () => {
  assert.equal((await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'backup').status, 'warn', 'none yet');
  await tick();
  const row = (await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'backup');
  assert.equal(row.status, 'ok'); assert.match(row.detail, /1 daily copy kept; the last was under an hour ago/);
  for (let i = 0; i < 12; i++) { await app.post('/api/admin/backup-now', {}, { token: admin }); await new Promise(r => setTimeout(r, 2)); }
  const manual = (await backups()).body.backups.filter(b => b.kind === 'manual');
  assert.equal(manual.length, 10, 'ten manual copies are kept');
});

test('the weekly restore test passes on a good copy, writes nothing, shows in health, and fails on an empty or damaged one', async () => {
  const world = app.world;
  void world;
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, { token: admin });
  await tick();   // takes the daily copy and the first test
  const ok = (await app.post('/api/admin/backup-verify', {}, { token: admin })).body;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.commands > 0 && ok.backupItems > 0);
  const live = JSON.stringify(app.world.db['cg:zrl:round']);
  await app.post('/api/admin/backup-verify', {}, { token: admin });
  assert.equal(JSON.stringify(app.world.db['cg:zrl:round']), live, 'nothing was restored');
  const health = (await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'backup');
  assert.match(health.detail, /Restore test passed/);
  const field = Object.keys(app.world.db['cg:backup']).find(f => f.startsWith('auto:'));
  app.world.db['cg:backup'][field] = 'not a backup';
  const bad = (await app.post('/api/admin/backup-verify', {}, { token: admin })).body;
  assert.equal(bad.ok, false); assert.match(bad.problems[0], /could not be read/);
  assert.equal((await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'backup').status, 'warn');
  assert.equal((await app.post('/api/admin/backup-verify', {}, { token: await app.login('mod') })).status, 403);
});

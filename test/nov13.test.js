'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ HOSTINGER_MAIL_TOKEN: 'mail-token', HOSTINGER_MAIL_MAILBOX_ID: 'mbx_1', ALERT_EMAIL: 'owner@example.com' });
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { world.mails = []; });
const post = (p, b, t) => app.post(p, b, { token: t });

test('a real restore test writes the newest copy to scratch keys, compares it item for item, removes the scratch keys, and reports on the health row', async () => {
  const admin = await app.login('admin');
  assert.equal((await post('/api/admin/backup-restore-test', {}, admin)).body.ok, false, 'no copy yet: it says so'); 
  assert.equal((await post('/api/admin/backup-now', {}, await app.login('owner'))).status, 200);
  const cron = await app.call('POST', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }); assert.equal(cron.status, 200);
  const r = (await post('/api/admin/backup-restore-test', {}, admin)).body; assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.items > 0 && r.keys > 0, 'it restored something');
  assert.ok(!Object.keys(world.db || {}).some(k => k.startsWith('cg:rt:')), 'the scratch keys are gone');
  assert.equal((await post('/api/admin/backup-restore-test', {}, await app.login('mod'))).status, 403);
});

test('the weekly health email: needs ALERT_EMAIL, previews without sending, sends on request, only admins can ask', async () => {
  const admin = await app.login('admin'), owner = await app.login('owner');
  assert.equal((await app.get('/api/healthdigest', { token: await app.login('mod') })).status, 403);
  const pre = await app.get('/api/healthdigest', { token: admin }); assert.equal(pre.status, 200); assert.equal(pre.body.configured, true); assert.match(pre.body.preview.body, /Your CRYO-GEN week/); assert.match(pre.body.preview.body, /join request|No join requests/); assert.match(pre.body.preview.body, /Errors and failing jobs/); assert.equal(world.mails.length, 0, 'a preview sends nothing');
  assert.equal((await post('/api/mail/settings', { enabled: true }, owner)).status, 200);
  const sent = await post('/api/healthdigest/send', {}, admin); assert.equal(sent.status, 200); const m = world.mails.find(x => x.to && x.to[0] === 'owner@example.com'); assert.ok(m, 'emailed to ALERT_EMAIL'); assert.match(m.text || m.body || '', /Control room/);
});

test('past rounds: any signed-in rider or staff member can list them, a guest cannot, and an unknown round is refused', async () => {
  assert.equal((await app.get('/api/zrl/past')).status, 401);
  const rider = await app.memberSession('1002'); const list = await app.get('/api/zrl/past', { token: rider }); assert.equal(list.status, 200); assert.ok(Array.isArray(list.body.rounds));
  assert.equal((await app.get('/api/zrl/past', { token: await app.login('mod') })).status, 200);
  assert.ok((await app.get('/api/zrl/past?id=nope', { token: rider })).status >= 400);
});

test('weeks I can\'t race: a rider ticks weeks once, they count as No in every answer, an explicit answer for the week still wins, and it is cleared with the round', async () => {
  const admin = await app.login('admin'), id = '4001';
  await post('/api/zrl/round', { name: 'R', start: h.ymd(5), closes: h.ymd(-1), weeks: 4 }, admin);
  await post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }] }, admin);
  await app.post('/api/zrl/signup', { name: 'Off Rider', zwid: id, regions: ['eu'], cat: 'B' }); await post('/api/zrl/assign', { key: id, team: 'alpha' }, admin);
  const rider = await app.memberSession(id, { name: 'Off Rider' });
  assert.equal((await app.get('/api/me/weeksoff')).status, 401);
  const g = await app.get('/api/me/weeksoff', { token: rider }); assert.equal(g.status, 200); assert.equal(g.body.weeks.length, 4); assert.deepEqual(g.body.off, []);
  assert.equal((await post('/api/me/weeksoff', { off: [1, 2, 9, 'x', 1] }, rider)).body.off.length, 2, 'only real weeks, once each');
  const w = (await app.get('/api/zrl', { token: admin })).body, avail = (w.weekly && w.weekly.avail) || {}; assert.equal(avail[`1:${id}`], 'no'); assert.equal(avail[`2:${id}`], 'no'); assert.equal(avail[`0:${id}`], undefined);
  assert.equal((await post('/api/zrl/availability', { week: 1, zwid: id, status: 'yes' }, admin)).status, 200);
  const w2 = (await app.get('/api/zrl', { token: admin })).body.weekly.avail; assert.equal(w2[`1:${id}`], 'yes', 'an explicit answer wins'); assert.equal(w2[`2:${id}`], 'no');
  assert.deepEqual((await post('/api/me/weeksoff', { off: [] }, rider)).body.off, []); assert.equal((await app.get('/api/zrl', { token: admin })).body.weekly.avail[`2:${id}`], undefined, 'cleared');
});

test('the launch plan now walks through the sign-in hardening: alert email, owner authenticator, personal administrators, then retiring the shared password', async () => {
  const admin = await app.login('admin'), plan = (await app.get('/api/launch', { token: admin })).body.plan, byId = Object.fromEntries(plan.steps.map(s => [s.id, s]));
  assert.equal(byId.alert.status, 'done', 'ALERT_EMAIL is set in this test'); assert.ok(byId.owner2fa && byId.staffaccounts && byId.retire);
  assert.equal(byId.retire.status, 'blocked'); assert.match(byId.retire.blockedBy[0], /personal login/);
});

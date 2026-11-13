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

test('leaving the club: a preview changes nothing, one press marks the WordPress record as left and stops email, and only an administrator can do it', async () => {
  const admin = await app.login('admin'), mod = await app.login('mod'), m = world.members.find(x => x.zwift_id) || world.members[0], z = String(m.zwift_id);
  assert.equal((await post('/api/offboard', { zwid: z }, mod)).status, 403); assert.equal((await post('/api/offboard', { zwid: 'abc' }, admin)).status, 400);
  const before = m.status, pre = await post('/api/offboard', { zwid: z }, admin); assert.equal(pre.status, 200); assert.equal(pre.body.preview, true); assert.ok(pre.body.steps.some(s => s.planned) && pre.body.steps.some(s => s.manual), 'the Discord role is the one manual step'); assert.equal(m.status, before, 'a preview changes nothing');
  const done = await post('/api/offboard', { zwid: z, preview: false }, admin); assert.equal(done.status, 200); assert.equal(m.status, 'left', 'WordPress now says left'); assert.ok(done.body.steps.find(s => /WordPress/.test(s.step)).ok);
  assert.equal((await post('/api/offboard', { zwid: '99999999', preview: false }, admin)).body.ok, false, 'a rider with no record: the failing step is shown, not hidden');
});

test('the off-site backup export needs the cron secret and returns a snapshot; the smoke check covers sign-in', async () => {
  assert.equal((await app.call('POST', '/api/cron/backup-export', {})).status, 401); assert.equal((await app.call('POST', '/api/cron/backup-export', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await app.call('POST', '/api/cron/backup-export', { headers: { Authorization: 'Bearer cron-secret' } }); assert.equal(ok.status, 200); assert.equal(ok.body.app, 'cryogen-proxy'); assert.ok(ok.body.data && typeof ok.body.data === 'object');
  const smoke = await app.call('POST', '/api/smoke', { headers: { Authorization: 'Bearer cron-secret' } }); const si = (smoke.body.checks || []).find(c => c.name === 'Sign-in'); assert.ok(si && si.ok, JSON.stringify(si)); 
});

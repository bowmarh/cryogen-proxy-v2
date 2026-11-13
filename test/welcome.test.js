'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ HOSTINGER_MAIL_TOKEN: 'mail-token', HOSTINGER_MAIL_MAILBOX_ID: 'mbx_1' });
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
const post = (p, b, t) => app.post(p, b, { token: t });

test('the Get set up screen: only new members, Discord is checked by the app, ZwiftPower and Facebook are confirmed then accepted by a volunteer, then the racing series, then it is gone', async () => {
  const admin = await app.login('admin'), mod = await app.login('mod');
  assert.equal((await app.get('/api/me/welcome')).status, 401);
  // Members already in the club when onboarding first runs are never shown it.
  const old = await app.memberSession('1002'); await app.get('/api/onboarding', { token: admin });
  assert.equal((await app.get('/api/me/welcome', { token: old })).body.show, false, 'existing member');
  // Links are set by an administrator: full https addresses only.
  assert.equal((await post('/api/welcome/settings', { links: { zwiftpower: 'http://x' } }, admin)).status, 400); assert.equal((await post('/api/welcome/settings', { links: { discord: 'https://discord.gg/club' } }, mod)).status, 403);
  const saved = await post('/api/welcome/settings', { links: { discord: 'https://discord.gg/club', zwiftpower: 'https://zwiftpower.com/team.php?id=1', facebook: 'https://facebook.com/groups/cryogen' } }, admin); assert.equal(saved.status, 200);
  const fresh = await app.memberSession('7001', { name: 'Newbie Rider' });
  const v1 = (await app.get('/api/me/welcome', { token: fresh })).body; assert.equal(v1.show, true); assert.equal(v1.stage, 1); assert.deepEqual(v1.steps.map(s => s.id), ['discord', 'zwiftpower', 'facebook']); assert.equal(v1.steps[0].done, false); assert.deepEqual(v1.series, [], 'the series wait until the three are done');
  assert.equal((await post('/api/me/welcome/finish', {}, fresh)).status, 409, 'cannot skip');
  assert.equal((await post('/api/me/welcome/confirm', { step: 'discord' }, fresh)).status, 400, 'Discord is verified by the app, not by a click');
  const z = (await post('/api/me/welcome/confirm', { step: 'zwiftpower' }, fresh)).body; assert.equal(z.steps[1].done, true); assert.equal(z.steps[1].accepted, false);
  assert.equal((await app.get('/api/welcome/queue', { token: mod })).body.waiting[0].zwid, '7001', 'a volunteer sees who to accept');
  assert.equal((await post('/api/welcome/zp-accepted', { zwid: '7001' }, mod)).status, 200); assert.equal((await app.get('/api/me/welcome', { token: fresh })).body.steps[1].accepted, true); assert.equal((await app.get('/api/welcome/queue', { token: mod })).body.waiting.length, 0);
  await post('/api/me/welcome/confirm', { step: 'facebook' }, fresh);
  assert.equal((await app.get('/api/me/welcome', { token: fresh })).body.stage, 1, 'still waiting for Discord');
  // Discord linked: stage two, every racing series.
  app.world.db['cg:comms:discord'] = { ...(app.world.db['cg:comms:discord'] || {}), 7001: JSON.stringify({ id: '999', at: new Date().toISOString(), by: 'self', verified: true }) };   // the member's verified Discord link
  const v2 = (await app.get('/api/me/welcome', { token: fresh })).body; assert.equal(v2.stage, 2, JSON.stringify(v2.steps));
  { assert.deepEqual(v2.series.map(s => s.id), ['zrl', 'ttt', 'drs', 'ladder', 'rides', 'events']); assert.equal((await post('/api/me/welcome/finish', {}, fresh)).status, 200); assert.equal((await app.get('/api/me/welcome', { token: fresh })).body.show, false, 'gone for good'); }
});

test('the welcome email puts the three channels first, numbered, using the links the club set', async () => {
  const admin = await app.login('admin'), owner = await app.login('owner'); world.mails = [];
  await post('/api/mail/settings', { enabled: true }, owner);
  const rec = await app.post('/api/join', { name: 'Pat Joiner', email: 'pat@example.com', consent: true });
  assert.equal(rec.status, 200); const list = (await app.get('/api/join', { token: admin })).body.requests, r = list.find(x => x.email === 'pat@example.com');
  const d = await post('/api/join/decide', { id: r.id, action: 'welcome' }, admin); assert.equal(d.status, 200);
  const m = world.mails.find(x => x.to && x.to[0] === 'pat@example.com'); assert.ok(m, 'sent'); const body = m.text || m.body || '';
  assert.match(m.subject || '', /three things/i); assert.match(body, /1\. Join our Discord[^\n]*discord\.gg\/club/); assert.match(body, /2\. Join Team CRYO-GEN on ZwiftPower[^\n]*zwiftpower\.com/); assert.match(body, /3\. Join the Facebook group[^\n]*facebook\.com/);
});

'use strict';
// The morning digest for the admin channel: once a day, only when there is something to say, switchable by an administrator.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { process.env.DIGEST_FROM_HOUR = '0'; app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => { delete process.env.DIGEST_FROM_HOUR; return app.close(); });
const A = { get token() { return admin; } };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const digests = () => adminPosts().filter(t => /Good morning/.test(t));
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });
const turnOn = () => app.post('/api/digest', { on: true }, A);

test('one digest a day, naming what needs attention', async () => {
  await turnOn();
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(5), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Rider Zero', zwid: '1000', regions: ['eu'], cat: 'B' });
  app.world.discord.length = 0;
  await tick();
  assert.equal(digests().length, 1);
  assert.match(digests()[0], /This week/); assert.match(digests()[0], /ZRL|Round 2/);
  await tick();
  assert.equal(digests().length, 1, 'once a day');
});

test('what the automation did in the last day, and what is on today, are included', async () => {
  await turnOn();
  await app.post('/api/ttt/new-week', { date: h.ymd(0) }, A);
  await app.post('/api/ttt/signup', { name: 'Ann Lee' });
  await app.post('/api/ttt/auto-assign', {}, A);
  app.world.discord.length = 0;
  await tick();
  const text = digests()[0];
  assert.match(text, /The automation did 1 thing/); assert.match(text, /TTT: Allocated 1 rider/);
});

test('an administrator can switch it off; a moderator can read the setting but not change it; riders cannot see it', async () => {
  assert.equal((await app.get('/api/digest', A)).body.on, false, 'off until an administrator turns it on');
  await turnOn();
  assert.equal((await app.get('/api/digest', A)).body.on, true);
  assert.equal((await app.post('/api/digest', { on: false }, { token: await app.login('mod') })).status, 403);
  assert.equal((await app.get('/api/digest', { token: await app.login('mod') })).body.canChange, false);
  assert.equal((await app.post('/api/digest', { on: false }, A)).body.on, false);
  await app.post('/api/ttt/new-week', { date: h.ymd(0) }, A);
  app.world.discord.length = 0;
  await tick();
  assert.equal(digests().length, 0, 'switched off');
  assert.equal((await app.get('/api/digest')).status, 401);
  assert.equal((await app.get('/api/digest', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
});

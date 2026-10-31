'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const post = () => app.post('/api/comms/test-post', {}, { token: admin });

test('a Discord hiccup is retried straight away and nothing is lost', async () => {
  app.world.discord.length = 0; app.world.discordFail = 1;
  const r = await app.post('/api/zrl/round', { name: 'Round A', start: h.ymd(5), closes: h.ymd(2) }, { token: admin });
  assert.equal(r.status, 200);
  assert.equal(app.world.discordFail, 0, 'the first attempt failed');
  assert.ok(app.world.discord.length >= 1, 'the retry delivered it');
});

test('a post that keeps failing waits in the outbox and goes out on a later run', async () => {
  app.world.db = {}; app.world.discord.length = 0;
  app.world.discordFail = 2;   // the first try and its retry both fail
  await app.post('/api/zrl/round', { name: 'Round B', start: h.ymd(5), closes: h.ymd(2) }, { token: admin });
  const queued = Object.keys(app.world.db['cg:outbox'] || {});
  assert.ok(queued.length >= 1, 'queued');
  assert.equal(app.world.discord.length, 0);
  const ran = await tick();
  assert.ok(ran.some(x => /Outbox: sent/.test(x)), JSON.stringify(ran));
  assert.ok(app.world.discord.length >= 1);
  assert.equal(Object.keys(app.world.db['cg:outbox'] || {}).length, 0);
});

test('a hook that is refused (not a hiccup) is not queued', async () => {
  app.world.db = {}; app.world.discord.length = 0;
  app.world.discordFail = 5; app.world.discordFailStatus = 404;
  await app.post('/api/zrl/round', { name: 'Round C', start: h.ymd(5), closes: h.ymd(2) }, { token: admin });
  assert.equal(Object.keys(app.world.db['cg:outbox'] || {}).length, 0);
  app.world.discordFail = 0; app.world.discordFailStatus = 0;
});

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => { delete process.env.STAGING; return app.close(); });

test('a normal copy refuses to seed and shows no banner', async () => {
  assert.equal((await app.get('/api/auth/status')).body.staging, false);
  const r = await app.post('/api/staging/seed', {}, { token: admin });
  assert.equal(r.body.created, false);
  assert.equal((await app.post('/api/staging/seed', {})).status, 401);
});

test('staging: banner flag, [STAGING] tag on Discord posts, seed makes a round once', async () => {
  process.env.STAGING = '1';
  assert.equal((await app.get('/api/auth/status')).body.staging, true);
  const r = await app.post('/api/staging/seed', {}, { token: admin });
  assert.equal(r.body.created, true, JSON.stringify(r.body));
  const v = (await app.get('/api/zrl', { token: admin })).body;
  assert.equal(v.round.teams.length, 2);
  assert.equal(v.signups.length, 10);
  assert.equal((await app.post('/api/staging/seed', {}, { token: admin })).body.created, false);
  app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round X', start: h.ymd(20), closes: h.ymd(25) }, { token: admin });
  assert.ok(app.world.discord.length > 0 && app.world.discord.every(d => /^\[STAGING\]/.test(d.body.username)), 'every Discord post is tagged');
});

'use strict';
// Uptime check, alerts for unexpected errors, and the public page's cache.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
const A = { get token() { return admin; } };
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('the uptime check needs no sign-in, says the database answers, and fails when it does not', async () => {
  const ok = await app.get('/api/ping');
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.ok, ok.body.redis], [true, true]);
  const real = process.env.KV_REST_API_TOKEN; process.env.KV_REST_API_TOKEN = 'wrong';
  try { assert.equal((await app.get('/api/ping')).status, 503); } finally { process.env.KV_REST_API_TOKEN = real; }
});

test('an unexpected failure is told to the admin channel once an hour without private details; a refusal the app chose is not', async () => {
  assert.equal((await app.post('/api/zrl/signup', { name: 'x' })).status, 409, 'a refusal is not an alert');
  assert.equal(app.world.discord.filter(p => /Unexpected error/.test(p.body.content)).length, 0);
  app.world.db['cg:zrl:round'] = '{broken json';   // stored data that cannot be read: nothing the app planned for
  assert.equal((await app.get('/api/zrl', A)).status, 500);
  await new Promise(r => setTimeout(r, 150));
  const alerts = () => app.world.discord.filter(p => p.channel === 'admin' && /Unexpected error/.test(p.body.content));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].body.content, /GET \/api\/zrl/);
  assert.ok(!/Bearer|password|token/i.test(alerts()[0].body.content), 'nothing private in the alert');
  await app.get('/api/zrl', A); await new Promise(r => setTimeout(r, 150));
  assert.equal(alerts().length, 1, 'the same failure is reported once an hour');
});

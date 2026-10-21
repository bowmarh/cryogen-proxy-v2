'use strict';
// The roster source throttles (429). One shared copy in Redis keeps every server instance
// from asking, and the last good copy is served if the source fails.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
const RIDERS_KEY = 'cg:roster:riders';

// Servers started by a test are always closed afterwards, even if an assertion fails halfway:
// an open server would keep the test process alive and make a failure look like a hang.
const live = [];
const start = async world => { const a = await h.startApp(world); live.push(a); return a; };
afterEach(async () => { while (live.length) await live.pop().close(); });

test('one request to the source, then shared by every instance, even while it is throttling', async () => {
  const world = h.createWorld();
  let app = await start(world);
  assert.equal((await app.get('/api/roster')).body.riders.length, 5);
  assert.equal(world.clubCalls, 1);
  assert.ok(world.db[RIDERS_KEY], 'a shared copy was saved');
  await app.get('/api/roster');
  assert.equal(world.clubCalls, 1, 'second request on the same instance uses its memory');
  await app.close();

  world.clubMode = '429';
  app = await start(world); // a brand-new instance with an empty memory cache
  const r = await app.get('/api/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.riders.length, 5);
  assert.equal(world.clubCalls, 1, 'the new instance did not ask the throttled source');
  await app.close();
});

test('a stale copy is still served when the source fails', async () => {
  const world = h.createWorld();
  let app = await start(world);
  await app.get('/api/roster');
  await app.close();

  const saved = JSON.parse(world.db[RIDERS_KEY]);
  world.db[RIDERS_KEY] = JSON.stringify({ ...saved, at: 1 }); // ancient
  world.clubMode = '429';
  const calls = world.clubCalls;
  app = await start(world);
  const r = await app.get('/api/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.riders.length, 5, 'last good copy');
  assert.equal(world.clubCalls, calls + 1, 'it did try the source first');
  await app.close();
});

test('a fresh copy is refreshed from the source once it is old and the source is healthy', async () => {
  const world = h.createWorld();
  let app = await start(world);
  await app.get('/api/roster');
  await app.close();
  const saved = JSON.parse(world.db[RIDERS_KEY]);
  world.db[RIDERS_KEY] = JSON.stringify({ ...saved, at: 1 });
  world.riders = world.riders.slice(0, 3); // the club shrank
  app = await start(world);
  assert.equal((await app.get('/api/roster')).body.riders.length, 3);
  assert.equal(JSON.parse(world.db[RIDERS_KEY]).riders.length, 3, 'the shared copy was refreshed');
  await app.close();
});

test('with no copy at all and a throttled source, the error is clear', async () => {
  const world = h.createWorld({ clubMode: '429' });
  const app = await start(world);
  const r = await app.get('/api/roster');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /429/);
  await app.close();
});

test('the roster still works when shared storage is unavailable', async () => {
  const saved = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
  const app = await start(h.createWorld());
  try {
    const r = await app.get('/api/roster');
    assert.equal(r.status, 200);
    assert.equal(r.body.riders.length, 5);
  } finally { process.env.KV_REST_API_URL = saved; await app.close(); }
});

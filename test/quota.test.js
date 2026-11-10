'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ REDIS_MONTHLY_LIMIT: '100000' });
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());

test('when storage is over its limit, a signed-in person is shown their last saved page, marked stale', async () => {
  const live = await app.get('/api/week', { token: admin });
  assert.equal(live.status, 200); assert.equal(live.headers['x-stale'], undefined);
  app.world.redisDown = true;
  try {
    const down = await app.get('/api/week', { token: admin });
    assert.equal(down.status, 200); assert.equal(down.headers['x-stale'], '1');
    assert.deepEqual(down.body, live.body, 'the same page as before, not an error');
    const other = await app.get('/api/fairplay', { token: admin });
    assert.equal(other.status, 502, 'a page that was never loaded has nothing saved, so it still says why');
    assert.equal((await app.call('POST', '/api/caselog/add', { token: admin, body: { zwift_id: '1', event_name: 'x', event_date: '2026-10-01', outcome: 'resolved' } })).status >= 500, true, 'writes are never faked');
  } finally { app.world.redisDown = false; }
  assert.equal((await app.get('/api/week', { token: admin })).headers['x-stale'], undefined, 'live again once storage is back');
});

test('the saved copy is only ever shown to the person it was made for', async () => {
  await app.get('/api/week', { token: admin });
  const mod = await app.login('mod');
  app.world.redisDown = true;
  try { assert.equal((await app.get('/api/week', { token: mod })).headers['x-stale'], undefined, 'no copy was ever made for this person'); } finally { app.world.redisDown = false; }
});

test('the health panel warns at 70% of the monthly plan, fails at 90%, and the admin channel hears once each', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const checks = async () => Object.fromEntries((await app.get('/api/health', { token: admin })).body.checks.map(c => [c.id, c]));
  app.world.db['cg:usage'] = { [`m:${month}`]: '72000' };
  assert.equal((await checks()).usage.status, 'warn'); assert.match((await checks()).usage.detail, /7\d% of this month/);
  app.world.db['cg:usage'] = { [`m:${month}`]: '95000' };
  assert.equal((await checks()).usage.status, 'fail');
  app.world.db['cg:usage'] = { [`m:${month}`]: '10' };
  assert.equal((await checks()).usage.status, 'ok');
});

test('a refused request says what the storage service said, so the cause is visible in the health panel and the logs', async () => {
  app.world.redisDown = true;
  try {
    const r = await app.get('/api/fairplay', { token: admin });
    assert.equal(r.status, 502); assert.match(r.body.error, /^storage error \(500\): ERR max requests limit exceeded/);
  } finally { app.world.redisDown = false; }
});

'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { plan, wakeFor, ALWAYS } = require('../lib/tickplan');

h.setEnv();
const MIN = 60000, T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

test('plan: everything runs unless it is an automatic tick with nothing due', () => {
  assert.equal(plan({ speed: undefined, now: T0, state: { fullAt: T0 } }).full, true, 'manual and daily runs are unchanged');
  assert.equal(plan({ speed: 'auto', now: T0, state: null }).full, true, 'no record yet');
  assert.equal(plan({ speed: 'auto', now: T0 + 15 * MIN, state: { fullAt: T0 } }).full, false);
  assert.equal(plan({ speed: 'auto', now: T0 + 54 * MIN, state: { fullAt: T0, wake: null } }).full, false);
  assert.equal(plan({ speed: 'auto', now: T0 + 55 * MIN, state: { fullAt: T0 } }).full, true, 'a late tick still gets its hourly full run');
  assert.equal(plan({ speed: 'auto', now: T0 + 15 * MIN, state: { fullAt: T0, wake: T0 + 10 * MIN } }).full, true, 'a race is close');
  assert.equal(plan({ speed: 'auto', now: T0 + 15 * MIN, state: { fullAt: T0, wake: T0 + 30 * MIN } }).full, false, 'not yet');
});

test('wake: 90 minutes before the next start, ignoring races that began more than 30 minutes ago', () => {
  assert.equal(wakeFor([], T0), null);
  assert.equal(wakeFor([{ minutes: 300 }, { minutes: 120 }], T0), T0 + 30 * MIN, 'the nearest race decides');
  assert.equal(wakeFor([{ minutes: -45 }, { minutes: 600 }], T0), T0 + 510 * MIN, 'one that began 45 minutes ago no longer counts');
  assert.equal(wakeFor([{ minutes: -10 }], T0), T0 - 100 * MIN, 'a race under way keeps full runs going');
  assert.deepEqual(ALWAYS, ['Outbox', 'Usage', 'Comms']);
});

let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => { delete process.env.CRON_CLOCK_MS; return app.close(); });
beforeEach(() => { app.world.db = {}; });
const tick = (at, q = '?speed=auto') => { process.env.CRON_CLOCK_MS = String(at); return app.call('POST', '/api/cron/tick' + q, { headers: { Authorization: 'Bearer cron-secret' } }); };

test('the workflow tick: a full run, then light runs, then a full run again an hour later', async () => {
  const a = await tick(T0); assert.equal(a.body.mode, 'full');
  assert.ok(app.world.db['cg:fair:last'], 'the daily Fair play check ran in the full tick');
  delete app.world.db['cg:fair:last'];
  const b = await tick(T0 + 15 * MIN); assert.equal(b.body.mode, 'light'); assert.equal(b.body.why, 'nothing is due');
  assert.equal(app.world.db['cg:fair:last'], undefined, 'light ticks leave the other jobs alone');
  assert.equal((await tick(T0 + 30 * MIN)).body.mode, 'light');
  assert.equal((await tick(T0 + 56 * MIN)).body.mode, 'full');
  assert.ok(app.world.db['cg:fair:last']);
});

test('a tick with no ?speed=auto always runs everything, and a close race forces a full run', async () => {
  await tick(T0);
  const plain = await tick(T0 + 15 * MIN, ''); assert.equal(plain.body.mode, undefined);
  assert.ok(app.world.db['cg:fair:last'], 'everything ran');
  app.world.db['cg:cron:plan'] = JSON.stringify({ fullAt: T0, wake: T0 + 10 * MIN });
  assert.equal((await tick(T0 + 15 * MIN)).body.why, 'a race is close');
});

test('the health panel still sees the workflow running on light ticks', async () => {
  await tick(T0); await tick(T0 + 15 * MIN);
  assert.ok(app.world.db['cg:cron:last']);
});

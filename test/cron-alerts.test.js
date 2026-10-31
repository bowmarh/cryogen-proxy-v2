'use strict';
// A scheduled job that breaks must not stop the others, and the admin channel hears about it (once per job every six hours).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const health = async () => Object.fromEntries((await app.get('/api/health', { token: await app.login('admin') })).body.checks.map(c => [c.id, c]));
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);

beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('a broken ZRL job is reported, the other jobs still run, and the health panel shows it', async () => {
  app.world.db['cg:zrl:round'] = '{not json';
  const r = await tick();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.failed.map(f => f.job), ['ZRL']);
  assert.equal(adminPosts().length, 1);
  assert.match(adminPosts()[0], /scheduled ZRL job failed/);
  await tick();
  assert.equal(adminPosts().length, 1, 'not again within six hours');
  const c = await health();
  assert.equal(c.cron.status, 'fail');
  assert.match(c.cron.detail, /ZRL job failed/);
});

test('a clean run reports nothing and clears the failure', async () => {
  app.world.db['cg:zrl:round'] = '{not json';
  await tick();
  delete app.world.db['cg:zrl:round']; app.world.discord.length = 0;
  const r = await tick();
  assert.equal(r.body.failed, undefined);
  assert.equal(adminPosts().length, 1, 'one message: it fixed itself');
  assert.match(adminPosts()[0], /Fixed itself.*ZRL/);
  app.world.discord.length = 0;
  await tick();
  assert.equal(adminPosts().length, 0, 'and it is not repeated');
  assert.notEqual((await health()).cron.status, 'fail');
});

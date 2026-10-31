'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { world.discord.length = 0; });

const health = async () => {
  // Fresh login each time: sessions are derived from the passwords, so changing one signs everyone out.
  const r = await app.get('/api/health', { token: await app.login('admin') });
  assert.equal(r.status, 200);
  return Object.fromEntries(r.body.checks.map(c => [c.id, c]));
};

test('every area is reported, and nothing secret or noisy happens while checking', async () => {
  const clubCalls = world.clubCalls;
  const r = await app.get('/api/health', { token: admin });
  assert.deepEqual(r.body.checks.map(c => c.id), ['usage', 'outbox', 'storage', 'members', 'roster', 'sheet', 'discord', 'week', 'zrl', 'backup', 'cover', 'ladder', 'drs', 'assoc', 'sheetsync', 'comms', 'cron', 'signin', 'guests', 'staff', 'deploy']);
  const text = JSON.stringify(r.body);
  for (const secret of ['redis-token', 'wppass', 'wpuser', 'admin-pw', 'mod-pw', 'sso-secret-for-tests', 'cron-secret', 'discord.test']) {
    assert.ok(!text.includes(secret), `the health report leaked "${secret}"`);
  }
  assert.equal(world.discord.length, 0, 'nothing is posted to Discord');
  assert.equal(world.clubCalls, clubCalls, 'the throttled roster source is not called');
});

test('a healthy, fully configured system', async () => {
  await app.post('/api/ttt/new-week', { date: h.ymd(9) }, { token: admin });
  await app.get('/api/roster'); // saves the shared roster copy
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const c = await health();
  for (const id of ['storage', 'members', 'roster', 'sheet', 'discord', 'week', 'cron', 'signin']) assert.equal(c[id].status, 'ok', `${id}: ${c[id].detail}`);
  assert.match(c.members.detail, /3 members/);
  assert.match(c.roster.detail, /5 riders/);
  assert.match(c.week.detail, /Closes/);
  assert.equal(c.guests.status, 'info');
  assert.equal(c.staff.status, 'info', 'SESSION_SECRET not set is informational');
});

test('guest sign-ups are shown as blocked once REQUIRE_MEMBER_LOGIN is on', async () => {
  process.env.REQUIRE_MEMBER_LOGIN = '1';
  try { assert.equal((await health()).guests.status, 'ok'); } finally { delete process.env.REQUIRE_MEMBER_LOGIN; }
});

test('problems are flagged with a plain explanation', async () => {
  const keep = { ...process.env };
  delete process.env.CRON_SECRET; delete process.env.DISCORD_WEBHOOK_ADMIN; delete process.env.WP_SSO_SECRET;
  delete process.env.WP_API_USER; delete process.env.MOD_PASSWORD;
  try {
    const c = await health();
    assert.equal(c.cron.status, 'fail');
    assert.match(c.cron.detail, /CRON_SECRET/);
    assert.equal(c.discord.status, 'warn');
    assert.match(c.discord.detail, /Admin channel: NOT set/);
    assert.equal(c.signin.status, 'warn');
    assert.equal(c.members.status, 'warn');
    assert.equal(c.staff.status, 'fail');
    assert.match(c.staff.detail, /MOD_PASSWORD/);
  } finally { Object.assign(process.env, keep); }
});

test('a week with no close time is flagged, because it will not close by itself', async () => {
  const w = JSON.parse(world.db['cg:ttt:week']);
  world.db['cg:ttt:week'] = JSON.stringify({ ...w, closesAt: null });
  const c = await health();
  assert.equal(c.week.status, 'warn');
  assert.match(c.week.detail, /No close time/);
});

test('scheduled runs that stop are noticed', async () => {
  world.db['cg:cron:last'] = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const slow = await health();
  assert.equal(slow.cron.status, 'warn', 'hours apart is a warning (GitHub alone is that slow)');
  assert.match(slow.cron.detail, /QStash/);
  world.db['cg:cron:last'] = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  assert.equal((await health()).cron.status, 'fail', 'a day of silence is a failure');
  world.db['cg:cron:last'] = new Date().toISOString();
  assert.equal((await health()).cron.status, 'ok');
});

test('a broken connection shows as failed instead of breaking the report', async () => {
  const token = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_TOKEN = 'wrong-token';
  try {
    const c = await health();
    assert.equal(c.storage.status, 'fail');
    assert.equal(c.members.status, 'ok', 'the other checks still run');
  } finally { process.env.KV_REST_API_TOKEN = token; }
});

test('a slow Google is a warning after a recent good answer, a failure if there never was one, and a flaky first try recovers', async () => {
  const saved = world.sheet;
  try {
    world.db = world.db || {};
    for (const k of Object.keys(world.db)) if (k === 'cg:health:sheet-ok') delete world.db[k];
    world.sheet.hang = true;
    assert.equal((await health()).sheet.status, 'fail', 'no good answer on record');
    world.sheet.hang = false;
    assert.equal((await health()).sheet.status, 'ok');
    world.sheet.hang = true;
    const slow = (await health()).sheet;
    assert.equal(slow.status, 'warn');
    assert.match(slow.detail, /slow to answer.*last answered/);
    world.sheet.fail = true;   // not a timeout: unreachable stays a failure
    world.sheet.hang = false;
    assert.equal((await health()).sheet.status, 'fail');
  } finally { world.sheet.hang = false; world.sheet.fail = false; }
});

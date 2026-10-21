'use strict';
// The automatic parts: reminder, close, next-week rollover, the cron endpoint, and Discord safety.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const WEEK_KEY = 'cg:ttt:week';
const tick = (secret = 'cron-secret') => app.call('GET', '/api/cron/tick', { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
const week = async () => (await app.get('/api/ttt')).body.week;
const posts = channel => app.world.discord.filter(p => p.channel === channel);

// Starts a week through the API, then edits it to simulate time having passed.
async function seedWeek(date, patch = {}) {
  assert.equal((await app.post('/api/ttt/new-week', { date }, { token: admin })).status, 200);
  const w = JSON.parse(app.world.db[WEEK_KEY]);
  app.world.db[WEEK_KEY] = JSON.stringify({ ...w, ...patch });
  app.world.discord.length = 0;
}

test('the cron endpoint needs the shared secret', async () => {
  assert.equal((await tick(null)).status, 401);
  assert.equal((await tick('wrong')).status, 401);
  const ok = await tick();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ran: [] }, 'no week yet: nothing to do');
  assert.ok(app.world.db['cg:cron:last'], 'the run is recorded for the health panel');
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try { assert.equal((await tick('anything')).status, 503); } finally { process.env.CRON_SECRET = saved; }
});

test('a week closes by itself once its close time has passed, and only once', async () => {
  await seedWeek(h.ymd(2), { closesAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  await app.post('/api/ttt/signup', { name: 'Gary' });
  assert.equal(JSON.parse(app.world.db[WEEK_KEY]).open, true, 'open until the schedule runs (reading the page would run it)');

  assert.deepEqual((await tick()).body.ran, ['close']);
  assert.equal((await week()).open, false);
  assert.ok(posts('public').length >= 1 && posts('admin').length >= 1, 'club and admins are both told');
  assert.match(posts('public')[0].body.content, /closed/i);

  const before = app.world.discord.length;
  assert.deepEqual((await tick()).body.ran, [], 'a second tick does nothing');
  assert.equal(app.world.discord.length, before, 'and posts nothing again');
});

test('riders get a reminder in the 24 hours before sign-ups close, once', async () => {
  await seedWeek(h.ymd(3), { closesAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() });
  assert.deepEqual((await tick()).body.ran, ['reminder']);
  assert.equal(posts('public').length, 1);
  assert.match(posts('public')[0].body.content, /close/i);
  assert.deepEqual((await tick()).body.ran, []);
  assert.equal((await week()).open, true, 'still open until the close time');
});

test('the next week starts after the race: old week archived, new one opened', async () => {
  const old = h.ymd(-3);
  await seedWeek(old);
  await app.post('/api/ttt/signup', { name: 'Gary' });
  const ran = (await tick()).body.ran;
  assert.ok(ran.includes('next-week'), `ran: ${ran}`);
  const w = await week();
  assert.equal(w.date, h.ymd(4), 'a week later');
  assert.equal(w.open, true);
  assert.deepEqual((await app.get('/api/ttt')).body.signups, [], 'new week starts with no sign-ups');
  assert.deepEqual((await app.get('/api/ttt')).body.archive, [old]);
  const snap = (await app.get(`/api/ttt/archive?id=${old}`)).body;
  assert.deepEqual(snap.signups.map(s => s.name), ['Gary'], 'the old sign-ups are kept in the archive');
  assert.ok(posts('public').length >= 1, 'sign-ups-open message');
  assert.deepEqual((await tick()).body.ran, [], 'and it does not roll again');
});

test('opening the TTT page also runs the schedule, so nothing waits on the workflow', async () => {
  await seedWeek(h.ymd(-3));
  const w = await week(); // GET /api/ttt
  assert.equal(w.date, h.ymd(4));
});

test('Discord posts never ping people and rider-entered text is escaped', async () => {
  const [t1] = (await (async () => { await app.post('/api/ttt/new-week', { date: h.ymd(8) }, { token: admin }); return (await app.get('/api/ttt')).body.week.teams.map(t => t.id); })());
  const nasty = '@everyone **bold** _x_';
  await app.post('/api/ttt/signup', { name: nasty, preferred: [t1] });
  await app.post('/api/ttt/assign', { name: nasty, teams: [t1] }, { token: admin });
  await app.post('/api/ttt/status', { published: true }, { token: admin });
  await app.post('/api/ttt/withdraw', { name: nasty });
  assert.ok(app.world.discord.length >= 2, 'posts were made');
  for (const p of app.world.discord) {
    assert.deepEqual(p.body.allowed_mentions, { parse: [] }, 'mentions are switched off');
    assert.ok(!/\*\*bold\*\*/.test(p.body.content || JSON.stringify(p.body)), 'markdown in names is escaped');
  }
});

test('with no webhooks configured the TTT still works', async () => {
  const pub = process.env.DISCORD_WEBHOOK_PUBLIC, adm = process.env.DISCORD_WEBHOOK_ADMIN;
  delete process.env.DISCORD_WEBHOOK_PUBLIC; delete process.env.DISCORD_WEBHOOK_ADMIN;
  try {
    assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(9) }, { token: admin })).status, 200);
    assert.equal((await app.post('/api/ttt/signup', { name: 'Gary' })).status, 200);
    assert.equal((await app.post('/api/ttt/status', { published: true }, { token: admin })).status, 200);
    assert.equal(app.world.discord.length, 0);
  } finally { process.env.DISCORD_WEBHOOK_PUBLIC = pub; process.env.DISCORD_WEBHOOK_ADMIN = adm; }
});

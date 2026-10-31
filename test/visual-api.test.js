'use strict';
// The data behind the visual dashboard: daily trend snapshots, rides per week, the club theme, and the pen view for riders.
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
beforeEach(() => { app.world.discord.length = 0; });
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body);

test('a daily snapshot of the roster feeds the trend chart, once a day, totals only', async () => {
  assert.deepEqual((await app.get('/api/club/trend')).body.velo, []);
  await tick();
  const t = (await app.get('/api/club/trend')).body;
  assert.equal(t.velo.length, 1);
  assert.ok(t.velo[0].avg > 0 && t.riders > 0);
  assert.equal(JSON.stringify(t).includes('Rider Two'), false, 'no names');
  await tick();
  assert.equal((await app.get('/api/club/trend')).body.velo.length, 1, 'once a day');
  assert.equal(t.attendance.length, 8);
});

test('rides per week count the RSVPs of the last eight weeks', async () => {
  const d = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  app.world.db['cg:rides'] = { r1: JSON.stringify({ date: d, title: 'Sunday' }) };
  app.world.db['cg:rsvps'] = { 'r1|ann': '{}', 'r1|bob': '{}' };
  const t = (await app.get('/api/club/trend')).body;
  assert.equal(t.attendance.reduce((n, w) => n + w.rsvps, 0), 2);
});

test('the club theme: anyone can read it, only an admin can set it, and bad values are refused', async () => {
  assert.deepEqual((await app.get('/api/club/theme')).body, { accent: '', welcome: '', logo: '' });
  assert.equal((await app.post('/api/club/theme', { accent: '#ff8800' })).status, 401);
  assert.equal((await app.post('/api/club/theme', { accent: 'red' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/club/theme', { logo: 'http://x.test/a.png' }, { token: admin })).status, 400);
  const ok = await app.post('/api/club/theme', { accent: '#FF8800', welcome: 'Ride <b>fast</b>, be kind', logo: 'https://example.com/logo.png' }, { token: admin });
  assert.deepEqual(ok.body, { accent: '#ff8800', welcome: 'Ride bfast/b, be kind', logo: 'https://example.com/logo.png' });
  assert.equal((await app.get('/api/club/theme')).body.accent, '#ff8800');
});


test('a rider picks one emoji as their avatar; members and staff can read them; anything else is refused', async () => {
  const me = { token: await app.memberSession('1002', { name: 'Rider Two' }) };
  assert.equal((await app.get('/api/avatars')).status, 401);
  assert.equal((await app.post('/api/me/avatar', { emoji: '🦊' })).status, 401);
  for (const bad of ['abc', '🦊🐻', '<b>', '1']) assert.equal((await app.post('/api/me/avatar', { emoji: bad }, me)).status, 400, bad);
  assert.equal((await app.post('/api/me/avatar', { emoji: '🦊' }, me)).body.emoji, '🦊');
  assert.deepEqual((await app.get('/api/avatars', me)).body.avatars, { 1002: '🦊' });
  assert.deepEqual((await app.get('/api/avatars', { token: admin })).body.avatars, { 1002: '🦊' });
  assert.equal((await app.post('/api/me/avatar', { emoji: '' }, me)).body.emoji, '');
  assert.deepEqual((await app.get('/api/avatars', me)).body.avatars, {});
});

test('My week can be widened for the month calendar, but only up to six weeks', async () => {
  const me = { token: await app.memberSession('1002', { name: 'Rider Two' }) };
  assert.equal((await app.get('/api/me/week', me)).body.windowDays, 7);
  assert.equal((await app.get('/api/me/week?days=35', me)).body.windowDays, 35);
  assert.equal((await app.get('/api/me/week?days=900', me)).body.windowDays, 42);
  assert.equal((await app.get('/api/me/week?days=1', me)).body.windowDays, 7);
});

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
  const t0 = (await app.get('/api/club/theme')).body; assert.deepEqual([t0.accent, t0.welcome, t0.logo, t0.seasons], ['', '', '', []]);
  assert.equal((await app.post('/api/club/theme', { accent: '#ff8800' })).status, 401);
  assert.equal((await app.post('/api/club/theme', { accent: 'red' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/club/theme', { logo: 'http://x.test/a.png' }, { token: admin })).status, 400);
  const ok = await app.post('/api/club/theme', { accent: '#FF8800', welcome: 'Ride <b>fast</b>, be kind', logo: 'https://example.com/logo.png' }, { token: admin });
  assert.deepEqual([ok.body.accent, ok.body.welcome, ok.body.logo], ['#ff8800', 'Ride bfast/b, be kind', 'https://example.com/logo.png']);
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

test('a seasonal look takes over the accent and welcome between its dates (even over New Year) and is not the saved base', async () => {
  const A = { token: admin }, mm = (d => d.toISOString().slice(5, 10)), day = 86400000;
  const today = mm(new Date()), yest = mm(new Date(Date.now() - day)), tom = mm(new Date(Date.now() + day));
  await app.post('/api/club/theme', { accent: '#00d4ff', welcome: 'Base welcome', seasons: [
    { label: 'Other', from: mm(new Date(Date.now() + 40 * day)), to: mm(new Date(Date.now() + 45 * day)), accent: '#111111', welcome: 'Not now' },
    { label: 'Now', from: yest, to: tom, accent: '#ff0000', welcome: 'Happy season!' }] }, A);
  const t = (await app.get('/api/club/theme')).body;
  assert.deepEqual([t.active, t.accent, t.welcome], ['Now', '#ff0000', 'Happy season!']);
  assert.deepEqual(t.base, { accent: '#00d4ff', welcome: 'Base welcome' }, 'the saved look is kept for editing');
  // a window that wraps over New Year and contains today
  await app.post('/api/club/theme', { accent: '#00d4ff', seasons: [{ label: 'Wrap', from: today, to: yest, accent: '#00ff00', welcome: '' }] }, A);
  assert.equal((await app.get('/api/club/theme')).body.active, 'Wrap');
  assert.equal((await app.post('/api/club/theme', { seasons: [{ from: '13-40', to: '01-01' }] }, A)).status, 400);
  await app.post('/api/club/theme', { accent: '', seasons: [] }, A);
  assert.equal((await app.get('/api/club/theme')).body.active, '');
});

test('staff see how the workload moved, a rider sees only their own vELO line, and the club wall has the top three of each division', async () => {
  const A = { token: admin };
  await app.post('/api/zrl/round', { name: 'Wall round', start: h.ymd(-14), closes: h.ymd(-20), weeks: 2 }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }, { name: 'CRYO-GEN Beta', region: 'eu', division: 'Division 1' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Rider Two', zwid: '1002', regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'cryo-gen-alpha', pos: 1, pts: 20 }, { team: 'cryo-gen-beta', pos: 2, pts: 15 }] }, A);
  app.world.db['cg:club:trend'] = {}; app.world.db['cg:staff:trend'] = {}; app.world.db['cg:rider:velo'] = {}; delete app.world.db['cg:rides']; delete app.world.db['cg:rsvps'];
  await tick(); await tick();
  const staff = (await app.get('/api/staff/trend', A)).body.days;
  assert.equal(staff.length, 1);
  assert.ok(staff[0].racing >= 1 && staff[0].teams === 2 && typeof staff[0].attention === 'number', JSON.stringify(staff[0]));
  assert.equal((await app.get('/api/staff/trend', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  const me = { token: await app.memberSession('1002', { name: 'Rider Two' }) };
  const mine = (await app.get('/api/me/velo', me)).body.history;
  assert.equal(mine.length, 1); assert.ok(mine[0].v > 0);
  assert.equal((await app.get('/api/me/velo')).status, 401);
  await app.post('/api/public/settings', { on: true }, A);
  const wall2 = (await app.get('/api/public/club')).body;
  assert.ok(wall2.podium && wall2.podium[0].top[0].team === 'Alpha' && wall2.podium[0].top[0].points === 20, JSON.stringify(wall2));
  assert.equal('accent' in wall2, true);
});

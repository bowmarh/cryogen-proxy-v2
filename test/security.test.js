'use strict';
// Pre-season security and robustness checks: password guessing and write floods are limited, ride cover does not hand out other people's
// Zwift IDs, the page escapes names it shows, and the deployment sends basic security headers.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

h.setEnv();
let app, admin, ann, bob;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
  ann = await app.memberSession('4378027', { name: 'Ann Able' }); bob = await app.memberSession('1002', { name: 'Bob Baker' });
});
after(() => { delete process.env.LOGIN_MAX_FAILS; process.env.RATE_LIMIT_WRITES_PER_MIN = '100000'; app.close(); });
beforeEach(() => { app.world.db = {}; process.env.LOGIN_MAX_FAILS = '3'; process.env.RATE_LIMIT_WRITES_PER_MIN = '100000'; });

const login = (password, role = 'admin') => app.post('/api/login', { role, password });

test('after too many wrong passwords from one connection, even the right one is refused until the window passes', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login('nope')).status, 401);
  const locked = await login('nope');
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many wrong passwords/);
  assert.equal((await login('admin-pw')).status, 429, 'the right password does not get past a lock');
  assert.equal((await login('mod-pw', 'mod')).status, 429, 'it is per connection, not per role');
  app.world.db = {};   // the window passing
  assert.equal((await login('admin-pw')).status, 200);
});

test('right passwords never count against the limit', async () => {
  for (let i = 0; i < 6; i++) assert.equal((await login('admin-pw')).status, 200);
});

test('anyone who is not staff is limited to a number of writes a minute; staff are not', async () => {
  process.env.RATE_LIMIT_WRITES_PER_MIN = '3';
  const rsvp = (token, i) => app.post('/api/rsvps', { rideId: 'r1', name: `Guest ${i}` }, { token });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await rsvp(null, i)).status);
  assert.deepEqual(codes.map(c => c === 429), [false, false, false, true, true]);
  assert.match((await rsvp(null, 9)).body.error, /Too many requests/);
  for (let i = 0; i < 6; i++) assert.notEqual((await rsvp(admin, i)).status, 429, 'staff are never limited');
  assert.equal((await app.get('/api/zrl', { token: null })).status, 200, 'reading is not limited');
});

test('ride cover shows names, not other people\'s Zwift IDs or the owner\'s ID, to riders; staff still see them', async () => {
  const dow = new Date(Date.now() + 2 * 86400000).getUTCDay();
  const s = (await app.post('/api/cover/series', { title: 'Privacy Spin', dow, time: '19:00', zone: 'Europe/London', ownerName: 'Olive', ownerZwid: '2436518' }, { token: admin })).body.series[0];
  await app.post('/api/cover/approve', { zwid: '4378027', name: 'Ann Able', lead: true, sweep: true }, { token: admin });
  await app.post('/api/cover/volunteer', { series: s.id, date: s.occurrences[0].date, role: 'leader' }, { token: ann });
  const asBob = (await app.get('/api/cover', { token: bob })).body;
  const slot = asBob.series[0].occurrences[0].cover.leader;
  assert.equal(slot.name, 'Ann Able');
  assert.equal(slot.zwid, undefined, 'another rider\'s ID is not sent');
  assert.equal(slot.mine, false);
  assert.equal(asBob.series[0].ownerZwid, undefined);
  const asAnn = (await app.get('/api/cover', { token: ann })).body.series[0].occurrences[0].cover.leader;
  assert.equal(asAnn.mine, true);
  assert.equal(asAnn.zwid, undefined, 'a rider does not need their own ID echoed back either');
  const asStaff = (await app.get('/api/cover', { token: admin })).body.series[0];
  assert.equal(asStaff.occurrences[0].cover.leader.zwid, '4378027');
  assert.equal(asStaff.ownerZwid, '2436518');
  const owner = await app.memberSession('2436518', { name: 'Olive Owner' });
  assert.equal((await app.get('/api/cover', { token: owner })).body.series[0].canManage, true, 'the owner can still manage their ride');
});

test('the page escapes the names it shows (a member name with HTML in it must not run)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const raw = [...html.matchAll(/\$\{\s*(?:r|m|s|t|rider|ride|slot|e)\.(?:name|title|ownerName)\s*\}/g)].map(m => m[0]);
  // Allowed only where the surrounding code is not HTML (confirm() text, textContent). Everything in a template that becomes markup goes through esc().
  const lines = html.split('\n').filter(l => /\$\{\s*(?:r|m|s|t|rider|ride|slot|e)\.(?:name|title|ownerName)\s*\}/.test(l));
  const markup = lines.filter(l => !/textContent|confirm\(|alert\(|\.value=|prompt\(/.test(l));
  assert.deepEqual(markup.map(l => l.trim().slice(0, 90)), [], `unescaped names in markup (${raw.length} found)`);
});

test('the deployment sends basic security headers and allows scheduled work to finish', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const all = Object.fromEntries(config.headers.find(x => x.source === '/(.*)').headers.map(x => [x.key, x.value]));
  assert.equal(all['X-Content-Type-Options'], 'nosniff');
  assert.match(all['Referrer-Policy'], /strict-origin/);
  assert.match(all['Permissions-Policy'], /camera=\(\)/);
  assert.equal(config.headers.find(x => x.source === '/sw.js').headers[0].value, 'no-cache');
  assert.equal(config.functions['api/server.js'].maxDuration, 60);
});

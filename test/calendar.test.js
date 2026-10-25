'use strict';
// A rider's private calendar feed (.ics): the link holds a secret, the feed shows their own next four weeks, and it can be reset or switched off.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const rider = () => app.memberSession('1002', { name: 'Rider Two' });
const mine = t => app.get('/api/me/calendar', { token: t });
const secretOf = url => /\/api\/cal\/([^/]+)\.ics$/.exec(url)[1];

test('the link needs a member sign-in; creating it twice gives the same link, resetting gives a new one', async () => {
  assert.equal((await mine(null)).status, 401);
  assert.equal((await mine(admin)).status, 401, 'staff passwords are not a rider');
  const t = await rider();
  assert.deepEqual((await mine(t)).body, { on: false, url: null, windowDays: 28 });
  const a = (await app.post('/api/me/calendar', {}, { token: t })).body;
  assert.equal(a.on, true);
  assert.match(a.url, /\/api\/cal\/[A-Za-z0-9_-]{30,}\.ics$/);
  assert.equal((await app.post('/api/me/calendar', {}, { token: t })).body.url, a.url, 'idempotent');
  assert.equal((await mine(t)).body.url, a.url);
  const b = (await app.post('/api/me/calendar', { reset: true }, { token: t })).body;
  assert.notEqual(b.url, a.url);
  assert.equal((await app.get(`/api/cal/${secretOf(a.url)}.ics`)).status, 404, 'the old link stops working');
  assert.equal((await app.get(`/api/cal/${secretOf(b.url)}.ics`)).status, 200);
});

test('the feed is a calendar with the rider\'s own events, to-do items marked, and no sign-in needed', async () => {
  const t = await rider();
  await app.post('/api/ttt/new-week', { date: h.ymd(3) }, { token: admin });
  await app.post('/api/rides', { title: 'Sunday, spin; with commas', date: h.ymd(5), time: '09:30' }, { token: admin });
  const url = (await app.post('/api/me/calendar', {}, { token: t })).body.url;
  assert.doesNotMatch((await app.get(new URL(url).pathname)).body, /Sunday/, 'a ride you have not said yes to is not in your calendar');
  await app.post('/api/rsvps', { rideId: Object.keys(app.world.db['cg:rides'])[0] }, { token: t });
  const r = await app.get(new URL(url).pathname);
  assert.equal(r.status, 200);
  assert.match(r.body, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(r.body, /END:VCALENDAR\r\n$/);
  assert.match(r.body, /SUMMARY:❓ TTT: /, 'sign-up still open');
  assert.match(r.body, /DTSTART:\d{8}T093000Z/, 'a timed ride');
  assert.match(r.body, /Sunday\\, spin\\; with commas/, 'text is escaped');
  assert.ok(r.body.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines are folded');
  assert.doesNotMatch(r.body, /Rider Three/, 'only this rider');
  // answering moves the event out of the to-do state
  await app.post('/api/ttt/signup', { cat: 'B', available: true }, { token: t });
  assert.doesNotMatch((await app.get(new URL(url).pathname)).body, /SUMMARY:❓ TTT/);
});

test('an unknown or malformed secret is a plain 404, and switching off removes the feed', async () => {
  assert.equal((await app.get('/api/cal/short.ics')).status, 404);
  assert.equal((await app.get(`/api/cal/${'a'.repeat(32)}.ics`)).status, 404);
  const t = await rider();
  const url = (await app.post('/api/me/calendar', {}, { token: t })).body.url;
  assert.equal((await app.post('/api/me/calendar/remove', {}, { token: t })).body.removed, true);
  assert.equal((await app.get(new URL(url).pathname)).status, 404);
  assert.equal((await mine(t)).body.on, false);
});

test('an associate gets a feed too, with the part they can use', async () => {
  const t = await app.memberSession('5551', { name: 'Newbie Nora', associate: true });
  await app.post('/api/rides', { title: 'Easy spin', date: h.ymd(2) }, { token: admin });
  await app.post('/api/rsvps', { rideId: Object.keys(app.world.db['cg:rides'])[0] }, { token: t });
  const url = (await app.post('/api/me/calendar', {}, { token: t })).body.url;
  const r = await app.get(new URL(url).pathname);
  assert.equal(r.status, 200);
  assert.match(r.body, /Easy spin/);
});

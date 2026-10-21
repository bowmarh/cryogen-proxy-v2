'use strict';
// Who a sign-up, withdrawal or RSVP is for: signed-in members always act as themselves;
// guests (name-picker) and staff name the rider, until REQUIRE_MEMBER_LOGIN=1 stops guests.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, rider2;
before(async () => {
  app = await h.startApp(h.createWorld());
  admin = await app.login('admin');
  rider2 = await app.memberSession('1002'); // roster name "Rider 2"
});
after(() => app.close());
beforeEach(async () => {
  delete process.env.REQUIRE_MEMBER_LOGIN;
  app.world.db = {};
  assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(10) }, { token: admin })).status, 200);
});

const tttSignups = async () => (await app.get('/api/ttt', { token: admin })).body.signups;

test('a member signing up for the TTT is recorded as themselves, whatever the request says', async () => {
  const r = await app.post('/api/ttt/signup', { name: 'Victim Person', zwid: '999', cat: 'B' }, { token: rider2 });
  assert.equal(r.status, 200);
  const list = await tttSignups();
  assert.deepEqual(list.map(s => [s.name, s.zwid]), [['Rider 2', '1002']]);
});

test('a member can only withdraw themselves', async () => {
  await app.post('/api/ttt/signup', { name: 'Guest Gary' });
  await app.post('/api/ttt/signup', {}, { token: rider2 });
  await app.post('/api/ttt/withdraw', { name: 'Guest Gary' }, { token: rider2 });
  assert.deepEqual((await tttSignups()).map(s => s.name), ['Guest Gary'], 'Rider 2 went, Guest Gary stayed');
});

test('a member signing up for a race series or RSVPing is recorded as themselves', async () => {
  assert.equal((await app.post('/api/signups', { series: 'ladder', name: 'Someone Else', zwid: '5', cat: 'A' }, { token: rider2 })).status, 200);
  assert.equal((await app.post('/api/rsvps', { rideId: 'ride1', name: 'Someone Else' }, { token: rider2 })).status, 200);
  const state = (await app.get('/api/state')).body;
  assert.deepEqual(state.signups.ladder.map(s => [s.name, s.zwid]), [['Rider 2', '1002']]);
  assert.deepEqual(state.rsvps.ride1.map(s => s.name), ['Rider 2']);
  // cancelling "Someone Else" does nothing to others; cancelling as the member removes their own RSVP
  await app.post('/api/rsvps', { rideId: 'ride1', name: 'Guest Gary' });
  await app.post('/api/rsvps/cancel', { rideId: 'ride1', name: 'Guest Gary' }, { token: rider2 });
  assert.deepEqual((await app.get('/api/state')).body.rsvps.ride1.map(s => s.name), ['Guest Gary']);
});

test('guests can still sign up as anyone by default (rollout period)', async () => {
  assert.equal((await app.post('/api/ttt/signup', { name: 'Guest Gary', zwid: '77' })).status, 200);
  assert.equal((await app.post('/api/rsvps', { rideId: 'ride1', name: 'Guest Gary' })).status, 200);
  assert.equal((await app.post('/api/signups', { series: 'zrl', name: 'Guest Gary' })).status, 200);
});

test('REQUIRE_MEMBER_LOGIN=1 stops guests but not members or staff', async () => {
  process.env.REQUIRE_MEMBER_LOGIN = '1';
  const guest = await app.post('/api/ttt/signup', { name: 'Guest Gary' });
  assert.equal(guest.status, 401);
  assert.match(guest.body.error, /sign in/i);
  assert.equal((await app.post('/api/ttt/withdraw', { name: 'Guest Gary' })).status, 401);
  assert.equal((await app.post('/api/rsvps', { rideId: 'r', name: 'G' })).status, 401);
  assert.equal((await app.post('/api/rsvps/cancel', { rideId: 'r', name: 'G' })).status, 401);
  assert.equal((await app.post('/api/signups', { series: 'ladder', name: 'G' })).status, 401);
  assert.equal((await app.get('/api/auth/status')).body.requireLogin, true);

  assert.equal((await app.post('/api/ttt/signup', {}, { token: rider2 })).status, 200, 'members still can');
  assert.equal((await app.post('/api/ttt/signup', { name: 'Added By Staff' }, { token: admin })).status, 200, 'staff can still act for others');
  assert.deepEqual((await tttSignups()).map(s => s.name).sort(), ['Added By Staff', 'Rider 2']);
});

test('input is validated: a name is required for guests and is length-limited', async () => {
  assert.equal((await app.post('/api/ttt/signup', {})).status, 400);
  assert.equal((await app.post('/api/ttt/signup', { name: 'x'.repeat(61) })).status, 400);
  assert.equal((await app.post('/api/signups', { series: 'nope', name: 'G' })).status, 400, 'unknown series');
  assert.equal((await app.post('/api/rsvps', { rideId: 'bad id!', name: 'G' })).status, 400, 'bad ride id');
});

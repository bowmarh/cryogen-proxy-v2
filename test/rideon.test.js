'use strict';
// 💪 Ride On for social rides: members cheer the riders they shared a ride with. Rules, privacy and the routes.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const rideon = require('../lib/rideon');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const ride = (extra = {}) => ({ id: '100', title: 'Sunday social', date: '2026-11-04', max: 3, ...extra });
const rsvp = (...names) => names.map((name, i) => ({ name, ts: `2026-11-01T10:0${i}:00.000Z` }));

test('rules: only riders who were really going can cheer, only each other, only from the ride day to 30 days after, at most 10 per ride', () => {
  const base = { ride: ride(), list: rsvp('Ann', 'Bo', 'Cy', 'Di'), giverName: 'Ann', toName: 'Bo', today: '2026-11-04', given: 0 };   // max 3: Di is waitlisted
  assert.equal(rideon.check(base), null, 'going cheers going, on the day');
  assert.equal(rideon.check({ ...base, giverName: '  ann ', toName: 'BO' }), null, 'case and spacing do not matter');
  assert.equal(rideon.check({ ...base, giverName: 'Di' }).status, 403, 'a waitlisted rider did not ride, so cannot cheer');
  assert.equal(rideon.check({ ...base, toName: 'Di' }).status, 400, 'and cannot be cheered');
  assert.equal(rideon.check({ ...base, giverName: 'Zed' }).status, 403, 'not on the ride at all');
  assert.match(rideon.check({ ...base, toName: 'ann' }).message, /fellow riders/, 'never yourself');
  assert.match(rideon.check({ ...base, today: '2026-11-03' }).message, /open once the ride/, 'not before the ride');
  assert.equal(rideon.check({ ...base, today: '2026-12-04' }), null, 'exactly 30 days after is still open');
  assert.match(rideon.check({ ...base, today: '2026-12-05' }).message, /close 30 days/, '31 days after is closed');
  assert.equal(rideon.check({ ...base, given: 9 }), null);
  assert.equal(rideon.check({ ...base, given: 10 }).status, 429, 'ten per ride');
  assert.equal(rideon.inWindow('2026-11-04', '2026-11-04'), true);
  assert.equal(rideon.inWindow('2026-11-05', '2026-11-04'), false);
  assert.equal(rideon.inWindow('', '2026-11-04'), false);
});

function build(state) {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const r = rideon({ redis, HttpError, memberFromRequest: req => req.member, loadState: async () => state });
  const as = (zwid, name) => ({ member: zwid ? { zwid, name } : null });
  return { db, r, get: m => r.routes['GET /api/rides/rideon'](m), post: (m, body) => r.routes['POST /api/rides/rideon'](m, body) };
}
const today = new Date().toISOString().slice(0, 10);

test('routes: cheer once, a second member adds to it, a second tap takes it back, and the list shows only counts and your own ticks', async () => {
  const state = { rides: [ride({ date: today })], rsvps: { 100: rsvp('Ann', 'Bo', 'Cy', 'Di') } };
  const t = build(state), ann = { member: { zwid: '90001', name: 'Ann' } }, cy = { member: { zwid: '90003', name: 'Cy' } }, bo = { member: { zwid: '90002', name: 'Bo' } };
  assert.deepEqual(await t.post(ann, { rideId: '100', name: 'Bo' }), { n: 1, mine: true });
  assert.deepEqual(await t.post(cy, { rideId: '100', name: 'Bo' }), { n: 2, mine: true });
  assert.deepEqual(await t.post(ann, { rideId: '100', name: 'bo' }), { n: 1, mine: false }, 'a second tap takes it back, whatever the case');
  const view = await t.get(ann);
  assert.deepEqual(view.rides['100'].riders.map(x => x.name), ['Bo', 'Cy'], 'your own name and the waitlisted rider are not offered');
  assert.deepEqual(view.rides['100'].riders.find(x => x.name === 'Bo'), { name: 'Bo', n: 1, mine: false });
  assert.equal(JSON.stringify(view).includes('9000'), false, 'no Zwift ID ever reaches the browser');
  assert.equal((await t.get(bo)).received, 1, 'Bo sees the Ride On they received');
  assert.equal((await t.get(ann)).received, 0);
  assert.deepEqual(await t.post(cy, { rideId: '100', name: 'Bo' }), { n: 0, mine: false }, 'the last Ride On taken back');
  assert.equal(Object.keys(t.db['cg:rideon'] || {}).includes('100|bo'), false, 'an emptied list is removed, not kept as []');
});

test('routes: signed in only, real rides and riders only, ten per ride, and taking one back always works', async () => {
  const names = ['Ann', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11'];
  const t = build({ rides: [ride({ date: today, max: 50 }), ride({ id: '101', date: '2099-01-01' }), ride({ id: '102', date: '2020-01-01' })], rsvps: { 100: rsvp(...names), 101: rsvp('Ann', 'Bo'), 102: rsvp('Ann', 'Bo') } });
  const ann = { member: { zwid: '90001', name: 'Ann' } };
  await assert.rejects(() => t.post({ member: null }, { rideId: '100', name: 'B1' }), /Sign in/);
  await assert.rejects(() => t.get({ member: null }), /Sign in/);
  await assert.rejects(() => t.post(ann, { rideId: '999', name: 'B1' }), /not found/);
  await assert.rejects(() => t.post(ann, { rideId: '100', name: '' }), /Pick a rider/);
  await assert.rejects(() => t.post(ann, { rideId: '../x', name: 'B1' }), /Pick a rider/);
  await assert.rejects(() => t.post(ann, { rideId: '100', name: 'Nobody' }), /not on this ride/);
  await assert.rejects(() => t.post(ann, { rideId: '101', name: 'Bo' }), /open once the ride/, 'a future ride');
  await assert.rejects(() => t.post(ann, { rideId: '102', name: 'Bo' }), /close 30 days/, 'an old ride');
  for (const n of names.slice(1, 11)) await t.post(ann, { rideId: '100', name: n });   // ten
  await assert.rejects(() => t.post(ann, { rideId: '100', name: 'B11' }), /all 10/);
  assert.deepEqual(await t.post(ann, { rideId: '100', name: 'B1' }), { n: 0, mine: false }, 'taking one back is allowed even at the limit');
  assert.deepEqual(await t.post(ann, { rideId: '100', name: 'B11' }), { n: 1, mine: true }, 'which frees a place');
  const view = await t.get(ann);
  assert.deepEqual(Object.keys(view.rides), ['100'], 'only rides in the 30-day window that you rode are listed');
});

test('through the app: members cheer each other, associate members can use it, guests and staff cannot, and public state carries no Ride On data', async () => {
  const app = await h.startApp(h.createWorld());
  try {
    const admin = await app.login('admin');
    await app.post('/api/rides', { title: 'Ride On test', date: h.ymd(0), time: '07:00', max: 5 }, { token: admin });
    const rideId = (await app.get('/api/state')).body.rides.find(r => r.title === 'Ride On test').id;
    const a = await app.memberSession('1002', { name: 'Ann Rider' }), b = await app.memberSession('1003', { name: 'Bo Rider' });
    await app.post('/api/rsvps', { rideId }, { token: a }); await new Promise(r => setTimeout(r, 4)); await app.post('/api/rsvps', { rideId }, { token: b });
    // A signed-in member RSVPs under the name the club has for them, so read the recorded names rather than assume them
    const [annName, boName] = (await app.get('/api/state')).body.rsvps[rideId].map(x => x.name);
    assert.notEqual(annName, boName);
    const view = (await app.get('/api/rides/rideon', { token: a })).body;
    assert.deepEqual(view.rides[rideId].riders, [{ name: boName, n: 0, mine: false }]);
    const give = await app.post('/api/rides/rideon', { rideId, name: boName }, { token: a });
    assert.equal(give.status, 200); assert.deepEqual(give.body, { n: 1, mine: true });
    assert.equal((await app.get('/api/rides/rideon', { token: b })).body.received, 1);
    assert.equal((await app.get('/api/rides/rideon')).status, 401, 'guests are turned away');
    assert.equal((await app.get('/api/rides/rideon', { token: admin })).status, 401, 'staff have no rider identity, so no Ride Ons');
    assert.equal((await app.post('/api/rides/rideon', { rideId, name: annName }, { token: a })).status, 400, 'never yourself');
    // Associate (Social) members RSVP to social rides too, so they may give and see Ride Ons
    const assoc = await app.memberSession('99999', { name: 'Newbie Rider', associate: true });
    assert.equal((await app.get('/api/coach/status', { token: assoc })).status, 403, 'control: this associate really is held to the associate pages');
    assert.equal((await app.get('/api/rides/rideon', { token: assoc })).status, 200, 'but may open Ride On, like the social-ride RSVPs');
    // The public state never carries Ride On data
    assert.equal(JSON.stringify((await app.get('/api/state')).body).includes('rideon'), false);
  } finally { await app.close(); }
});

'use strict';
// Social rides extras taken from the ZRL: a once-only reminder for rides happening soon, and an RSVP export for staff.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const posts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
let seq = 0;
async function ride(extra) {
  await new Promise(r => setTimeout(r, 2));   // ride ids are millisecond timestamps
  await app.post('/api/rides', { title: `Ride ${++seq}`, date: h.ymd(1), time: '09:00', max: 5, ...extra }, { token: admin });
  const state = (await app.get('/api/state')).body;
  return state.rides.find(r => r.title === `Ride ${seq}`);
}

test('a ride today or tomorrow is announced once, with how many are riding and how many places are left; others are not', async () => {
  const soon = await ride({ route: 'Watopia loop', pace: '2.5 w/kg', link: 'https://www.zwift.com/events/view/1' });
  await ride({ date: h.ymd(5), title: 'Far away' });
  await app.post('/api/rsvps', { rideId: soon.id, name: 'Guest Gary' }); await app.post('/api/rsvps', { rideId: soon.id, name: 'Guest Gail' });
  app.world.discord.length = 0;
  assert.deepEqual(await tick(), ['ride-reminder']);
  const text = posts()[0];
  assert.match(text, /\*\*Ride 1\*\* is tomorrow at 09:00\./);
  assert.match(text, /Watopia loop/); assert.match(text, /2 riding, 3 places left/);
  assert.match(text, /Zwift event: <https:\/\/www\.zwift\.com\/events\/view\/1>/);
  assert.deepEqual(await tick(), [], 'once');
  await ride({ date: h.ymd(0), title: 'Today ride' });
  app.world.discord.length = 0;
  assert.deepEqual(await tick(), ['ride-reminder']);
  assert.match(posts()[0], /is today/);
  assert.ok(!posts().some(p => /Far away/.test(p)));
});

test('the RSVP export is staff only, covers upcoming rides or one ride, and neutralises formulas', async () => {
  const r1 = await ride({}); const r2 = await ride({ date: h.ymd(3) });
  const exp = (q = '', token = admin) => app.get(`/api/rides/export${q}`, { token });
  assert.equal((await exp('', null)).status, 401);
  assert.equal((await exp()).status, 409, 'nobody yet');
  await app.post('/api/rsvps', { rideId: r1.id, name: '=HYPERLINK("x")' }); await app.post('/api/rsvps', { rideId: r2.id, name: 'Guest Gary' });
  const all = (await exp()).body;
  assert.match(all.filename, /^rsvps-upcoming-/);
  assert.match(all.csv, /^Ride,Date,Time,Rider,RSVP made/);
  assert.match(all.csv, /Ride \d+,[^\n]*,"?'=HYPERLINK/); assert.match(all.csv, /Guest Gary/);
  const one = (await exp(`?id=${r2.id}`)).body;
  assert.ok(/Guest Gary/.test(one.csv) && !/HYPERLINK/.test(one.csv), 'one ride only');
  assert.equal((await exp('?id=nope')).status, 404);
});

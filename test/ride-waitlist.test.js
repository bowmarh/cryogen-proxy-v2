'use strict';
// Social-ride waitlist: the first `max` RSVPs go, later ones wait their turn, and a cancellation moves the first waiting rider up.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ridecap = require('../lib/ridecap');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const posts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
let seq = 0;
async function ride(extra) {
  await sleep(2);   // ride ids are millisecond timestamps
  await app.post('/api/rides', { title: `Waitlist ride ${++seq}`, date: h.ymd(1), time: '09:00', max: 2, ...extra }, { token: admin });
  return (await app.get('/api/state')).body.rides.find(r => r.title === `Waitlist ride ${seq}`);
}
async function join(rideId, ...names) { for (const name of names) { await sleep(3); await app.post('/api/rsvps', { rideId, name }); } }

test('lib/ridecap: the first max are going, the rest wait; nothing is stored beyond the RSVPs themselves', () => {
  const list = ['A', 'B', 'C', 'D'].map(name => ({ name }));
  assert.deepEqual(ridecap.split(list, 2).going.map(x => x.name), ['A', 'B']);
  assert.deepEqual(ridecap.split(list, 2).waitlist.map(x => x.name), ['C', 'D']);
  assert.deepEqual(ridecap.split(undefined, 2), { going: [], waitlist: [] });
  assert.equal(ridecap.maxOf({ max: '3' }), 3);
  assert.equal(ridecap.maxOf({}), 25, 'a ride with no max holds 25, as the browser assumes');
  assert.equal(ridecap.waitlistPlace(list, 'd', 2), 2, 'case-insensitive, 1-based');
  assert.equal(ridecap.waitlistPlace(list, 'A', 2), 0, 'going riders have no waitlist place');
  assert.equal(ridecap.waitlistPlace(list, 'Zed', 2), 0, 'not signed up');
});

test('lib/ridecap: who moves up when someone cancels', () => {
  const list = ['A', 'B', 'C', 'D'].map(name => ({ name }));
  assert.equal(ridecap.promotedOnCancel(list, 'A', 2).name, 'C', 'a going rider cancels: the first waiting rider moves in');
  assert.equal(ridecap.promotedOnCancel(list, 'b', 2).name, 'C', 'case-insensitive');
  assert.equal(ridecap.promotedOnCancel(list, 'D', 2), null, 'a waitlisted rider cancels: nobody moves');
  assert.equal(ridecap.promotedOnCancel(list.slice(0, 2), 'A', 2), null, 'nobody is waiting');
  assert.equal(ridecap.promotedOnCancel(list, 'Zed', 2), null, 'unknown rider');
});

test('lib/ridecap: only riders who are really going count towards activity (waitlist places and missing rides)', () => {
  const entry = (rideId, name, ts) => [`${rideId}|${name.toLowerCase()}`, JSON.stringify({ name, ts })];
  const pairs = [entry('1', 'Ann', '2026-01-01T10:00:00Z'), entry('1', 'Bo', '2026-01-01T10:01:00Z'), entry('1', 'Cy', '2026-01-01T10:02:00Z'), entry('9', 'Cy', '2026-01-01T10:03:00Z'), ['bad|field', '{not json']];
  const got = ridecap.goingEntries(pairs, new Map([['1', { id: '1', max: 2 }]]));
  assert.deepEqual(got.map(e => `${e.rideId}:${e.name}`).sort(), ['1:ann', '1:bo', '9:cy'], 'Cy is waitlisted on ride 1; ride 9 no longer exists so its RSVP counts; junk is skipped');
});

test('a full ride keeps taking RSVPs, in order, and the state lets the browser split going from waiting', async () => {
  const r = await ride({});
  await join(r.id, 'Ann', 'Bo', 'Cy', 'Di');
  const state = (await app.get('/api/state')).body;
  assert.deepEqual(state.rsvps[r.id].map(x => x.name), ['Ann', 'Bo', 'Cy', 'Di'], 'oldest first, nobody turned away');
  assert.equal((await app.post('/api/rsvps', { rideId: r.id, name: 'Ann' })).status, 409, 'still one RSVP per rider');
});

test('when a going rider cancels a full ride, the first waiting rider moves up and the club channel says so', async () => {
  const r = await ride({ time: '07:30' });
  await join(r.id, 'Ann', 'Bo', 'Cy', 'Di');
  app.world.discord.length = 0;
  await app.post('/api/rsvps/cancel', { rideId: r.id, name: 'Ann' });
  const said = posts();
  assert.equal(said.length, 1);
  assert.match(said[0], /\*\*Cy\*\* moves up from the waitlist/);
  assert.match(said[0], /Waitlist ride \d+/);
  assert.match(said[0], /at 07:30/);
  app.world.discord.length = 0;
  await app.post('/api/rsvps/cancel', { rideId: r.id, name: 'Di' });   // Di was still waiting: nobody moves
  assert.deepEqual(posts(), []);
  await app.post('/api/rsvps/cancel', { rideId: r.id, name: 'Bo' });   // nobody is waiting any more
  assert.deepEqual(posts(), []);
  const left = (await app.get('/api/state')).body.rsvps[r.id].map(x => x.name);
  assert.deepEqual(left, ['Cy']);
});

test('a waitlisted rider whose name contains Discord markup cannot break out of the announcement formatting', async () => {
  const r = await ride({});
  await join(r.id, 'Ann', 'Bo', '**Cy** [x](http://evil.example)');
  app.world.discord.length = 0;
  await app.post('/api/rsvps/cancel', { rideId: r.id, name: 'Ann' });
  assert.match(posts()[0], /moves up from the waitlist/);
  assert.match(posts()[0], /\\\*\\\*Cy\\\*\\\*/, 'asterisks are escaped, so the name stays inside the bold');
});

test('the ride reminder says how many are waiting, and the staff export marks who is going and who is waiting', async () => {
  const r = await ride({});
  await join(r.id, 'Ann', 'Bo', 'Cy', 'Di');
  app.world.discord.length = 0;
  assert.deepEqual(await tick(), ['ride-reminder']);
  assert.match(posts()[0], /2 riding, 0 places left \(2 on the waitlist\)/);
  const csv = (await app.get('/api/rides/export', { token: admin })).body.csv;
  assert.match(csv, /^Ride,Date,Time,Rider,RSVP made,Status/);
  assert.match(csv, /Ann,[^\n]*,Going/); assert.match(csv, /Bo,[^\n]*,Going/);
  assert.match(csv, /Cy,[^\n]*,Waitlist #1/); assert.match(csv, /Di,[^\n]*,Waitlist #2/);
});

test('a ride that is not full has no waitlist wording anywhere', async () => {
  const r = await ride({ max: 5 });
  await join(r.id, 'Ann', 'Bo');
  app.world.discord.length = 0;
  await tick();
  assert.match(posts()[0], /2 riding, 3 places left\. RSVP:/);
  assert.doesNotMatch(posts()[0], /waitlist/);
  app.world.discord.length = 0;
  await app.post('/api/rsvps/cancel', { rideId: r.id, name: 'Ann' });
  assert.deepEqual(posts(), [], 'nobody to move up');
});

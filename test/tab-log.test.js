'use strict';
// The change log also covers what staff do on the TTT Week and Social Rides tabs, and leaves riders' own sign-ups out of it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => { const world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const log = () => app.get('/api/zrl/log', { token: admin }).then(r => r.body.entries);

test('staff changes on the TTT Week tab are logged; riders signing up and withdrawing are not', async () => {
  await app.post('/api/ttt/new-week', { date: h.ymd(9) }, { token: admin });
  await app.post('/api/ttt/signup', { name: 'Guest Gary', preferred: [], style: 'race' });
  await app.post('/api/ttt/status', { published: true }, { token: mod });
  await app.post('/api/ttt/withdraw', { name: 'Guest Gary' });
  const routes = (await log()).map(e => [e.route, e.role]);
  assert.deepEqual(routes, [['ttt/status', 'mod'], ['ttt/new-week', 'admin']]);
  assert.match((await log())[0].what, /published=true/);
});

test('staff changes to rides are logged with the title; RSVPs and sign-ups by riders are not; secrets never are', async () => {
  await app.post('/api/rides', { title: 'Sunday Social', date: h.ymd(5), password: 'hunter2' }, { token: admin });
  await app.post('/api/rsvps', { rideId: 'x', name: 'Guest Gary' });
  await app.post('/api/signups', { name: 'Guest Gary', eventId: 'e' });
  const e = await log();
  assert.deepEqual(e.map(x => x.route), ['rides']);
  assert.match(e[0].what, /title=Sunday Social/); assert.ok(!/hunter2/.test(JSON.stringify(e)));
});

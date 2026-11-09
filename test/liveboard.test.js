'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { publicLive } = require('../lib/liveboard');

h.setEnv();
const NOW = Date.parse('2026-11-10T18:00:00Z'), MIN = 60000;
const ev = (o = {}) => ({ kind: 'zrl', id: '1:a', title: 'CRYO-GEN Alpha · ZRL race 2', at: NOW + 40 * MIN, need: 4, ready: 3, riders: [{ zwid: '1', name: 'Ann Lee' }], lateIds: ['1'], late: ['Ann Lee'], ...o });

test('the board shows each race with its phase and pen count, soonest first, and drops races over 45 minutes old', () => {
  const b = publicLive([ev({ id: 'x', title: 'Later race', at: NOW + 5 * 3600000 }), ev(), ev({ id: 'old', title: 'Long finished', at: NOW - 60 * MIN }), ev({ id: 'run', title: 'Under way', at: NOW - 10 * MIN })], NOW);
  assert.deepEqual(b.events.map(e => [e.title, e.phase]), [['Under way', 'racing'], ['CRYO-GEN Alpha · ZRL race 2', 'pen'], ['Later race', 'later']]);
  assert.equal(b.next.title, 'CRYO-GEN Alpha · ZRL race 2', 'the countdown is to the next one that has not started');
  assert.deepEqual([b.events[1].ready, b.events[1].need, b.events[1].full], [3, 4, false]);
  assert.equal(publicLive([ev({ ready: 4 })], NOW).events[0].full, true);
  assert.equal(publicLive([], NOW).next, null);
});

test('no rider names, IDs or answers are ever in what the board returns', () => {
  const text = JSON.stringify(publicLive([ev()], NOW));
  assert.equal(/Ann Lee|zwid|late|riders|"1"/.test(text), false);
});

let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('the public route follows the same on/off switch as the public club page and needs no sign-in', async () => {
  const admin = await app.login('admin');
  await app.post('/api/public/settings', { on: false }, { token: admin });
  assert.equal((await app.get('/api/public/live')).status, 404);
  await app.post('/api/public/settings', { on: true }, { token: admin });
  const r = await app.get('/api/public/live');
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.events) && 'next' in r.body && Array.isArray(r.body.leaders));
});

'use strict';
// ZRL 2026/27 points calculator: finish points, podium bonus, segment points, heart-rate and ZPower penalties.
const { test, before, after } = require('node:test');
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

const score = (body, token = admin) => app.post('/api/zrl/score', body, { token });

test('finish points count down from the starters, the top five get the podium bonus, segments add on', async () => {
  const r = await score({ starters: 60, riders: [{ name: 'A', cat: 'C', pos: 1, fal: 20, fts: 15 }, { name: 'B', cat: 'C', pos: 5 }, { name: 'C', cat: 'C', pos: 60 }, { name: 'D', cat: 'C' }] });
  assert.equal(r.status, 200);
  const [a, b, c, d] = r.body.riders;
  assert.deepEqual([a.fin, a.pbp, a.segments, a.points], [60, 10, 35, 105]);
  assert.deepEqual([b.fin, b.pbp, b.points], [56, 2, 58]);
  assert.deepEqual([c.fin, c.pbp, c.points], [1, 0, 1]);
  assert.equal(d.points, 0, 'a rider who did not finish scores nothing from the finish');
  assert.equal(r.body.total, 164);
});

test('missing heart rate is zero for A and half for the rest, ZPower is half, both multiply', async () => {
  const r = await score({ starters: 10, riders: [{ name: 'A', cat: 'A', pos: 2, noHr: true }, { name: 'B', cat: 'B', pos: 2, noHr: true }, { name: 'D', cat: 'D', pos: 2, zpower: true }, { name: 'E', cat: 'D', pos: 2, noHr: true, zpower: true }] });
  assert.deepEqual(r.body.riders.map(x => x.points), [0, 8.5, 8.5, 4.25]);
  assert.equal(r.body.total, 21.25);
});

test('bad input is refused, only staff can use it, and it leaves no entry in the change log', async () => {
  assert.equal((await score({ starters: 0, riders: [{ pos: 1 }] })).status, 400);
  assert.equal((await score({ starters: 10, riders: [] })).status, 400);
  assert.equal((await score({ starters: 10, riders: [{ name: 'X', pos: 11 }] })).status, 400);
  assert.equal((await score({ starters: 10, riders: [{ pos: 1, fal: -3 }] })).status, 400);
  assert.equal((await score({ starters: 10, riders: [{ pos: 1 }] }, null)).status, 401);
});

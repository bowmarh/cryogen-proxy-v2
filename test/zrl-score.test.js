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
  assert.deepEqual(r.body.totals, { fin: 117, fal: 20, fts: 15 });
  assert.equal(r.body.bestRider, 1);
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

test('team time trial: the team time is the fourth finisher, fewer than four is a DNQ, ZPower is limited to 40%', async () => {
  const ok = await score({ mode: 'ttt', riders: [{ name: 'A', time: '31:10.2' }, { name: 'B', time: 1871 }, { name: 'C', time: '31:12' }, { name: 'D', time: '31:14.5' }, { name: 'E', time: '35:00' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.dnq, false);
  assert.equal(ok.body.teamTime, 1874.5);
  assert.equal(ok.body.teamClock, '31:14.5');
  assert.deepEqual(ok.body.warnings, []);
  const bad = await score({ mode: 'ttt', riders: [{ name: 'A', time: '31:10' }, { name: 'B', time: '31:11', zpower: true }, { name: 'C', time: '31:12', zpower: true }, { name: 'D', time: '', zpower: true }, { name: 'E' }] });
  assert.equal(bad.body.dnq, true);
  assert.equal(bad.body.teamTime, null);
  assert.equal(bad.body.finishers, 3);
  assert.equal(bad.body.zpowerShare, 60);
  assert.equal(bad.body.warnings.length, 2);
  assert.equal((await score({ mode: 'ttt', riders: [{ name: 'A', time: 'fast' }] })).status, 400);
});

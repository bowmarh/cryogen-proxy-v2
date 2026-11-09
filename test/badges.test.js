'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { badgesFrom } = require('../lib/badges');

h.setEnv();
const ids = r => r.earned.map(b => b.id);

test('badges come from the roster record and the season, and nothing is stored', () => {
  assert.deepEqual(ids(badgesFrom(null, null)), [], 'a brand new rider has none');
  const r = badgesFrom({ zrl: { picked: 3, races: 3, weeks: 6, answered: 6, podiums: 1 }, ttt: { weeks: 2, podiums: 0, captain: 1 }, rides: { attended: 5 }, cover: { led: 1, swept: 0 } },
    { race: { finishes: 12, wins: 1, podiums: 2 } });
  assert.deepEqual(ids(r).sort(), ['captain', 'first_race', 'first_win', 'ever_present', 'podium', 'races_10', 'ride_leader', 'ride_regular', 'social_rider', 'team_player'].sort());
  assert.ok(!ids(r).includes('races_25')); assert.ok(!ids(r).includes('sweeper'));
});

test('the next badge is the nearest one that still needs a count', () => {
  const r = badgesFrom({ rides: { attended: 3 } }, { race: { finishes: 20 } });
  assert.equal(r.next.id, 'races_25', '20 of 25 beats 3 of 5');
  assert.equal(r.next.text, '5 more for 25 races');
});

test('a podium counts from the club results even if the roster has none, and "ever present" needs two or more races', () => {
  assert.ok(ids(badgesFrom({ ttt: { podiums: 1 } }, null)).includes('podium'));
  assert.ok(!ids(badgesFrom({ zrl: { picked: 1, races: 1 } }, null)).includes('ever_present'));
});

let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('the badges route is for the signed-in member only', async () => {
  assert.equal((await app.get('/api/me/badges')).status, 401);
  const t = await app.memberSession('1002', { name: 'Rider Two' });
  const r = await app.get('/api/me/badges', { token: t });
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.body.earned) && Array.isArray(r.body.locked));
});

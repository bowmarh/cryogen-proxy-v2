'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const make = (events, db = {}) => {
  const redis = async cmds => cmds.map(c => h.redisRun(db, c)), posted = [];
  const clubResults = { list: async () => events, leaderboard: async () => ({ challenge: { done: 31, goal: 45 } }) };
  const feed = { add: async (ch, p) => { posted.push([ch, p.content]); return true; } };
  return { d: require('../lib/clubdigest')({ redis, clubResults, feed }), posted };
};
const MON = Date.parse('2026-11-23T09:00:00Z'), ev = (t, riders) => ({ id: String(t), time: t / 1000, riders });

test('the weekly club news line sums up the last seven days and is posted once a week', async () => {
  const { d, posted } = make([
    ev(MON - 2 * 864e5, [{ zwid: '1', name: 'Ann Able [CRYO]', catPos: 1 }, { zwid: '2', name: 'Bo Brown', catPos: 7 }]),
    ev(MON - 5 * 864e5, [{ zwid: '1', name: 'Ann Able [CRYO]', catPos: 3 }]),
    ev(MON - 20 * 864e5, [{ zwid: '3', name: 'Old', catPos: 1 }]),   // too old to count
  ]);
  const out = await d.runSchedule(MON);
  assert.deepEqual(out, ['Last week: 3 finishes from 2 riders, 2 podiums. Best: Ann (1st). Club challenge: 31/45.']);
  assert.deepEqual(posted.map(p => p[0]), ['news']);
  assert.deepEqual(await d.runSchedule(MON + 3600000), [], 'the same week is never posted twice');
  assert.equal((await d.runSchedule(MON + 7 * 864e5 - 1)).length, 0, 'still the same Monday-based week');
});

test('nothing is posted with no finishes, or before the morning', async () => {
  const quiet = make([]);
  assert.deepEqual(await quiet.d.runSchedule(MON), []);
  assert.equal(quiet.posted.length, 0);
  const early = make([ev(MON - 864e5, [{ zwid: '1', name: 'Ann', catPos: 2 }])]);
  assert.deepEqual(await early.d.runSchedule(Date.parse('2026-11-23T03:00:00Z')), []);
  assert.equal((await early.d.runSchedule(MON)).length, 1, 'later that morning it goes out');
});

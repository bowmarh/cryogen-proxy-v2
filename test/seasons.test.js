'use strict';
// Seasons: a name and a start date; each runs until the next starts.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const getSeason = (id, token) => app.get(`/api/ttt/season${id ? `?season=${encodeURIComponent(id)}` : ''}`, { token });
const addSeason = (name, start, token = admin) => app.post('/api/ttt/seasons', { name, start }, { token });
const removeSeason = (id, token = admin) => app.post('/api/ttt/seasons/remove', { id }, { token });

// Starts a week, places one rider on Hawks and enters a result.
async function runWeek(date, rider, position) {
  assert.equal((await app.post('/api/ttt/new-week', { date }, { token: admin })).status, 200);
  const hawks = (await app.get('/api/ttt', { token: admin })).body.week.teams.find(t => t.name === 'Hawks').id;
  await app.post('/api/ttt/signup', { name: rider });
  await app.post('/api/ttt/assign', { name: rider, teams: [hawks] }, { token: admin });
  await app.post('/api/ttt/results', { weekId: date, results: { [hawks]: { time: '24:00', position, of: 9 } } }, { token: admin });
}

// four weeks: wk1 and wk2 are "earlier"; wk3 and wk4 (the current week) are in the new season
async function fourWeeks() {
  await runWeek(h.ymd(10), 'Alpha', 3);
  await runWeek(h.ymd(17), 'Bravo', 2);
  await runWeek(h.ymd(24), 'Charlie', 1);
  await runWeek(h.ymd(31), 'Delta', 4); // current week, has a result
}

test('with no seasons defined the page covers every week, as before', async () => {
  await fourWeeks();
  const d = (await getSeason()).body;
  assert.deepEqual(d.seasons, [{ id: 'all', name: 'All weeks', start: null, end: null }]);
  assert.equal(d.season.id, 'all');
  assert.equal(d.totals.weeks, 4);
});

test('only staff can add or remove seasons, with a real name and date', async () => {
  assert.equal((await addSeason('Season 2', h.ymd(24), null)).status, 401);
  assert.equal((await addSeason('Season 2', h.ymd(24), await app.memberSession('1002'))).status, 401);
  assert.equal((await addSeason('', h.ymd(24))).status, 400, 'a name is needed');
  assert.equal((await addSeason('x'.repeat(41), h.ymd(24))).status, 400, 'and a short one');
  assert.equal((await addSeason('Season 2', 'next week')).status, 400);
  assert.equal((await addSeason('Season 2', '2026-02-30')).status, 400, 'a date that does not exist');
  assert.equal((await addSeason('Season 2', h.ymd(24), mod)).status, 200, 'a moderator can');
  assert.equal((await removeSeason(h.ymd(24), null)).status, 401);
});

test('a new season must start after the latest one', async () => {
  assert.equal((await addSeason('Season 1', h.ymd(10))).status, 200);
  const r = await addSeason('Season 2', h.ymd(10));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /after Season 1/);
  assert.equal((await addSeason('Season 2', h.ymd(3))).status, 409, 'not earlier either');
  assert.equal((await addSeason('Season 2', h.ymd(24))).status, 200);
});

test('weeks fall into the season they belong to, and the latest is the default', async () => {
  await fourWeeks();
  const added = await addSeason('Season 2', h.ymd(24));
  assert.deepEqual(added.body.seasons.map(s => [s.id, s.name, s.start, s.end]), [
    ['before', 'Earlier weeks', null, h.ymd(24)],
    [h.ymd(24), 'Season 2', h.ymd(24), null],
  ], 'earlier weeks get their own entry');

  const current = (await getSeason()).body;
  assert.equal(current.season.name, 'Season 2', 'default is the latest');
  assert.equal(current.totals.weeks, 2);
  assert.deepEqual(current.weeks.map(w => w.date), [h.ymd(31), h.ymd(24)], 'the running week counts once it has a result');
  assert.deepEqual(current.riders.map(r => r.name).sort(), ['Charlie', 'Delta']);

  const earlier = (await getSeason('before')).body;
  assert.equal(earlier.season.id, 'before');
  assert.equal(earlier.totals.weeks, 2);
  assert.deepEqual(earlier.riders.map(r => r.name).sort(), ['Alpha', 'Bravo']);
  assert.equal(earlier.totals.podiums, 2, 'stats are per season');
  assert.equal((await getSeason('nope')).status, 404);
  assert.equal((await getSeason('2030-01-01')).status, 404);
});

test('several seasons split the weeks between their start dates', async () => {
  await fourWeeks();
  await addSeason('One', h.ymd(10));
  await addSeason('Two', h.ymd(24));
  const { seasons } = (await getSeason()).body;
  assert.deepEqual(seasons.map(s => s.name), ['One', 'Two'], 'no "Earlier weeks" when nothing is earlier');
  assert.equal(seasons[0].end, h.ymd(24));
  assert.deepEqual((await getSeason(h.ymd(10))).body.weeks.map(w => w.date), [h.ymd(17), h.ymd(10)]);
  assert.deepEqual((await getSeason(h.ymd(24))).body.weeks.map(w => w.date), [h.ymd(31), h.ymd(24)]);
});

test('removing a season folds its weeks back into the one before', async () => {
  await fourWeeks();
  await addSeason('One', h.ymd(10));
  await addSeason('Two', h.ymd(24));
  assert.equal((await removeSeason('nope')).status, 404);
  const r = await removeSeason(h.ymd(24));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.seasons.map(s => s.name), ['One']);
  assert.equal((await getSeason()).body.totals.weeks, 4, 'Season One now runs to the end');
  await removeSeason(h.ymd(10));
  const d = (await getSeason()).body;
  assert.equal(d.season.id, 'all');
  assert.equal(d.totals.weeks, 4);
});

test('a season with no finished weeks is simply empty', async () => {
  await fourWeeks();
  await addSeason('Season 3', h.ymd(60));
  const d = (await getSeason()).body;
  assert.equal(d.season.name, 'Season 3');
  assert.equal(d.totals.weeks, 0);
  assert.deepEqual(d.weeks, []);
});

test('season pages are public and carry no private data', async () => {
  await fourWeeks();
  await addSeason('Season 2', h.ymd(24));
  const r = await getSeason(); // no token
  assert.equal(r.status, 200);
  assert.ok(!/comments|zwid/.test(JSON.stringify(r.body)));
});

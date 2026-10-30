'use strict';
// Season records: closing a Ladder season, browsing finished DIRT seasons, and a rider's career line in the profile.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
beforeEach(() => { app.world.db = {}; });

async function playedMatch() {
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const m = (await app.post('/api/ladder/match', { opponent: 'Rocket', challenger: 'us' }, A)).body.matches[0];
  await app.post('/api/ladder/lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) }, A);
  await app.post('/api/ladder/result', { match: m.id, positions: { [ID(0)]: 1, [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 5, [ID(4)]: 7 } }, A);
  return m;
}

test('Ladder: closing a season archives the record and roster, optionally clears the matches, and the archive can be listed and opened', async () => {
  await playedMatch();
  assert.equal((await app.post('/api/ladder/season-close', { name: '' }, A)).status, 400);
  const v = (await app.post('/api/ladder/season-close', { name: 'Autumn 2026', clear: true }, A)).body;
  assert.equal(v.matches.length, 0, 'cleared'); assert.equal(v.roster.length, 5, 'the roster stays');
  const list = (await app.get('/api/ladder/archive', A)).body.seasons;
  assert.equal(list.length, 1); assert.deepEqual([list[0].name, list[0].played, list[0].won], ['Autumn 2026', 1, 1]);
  const one = (await app.get(`/api/ladder/archive?id=${encodeURIComponent(list[0].id)}`, A)).body;
  assert.equal(one.matches.length, 1); assert.equal(one.record.riders[0].points > 0, true);
  assert.equal((await app.post('/api/ladder/season-close', { name: 'Empty' }, A)).status, 409, 'nothing to archive');
  assert.equal((await app.get('/api/ladder/archive')).status, 401);
  assert.equal((await app.get('/api/ladder/archive?id=zzz', A)).status, 404);
});

test('DIRT: a reset keeps the season in an archive that can be listed and opened with its riders and stages', async () => {
  await app.post('/api/drs/season', { name: 'DRS Autumn', division: 'Platinum', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  for (let i = 0; i < 4; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  const st = (await app.post('/api/drs/stage', { type: 'scratch', route: 'Loop', date: '2026-11-03' }, A)).body.stages[0];
  await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 1, pts: 120 }, [ID(1)]: { pos: 2, pts: 114 } } }, A);
  await app.post('/api/drs/reset', { confirm: 'RESET' }, A);
  const list = (await app.get('/api/drs/archive', A)).body.seasons;
  assert.deepEqual([list[0].name, list[0].division, list[0].played, list[0].teamPoints, list[0].riders], ['DRS Autumn', 'Platinum', 1, 234, 4]);
  const one = (await app.get(`/api/drs/archive?id=${encodeURIComponent(list[0].id)}`, A)).body;
  assert.equal(one.record.riders[0].points, 120); assert.equal(one.stages[0].teamPoints, 234);
  assert.equal((await app.get('/api/drs/archive')).status, 401);
});

test('the profile shows a rider\'s career across the live data and the archives', async () => {
  const m = await playedMatch();
  void m;
  await app.post('/api/ladder/season-close', { name: 'S1', clear: true }, A);
  await playedMatch().catch(() => {});
  await app.post('/api/drs/season', { name: 'D', division: 'P', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  await app.post('/api/drs/squad', { zwid: ID(0), force: true }, A);
  const st = (await app.post('/api/drs/stage', { type: 'scratch', date: '2026-11-03' }, A)).body.stages[0];
  await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 3, pts: 108 } } }, A);
  const c = (await app.get(`/api/profile?zwid=${ID(0)}`, A)).body.career;
  assert.equal(c.ladder.races >= 1, true); assert.equal(c.ladder.best, 1); assert.equal(c.ladder.wins >= 1, true);
  assert.deepEqual(c.drs, { stages: 1, scored: 1, points: 108, best: 3 });
  assert.deepEqual(c.zrl, { rounds: 0 });
});

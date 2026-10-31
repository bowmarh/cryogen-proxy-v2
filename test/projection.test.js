'use strict';
// Season outlook: an average carried forward, only once there are two results.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
beforeEach(() => { app.world.db = {}; });

test('staff only', async () => {
  assert.equal((await app.get('/api/projection')).status, 401);
  assert.equal((await app.get('/api/projection', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  assert.deepEqual((await app.get('/api/projection', A)).body.zrl, []);
});

test('ZRL: points so far are carried forward over the races left, once two results are in', async () => {
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10), weeks: 6 }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Lad 0', zwid: ID(0), regions: ['eu'], cat: 'B' }); await app.post('/api/zrl/assign', { key: ID(0), team: 'alpha' }, A);
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'alpha', pos: 2, pts: 7 }] }, A);
  let t = (await app.get('/api/projection', A)).body.zrl[0];
  assert.deepEqual([t.raced, t.projected, t.note], [1, null, 'Not enough races yet']);
  await app.post('/api/zrl/results', { week: 1, rows: [{ team: 'alpha', pos: 1, pts: 9 }] }, A);
  t = (await app.get('/api/projection', A)).body.zrl[0];
  assert.deepEqual([t.points, t.perRace, t.left, t.projected], [16, 8, 4, 48]);
});

test('DIRT and the Ladder: the same arithmetic, and the riders heading for the cap are named', async () => {
  await app.post('/api/drs/season', { name: 'A', division: 'P', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  for (let i = 0; i < 4; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  for (const [d, pts] of [['2026-11-03', 200], ['2026-11-10', 300]]) { const st = (await app.post('/api/drs/stage', { type: 'scratch', date: d }, A)).body.stages.slice(-1)[0]; await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 1, pts } } }, A); }
  for (const d of ['2030-01-05', '2030-01-12']) await app.post('/api/drs/stage', { type: 'scratch', date: d }, A);
  let t = (await app.get('/api/projection', A)).body.drs[0];
  assert.deepEqual([t.played, t.left, t.points, t.perStage, t.projected], [2, 2, 500, 250, 1000]);
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const l0 = (await app.get('/api/projection', A)).body.ladder[0];
  assert.equal(l0.expectedWins, null);
  for (const [opp, pos] of [['X', [1, 2, 3, 4, 5]], ['Y', [6, 7, 8, 9, 10]]]) {
    const m = (await app.post('/api/ladder/match', { opponent: opp, challenger: 'us' }, A)).body.matches.find(x => x.opponent === opp);
    await app.post('/api/ladder/lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) }, A);
    await app.post('/api/ladder/result', { match: m.id, positions: Object.fromEntries(pos.map((p, i) => [ID(i), p])) }, A);
  }
  await app.post('/api/ladder/match', { opponent: 'Z', challenger: 'us', date: '2030-02-01', time: '19:30', eventLink: 'https://www.zwift.com/events/view/1' }, A);
  const l = (await app.get('/api/projection', A)).body.ladder[0];
  assert.deepEqual([l.won, l.lost, l.winRate, l.scheduled, l.expectedWins], [1, 1, 50, 1, 0.5]);
});

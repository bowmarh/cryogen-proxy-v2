'use strict';
// WTRL fixes the race time per league colour; the app derives it (with each colour's daylight-saving anchor) and applies it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());

const LEAGUES = ['Pink', 'Mint', 'Lavender', 'Royal', 'Yellow league', 'Ruby', 'Crimson', 'Orange', 'Saffron', 'Nonsense'];
const setup = async start => {
  app.world.db = {};
  await app.post('/api/zrl/round', { name: 'R', start, closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: LEAGUES.map(l => ({ name: `Team ${l}`, region: 'eu', league: l, slot: 'old' })) }, { token: admin });
};
const slots = async () => Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(t => [t.league, t.wtrlSlot]));

test('the times match the WTRL table on race 1 of the season (22 Sep 2026)', async () => {
  await setup('2026-09-22');
  const s = await slots();
  assert.deepEqual([s.Pink, s.Mint, s.Lavender, s.Royal, s['Yellow league'], s.Ruby, s.Crimson, s.Saffron],
    ['Tue 09:30 UTC', 'Tue 17:15 UTC', 'Tue 00:30 UTC', 'Tue 18:45 UTC', 'Tue 08:30 UTC', 'Tue 11:00 UTC', 'Tue 07:30 UTC', 'Tue 11:00 UTC']);
  assert.equal(s.Nonsense, '');
});

test('after the clocks change the UTC times follow each city (17 Nov 2026)', async () => {
  await setup('2026-11-17');
  const s = await slots();
  assert.deepEqual([s.Pink, s.Mint, s.Lavender, s.Royal, s['Yellow league'], s.Ruby, s.Crimson, s.Orange],
    ['Tue 08:30 UTC', 'Tue 18:15 UTC', 'Tue 01:30 UTC', 'Tue 19:45 UTC', 'Tue 09:30 UTC', 'Tue 11:00 UTC', 'Tue 06:30 UTC', 'Tue 11:00 UTC']);
  // Calgary-anchored leagues (Saffron, Lilac) are left out on purpose: they follow the runtime's tz database, which can differ between machines.
});

test('applying is staff only, sets recognised leagues and leaves the rest alone', async () => {
  await setup('2026-11-17');
  assert.equal((await app.post('/api/zrl/league-times', {}, {})).status, 401);
  const r = await app.post('/api/zrl/league-times', {}, { token: admin });
  assert.deepEqual([r.body.changed, r.body.skipped], [9, 1]);
  const t = Object.fromEntries((await app.get('/api/zrl', { token: admin })).body.round.teams.map(x => [x.league, x.slot]));
  assert.equal(t.Pink, 'Tue 08:30 UTC'); assert.equal(t.Nonsense, 'old');
  assert.equal((await app.post('/api/zrl/league-times', {}, { token: admin })).body.changed, 0, 'second run changes nothing');
});

'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const season = async token => (await app.get('/api/ttt/season', { token })).body;

// Runs one week: starts it, signs riders up, places them, optionally names captains and enters results.
async function runWeek(date, { teams, captains = {}, results = {} }) {
  assert.equal((await app.post('/api/ttt/new-week', { date }, { token: admin })).status, 200);
  const ids = Object.fromEntries((await app.get('/api/ttt', { token: admin })).body.week.teams.map(t => [t.name, t.id]));
  for (const [team, names] of Object.entries(teams)) {
    for (const n of names) {
      if (!(await app.get('/api/ttt', { token: admin })).body.signups.some(s => s.name === n)) await app.post('/api/ttt/signup', { name: n });
      await app.post('/api/ttt/assign', { name: n, teams: [ids[team]] }, { token: admin });
    }
  }
  for (const [team, name] of Object.entries(captains)) await app.post('/api/ttt/captain', { team: ids[team], name }, { token: admin });
  if (Object.keys(results).length) {
    await app.post('/api/ttt/results', { weekId: date, results: Object.fromEntries(Object.entries(results).map(([t, r]) => [ids[t], r])) }, { token: admin });
  }
}

test('an empty season says so instead of failing', async () => {
  const d = await season();
  assert.deepEqual(d.totals, { weeks: 0, riders: 0, avgPerWeek: 0, podiums: 0 });
  assert.deepEqual([d.teams, d.riders, d.weeks], [[], [], []]);
});

test('a season adds up: totals, team results, rider leaderboard and week by week', async () => {
  await runWeek(h.ymd(10), {
    teams: { Hawks: ['Alpha', 'Bravo', 'Charlie', 'Delta'], Owls: ['Echo', 'Foxtrot'] },
    captains: { Hawks: 'Alpha' },
    results: { Hawks: { time: '24:31', position: 2, of: 9 }, Owls: { dnf: true } },
  });
  await runWeek(h.ymd(17), {
    teams: { Hawks: ['Alpha', 'Bravo'], Owls: ['Echo'] },
    results: { Hawks: { time: '23:50', position: 1, of: 8 }, Owls: { time: '26:10', position: 5, of: 8 } },
  });
  // the current week counts once it has results, even before it rolls over
  await runWeek(h.ymd(24), {
    teams: { Hawks: ['Alpha', 'Bravo'], Crows: ['Golf'] },
    results: { Hawks: { position: 3, of: 9 } },
  });

  const d = await season(); // public: no login needed
  assert.deepEqual(d.totals, { weeks: 3, riders: 7, avgPerWeek: 4, podiums: 3 });

  const hawks = d.teams.find(t => t.name === 'Hawks');
  assert.deepEqual({ weeks: hawks.weeks, best: hawks.best, avg: hawks.avgPosition, podiums: hawks.podiums, dnfs: hawks.dnfs, raced: hawks.raced }, { weeks: 3, best: 1, avg: 2, podiums: 3, dnfs: 0, raced: 3 });
  const owls = d.teams.find(t => t.name === 'Owls');
  assert.deepEqual({ weeks: owls.weeks, best: owls.best, avg: owls.avgPosition, podiums: owls.podiums, dnfs: owls.dnfs }, { weeks: 2, best: 5, avg: 5, podiums: 0, dnfs: 1 }, 'a DNF is counted but is not a position');
  const crows = d.teams.find(t => t.name === 'Crows');
  assert.deepEqual({ weeks: crows.weeks, best: crows.best, avg: crows.avgPosition }, { weeks: 1, best: null, avg: null }, 'a team with no result yet');
  assert.equal(d.teams[0].name, 'Hawks', 'most podiums first');

  assert.deepEqual(d.riders.slice(0, 2).map(r => [r.name, r.weeks, r.captain, r.podiums]), [['Alpha', 3, 1, 3], ['Bravo', 3, 0, 3]]);
  assert.deepEqual(d.riders.find(r => r.name === 'Echo'), { name: 'Echo', weeks: 2, captain: 0, podiums: 0 });
  assert.equal(d.riders.find(r => r.name === 'Charlie').weeks, 1);

  assert.deepEqual(d.weeks.map(w => w.date), [h.ymd(24), h.ymd(17), h.ymd(10)], 'newest first');
  const first = d.weeks[2];
  assert.deepEqual(first.teams.map(t => t.name), ['Hawks', 'Owls']);
  assert.deepEqual(first.teams[0].riders, ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  assert.equal(first.teams[0].captain, 'Alpha');
  assert.equal(first.teams[0].result.position, 2);
  assert.equal(first.teams[1].result.dnf, true);
});

test('weeks and teams with nobody in them and no result are left out', async () => {
  await runWeek(h.ymd(10), { teams: {}, results: {} });
  await runWeek(h.ymd(17), { teams: { Hawks: ['Alpha'] }, results: {} });
  assert.equal((await season()).totals.weeks, 0, 'the current week without results is not part of the season yet');
  await runWeek(h.ymd(24), { teams: {}, results: {} }); // rolls week 2 into the archive
  const d = await season();
  assert.equal(d.totals.weeks, 1, 'the empty week is not counted');
  assert.deepEqual(d.teams.map(t => t.name), ['Hawks']);
  assert.equal(d.weeks[0].teams[0].result, null);
});

test('rider comments and other private fields never reach the season page', async () => {
  await app.post('/api/ttt/new-week', { date: h.ymd(10) }, { token: admin });
  await app.post('/api/ttt/signup', { name: 'Alpha', comments: 'private note for admins', cat: 'A' });
  const t1 = (await app.get('/api/ttt', { token: admin })).body.week.teams[0];
  await app.post('/api/ttt/assign', { name: 'Alpha', teams: [t1.id] }, { token: admin });
  await app.post('/api/ttt/results', { weekId: h.ymd(10), results: { [t1.id]: { position: 1, of: 5 } } }, { token: admin });
  const text = JSON.stringify(await season());
  assert.ok(!text.includes('private note'));
  assert.ok(!/comments|zwid/.test(text));
});

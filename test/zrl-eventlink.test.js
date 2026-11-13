'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ ZWIFTRACING_API_KEY: 'zr-key' });
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());

test("a team's captain saves the race link for a week; another rider cannot; the link reaches the club results queue after the race", async () => {
  assert.equal((await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-10-27' }, { token: admin })).status, 200);
  const teams = await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO Ice', region: 'eu', slot: 'Tue 19:00 UTC', captain: '1002' }] }, { token: admin });
  assert.equal(teams.status, 200, JSON.stringify(teams.body));
  const team = teams.body.round ? teams.body.round.teams[0].id : (await app.get('/api/zrl', { token: admin })).body.round.teams[0].id;
  const captain = await app.memberSession('1002'), other = await app.memberSession('1000');
  assert.equal((await app.post('/api/zrl/event-link', { team, week: 0, event: 'https://www.zwift.com/events/view/4444444' }, { token: other })).status, 403);
  const ok = await app.post('/api/zrl/event-link', { team, week: 0, event: 'https://www.zwift.com/events/view/4444444' }, { token: captain });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.event, '4444444');
  assert.equal((await app.post('/api/zrl/event-link', { team, week: 0, event: 'not a link' }, { token: captain })).status, 400);
});

test('a saved ZRL race link is queued and fetched for the club results 90 minutes after the race', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c)), fetched = [];
  const start = Date.parse('2026-11-03T19:00:00Z');
  const r = require('../lib/clubresults')({ redis, HttpError: Error, requireRole() {}, roleFromRequest() {}, memberFromRequest() {},
    fetchZrResults: async id => { fetched.push(id); return { title: 'ZRL Race 2', time: start / 1000, results: [{ riderId: 1000, position: 4 }] }; },
    clubRiders: async () => new Map([['1000', 'Rider 0']]), moreEvents: async () => [{ id: '4444444', startMs: start }] });
  assert.deepEqual(await r.runSchedule(start + 30 * 60000), [], 'not yet: results need time to settle');
  assert.deepEqual(await r.runSchedule(start + 2 * 3600000), ['Results: ZRL Race 2 (1 of ours)']);
  assert.deepEqual(fetched, ['4444444']);
});

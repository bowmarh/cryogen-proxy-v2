'use strict';
// Team captains for the Ladder and the DIRT Series: named by staff, they manage their own team's line-ups, answers, posts and results, and nothing else.
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
const as = (i, name = `Lad ${i}`) => app.memberSession(ID(i), { name });
beforeEach(() => { app.world.db = {}; });

async function ladderTwoTeams() {
  for (let i = 0; i < 6; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const other = (await app.post('/api/ladder/team', { name: 'Second' }, A)).body.team.id;
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i), team: other }, A);
  const t = new Date(Date.now() + 5 * 86400000), when = { date: t.toISOString().slice(0, 10), time: '19:30', eventLink: 'https://www.zwift.com/events/view/5' };
  const a = (await app.post('/api/ladder/match', { opponent: 'A', challenger: 'us', ...when }, A)).body.matches[0];
  const b = (await app.post('/api/ladder/match', { opponent: 'B', challenger: 'us', team: other, date: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10), time: '19:30', eventLink: when.eventLink }, A)).body.matches.find(m => m.opponent === 'B');
  return { a, b, other };
}

test('Ladder: staff name captains from the roster; a captain manages their own team only', async () => {
  const { a, b, other } = await ladderTwoTeams();
  assert.equal((await app.post('/api/ladder/captains', { zwids: [ID(1)] }, { token: await as(1) })).status, 401, 'a rider cannot name captains');
  assert.equal((await app.post('/api/ladder/captains', { zwids: ['999'] }, A)).status, 400, 'must be on the roster');
  assert.equal((await app.post('/api/ladder/captains', { zwids: [ID(0), ID(1), ID(2), ID(3)] }, A)).status, 400, 'at most three');
  await app.post('/api/ladder/captains', { zwids: [ID(1)] }, A);   // the first team
  const cap = await as(1), plain = await as(4);
  // the captain's own team
  const view = (await app.get('/api/ladder', { token: cap })).body;
  assert.equal(view.captain, true); assert.equal(view.staff, false);
  assert.ok(view.matches[0].availability, 'a captain sees who answered what');
  assert.equal((await app.post('/api/ladder/auto-lineup', { match: a.id }, { token: cap })).status, 200);
  assert.equal((await app.get(`/api/ladder/suggest?match=${a.id}`, { token: cap })).status, 200);
  assert.equal((await app.post('/api/ladder/availability', { match: a.id, zwid: ID(3), status: 'no' }, { token: cap })).status, 200, 'answer for a rider');
  assert.equal((await app.post('/api/ladder/post', { match: a.id, kind: 'lineup' }, { token: cap })).status, 200);
  // not other teams, not staff-only things, not an ordinary rider
  assert.equal((await app.post('/api/ladder/auto-lineup', { match: b.id }, { token: cap })).status, 403, 'another team');
  assert.equal((await app.post('/api/ladder/match', { opponent: 'X', challenger: 'us' }, { token: cap })).status, 401, 'creating a match is staff only');
  assert.equal((await app.post('/api/ladder/auto-lineup', { match: a.id }, { token: plain })).status, 403, 'not a captain');
  assert.equal((await app.post('/api/ladder/availability', { match: a.id, zwid: ID(3), status: 'yes' }, { token: plain })).status, 200, 'a rider can only answer for themselves: this was ignored');
  assert.equal((await app.get('/api/ladder', { token: plain })).body.matches[0].availability, undefined, 'ordinary riders do not see everyone\'s answers');
  void other;
});

test('DIRT: captains pick the scoring four and read places for their own team; riders cannot', async () => {
  await app.post('/api/drs/season', { name: 'A', division: 'P', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  for (let i = 0; i < 6; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  const st = (await app.post('/api/drs/stage', { type: 'scratch', date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) }, A)).body.stages[0];
  assert.equal((await app.post('/api/drs/captains', { zwids: ['x'] }, A)).status, 400);
  await app.post('/api/drs/captains', { zwids: [ID(0)] }, A);
  assert.deepEqual((await app.get('/api/drs', A)).body.season.captains, [ID(0)]);
  const cap = await as(0), plain = await as(3);
  const v = (await app.get('/api/drs', { token: cap })).body;
  assert.equal(v.captain, true); assert.ok(v.stages[0].availability);
  assert.equal((await app.post('/api/drs/roles', { stage: st.id, auto: true }, { token: cap })).status, 200);
  assert.equal((await app.post('/api/drs/availability', { stage: st.id, zwid: ID(2), status: 'no' }, { token: cap })).status, 200);
  assert.equal((await app.post('/api/drs/roles', { stage: st.id, auto: true }, { token: plain })).status, 403);
  assert.equal((await app.post('/api/drs/stage', { type: 'scratch', date: '2026-12-01' }, { token: cap })).status, 401, 'the calendar is staff only');
  await app.post('/api/drs/season', { name: 'A', division: 'P', threshold: 5000, time: '20:00', tz: 'Europe/London' }, A);
  assert.deepEqual((await app.get('/api/drs', A)).body.season.captains, [ID(0)], 'editing the season keeps the captains');
});

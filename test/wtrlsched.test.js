'use strict';
// WTRL's public race schedule: read per league colour, cached, and used to flag a team whose race time in the app differs.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createWtrlSched = require('../lib/wtrlsched');

h.setEnv();
const NOW = Date.parse('2026-11-16T12:00:00Z');
const season = (id, startIso) => ({ success: true, payload: { season: id, round: 2, events: [
  { leagueName: 'Mint League', eventStartUTC: startIso || '2026-11-17T18:15:00Z' }, { leagueName: 'Indigo League', eventStartUTC: startIso || '2026-11-18T00:30:00Z' }] } });
const mk = (answers, calls = []) => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const fetchImpl = async url => { calls.push(url); const id = Number(/(\d+)$/.exec(url)[1]); const a = answers[id]; return a ? { ok: true, json: async () => a } : { ok: false, status: 404, json: async () => ({}) }; };
  return { s: createWtrlSched({ redis, fetchImpl, now: () => NOW }), db, calls };
};

test('slots come out as weekday and UTC time per league colour', () => {
  const { s } = mk({});
  assert.deepEqual(s.slotsOf(season(21).payload), { mint: 'Tue 18:15 UTC', indigo: 'Wed 00:30 UTC' });
});

test('the newest season that is racing now is found; old and far-off ones are skipped; the answer is kept and not asked again for six hours', async () => {
  const calls = [];
  const { s, db } = mk({ 22: season(22, '2027-06-01T18:00:00Z'), 21: season(21), 20: season(20, '2026-08-01T18:00:00Z') }, calls);
  const c = await s.refreshIfStale(); assert.equal(c.season, 21); assert.equal(c.slots.mint, 'Tue 18:15 UTC');
  const n = calls.length; await s.refreshIfStale(); assert.equal(calls.length, n, 'fresh enough: no new request');
  assert.equal((await s.cached()).season, 21);
});

test('when WTRL cannot be reached nothing breaks: no schedule, no check', async () => {
  const { s } = mk({});
  assert.equal(await s.refreshIfStale(), null); assert.equal(await s.cached(), null);
});

let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('the ZRL checklist lists a team whose race time differs from WTRL, with both times, and passes when they match; nothing is said without a schedule', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Hawks', region: 'eu', league: 'Mint League', slot: 'Tue 18:00 UTC' }] }, { token: admin });
  await app.post('/api/zrl/signup', { regions: ['eu'], cat: 'C' }, { token: await app.memberSession('4378027', { name: 'Ann Able' }) });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-hawks' }, { token: admin });   // a team only counts once somebody is on it
  const row = async () => (await app.get('/api/zrl/readiness', { token: admin })).body.items.find(i => i.id === 'wtrltimes');
  assert.equal(await row(), undefined, 'no schedule read yet: no such check');
  app.world.db['cg:zrl:wtrltimes'] = JSON.stringify({ at: NOW, season: 21, slots: { mint: 'Tue 18:15 UTC' } });
  let r = await row(); assert.equal(r.state, 'todo'); assert.match(r.detail, /CRYO-GEN Hawks \(app Tue 18:00, WTRL Tue 18:15\)/);
  await app.post('/api/zrl/teams', { teams: [{ id: 'cryo-gen-hawks', name: 'CRYO-GEN Hawks', region: 'eu', league: 'Mint League', slot: 'Tue 18:15 UTC' }] }, { token: admin });
  r = await row(); assert.equal(r.state, 'ok');
});

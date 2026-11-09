'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createClubStats = require('../lib/clubstats');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const mk = ({ people, seen = {}, velo = [], staff = {} }) => {
  const db = { 'cg:onboard:seen': Object.fromEntries(Object.entries(seen).map(([z, v]) => [z, JSON.stringify(v)])), 'cg:staff:trend': Object.fromEntries(Object.entries(staff).map(([d, v]) => [d, JSON.stringify(v)])) };
  const redis = async cmds => cmds.map(([c, k]) => (c === 'HGETALL' ? Object.entries(db[k] || {}).flat() : null));
  return createClubStats({ redis, HttpError: Error, requireRole() {}, tidy: { analyse: async () => ({ inactive: people }) }, trend: { view: async () => ({ velo }) } });
};
const p = (days, extra = {}) => ({ inClub: true, tier: 'full', daysSinceRace: days, finishes: days === null ? 0 : 5, ...extra });

test('activity buckets count members by how long since they last raced, leaving out associates and non-members', async () => {
  const cs = mk({ people: [p(3), p(30), p(31), p(90), p(120), p(181), p(null), p(5, { tier: 'associate' }), p(5, { inClub: false })] });
  const a = (await cs.build(NOW)).activity;
  assert.equal(a.total, 7); assert.equal(a.racedLast30, 2); assert.equal(a.racedLast90, 4); assert.equal(a.quiet, 2, '90 and 120 days are in the 45 to 180 quiet range'); assert.equal(a.neverRaced, 1);
  assert.deepEqual(a.buckets.map(b => b[1]), [2, 2, 1, 1, 1]);
});

test('new members by month come from first-seen dates, ignoring the first run that only seeded existing members', async () => {
  const cs = mk({ people: [p(3)], seen: { 1: { at: '2026-11-02T10:00:00Z', seed: false }, 2: { at: '2026-10-20T10:00:00Z', seed: false }, 3: { at: '2026-10-21T10:00:00Z', seed: false }, 4: { at: '2026-01-01T10:00:00Z', seed: true } } });
  const j = Object.fromEntries((await cs.build(NOW)).joiners.map(x => [x.month, x.n]));
  assert.equal(j['2026-11'], 1); assert.equal(j['2026-10'], 2); assert.equal(j['2026-01'], 0, 'a seeded member is not a joiner');
});

test('club size takes the last snapshot of each month and the notes read the numbers in plain English', async () => {
  const velo = [{ d: '2026-09-05', n: 40, avg: 1400 }, { d: '2026-09-28', n: 42, avg: 1410 }, { d: '2026-10-30', n: 47, avg: 1430 }];
  const cs = mk({ people: [p(3), p(10), p(100), p(120), p(130), p(null)], velo, staff: { '2026-11-09': { racing: 3, unplaced: 1, attention: 4 } } });
  const d = await cs.build(NOW);
  assert.deepEqual(d.size.map(s => s.n), [42, 47]);
  const text = d.notes.join(' | ');
  assert.match(text, /33% of 6 members raced in the last 30 days/);
  assert.match(text, /3 members \(50%\) have not raced for 45 to 180 days/);
  assert.match(text, /1 member has never raced/);
  assert.match(text, /Active riders went from 42 to 47/);
  assert.match(text, /3 riders are in this round's ZRL \(50% of members\); 1 still need a team/);
  assert.equal(JSON.stringify(d).includes('name'), false, 'no names');
});

test('the route is staff only', async () => {
  const h = require('./helpers'); h.setEnv();
  const app = await h.startApp(h.createWorld());
  try {
    assert.equal((await app.get('/api/staff/clubstats')).status, 401);
    const t = await app.memberSession('1002', { name: 'Rider Two' });
    assert.equal((await app.get('/api/staff/clubstats', { token: t })).status, 401);
    const admin = await app.login('admin'), r = await app.get('/api/staff/clubstats', { token: admin });
    assert.equal(r.status, 200); assert.ok(r.body.activity && Array.isArray(r.body.joiners));
    assert.equal((await app.get('/api/staff/clubstats', { token: await app.login('mod') })).status, 200);
  } finally { await app.close(); }
});

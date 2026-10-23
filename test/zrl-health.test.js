'use strict';
// The ZRL row of the admin health panel.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const { healthRow } = require('../lib/zrl')({ HttpError, teamId: n => n, text: x => x, ukLabel: ms => `T${ms}` });

const NOW = Date.parse('2026-11-01T12:00:00Z');
const day = n => NOW + n * 86400000;
const team = (id, captain = '1', slot = 'Tue 17:00 UTC') => ({ id, name: id, region: 'eu', captain, slot });
const rider = (key, regions = ['eu']) => ({ key, name: key, in: true, regions });
const round = (o = {}) => ({ id: 'r', name: 'Round 2', open: false, published: true, start: '2026-11-17', closesAt: new Date(day(-3)).toISOString(), teams: [team('a')], ...o });
const row = (r, signups = [rider('x')], assign = { x: 'a' }, now = NOW) => healthRow({ round: r, signups, assign }, now);

test('no round is information, not a problem', () => {
  assert.equal(healthRow({ round: null, signups: [], assign: {} })[0], 'info');
});

test('open sign-ups need a close date, and one that has passed is flagged', () => {
  const noDate = row(round({ open: true, closesAt: undefined }));
  assert.equal(noDate[0], 'warn'); assert.match(noDate[1], /No close date/);
  const late = row(round({ open: true, closesAt: new Date(day(-1)).toISOString() }));
  assert.equal(late[0], 'warn'); assert.match(late[1], /has passed but sign-ups are still open/);
  const fine = row(round({ open: true, closesAt: new Date(day(5)).toISOString() }));
  assert.equal(fine[0], 'ok'); assert.match(fine[1], /sign-ups open.*Closes/);
});

test('rosters not published close to the first race, riders without a team, and teams without a captain are flagged', () => {
  const soon = row(round({ published: false, start: '2026-11-05' }));
  assert.equal(soon[0], 'warn'); assert.match(soon[1], /less than a week away and the rosters are not published/);
  assert.equal(row(round({ published: false, start: '2026-12-20' }))[0], 'ok', 'plenty of time');
  assert.equal(row(round({ published: false, start: '2026-11-05' }), [rider('x')], { x: 'a' }, day(10))[1].includes('under way'), true);
  const unplaced = row(round(), [rider('x'), rider('y')], { x: 'a' });
  assert.equal(unplaced[0], 'warn'); assert.match(unplaced[1], /1 rider has no team/);
  const bare = row(round({ teams: [team('a', '')] }));
  assert.equal(bare[0], 'warn'); assert.match(bare[1], /1 team has no captain/);
});

test('teams with riders but no race time are flagged once sign-ups are over; empty teams are not', () => {
  const noTime = row(round({ teams: [team('a', '1', '')] }));
  assert.equal(noTime[0], 'warn'); assert.match(noTime[1], /1 team has riders but no race time/);
  const both = row(round({ teams: [team('a', '', ''), team('b', '1', '')] }), [rider('x'), rider('y')], { x: 'a', y: 'b' });
  assert.match(both[1], /1 team has no captain\. 2 teams have riders but no race time/, 'several problems are listed together');
  assert.equal(row(round({ teams: [team('a'), team('empty', '', '')] }))[0], 'ok', 'a team with nobody in it needs neither');
  assert.equal(row(round({ open: true, published: false, start: '2027-01-12', closesAt: new Date(day(5)).toISOString(), teams: [team('a', '', '')] }))[0], 'ok', 'while sign-ups are open and nothing is published it is too early to nag');
});

test('a healthy round reports its numbers', () => {
  const [status, detail] = row(round(), [rider('x'), rider('y', ['ap'])], { x: 'a', y: 'a' });
  assert.equal(status, 'ok');
  assert.match(detail, /2 riders in \(EU 1 · AM 0 · AS 1\), 1 team, 2 placed, rosters published/);
});

// ── through the server ──
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('the admin panel shows the ZRL row, and members cannot see the panel', async () => {
  const get = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'zrl');
  assert.equal((await get()).status, 'info');
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-12-20', closes: h.ymd(10) }, { token: admin });
  const c = await get();
  assert.equal(c.status, 'ok', c.detail);
  assert.match(c.detail, /Round 2: sign-ups open, 0 riders in/);
  assert.equal((await app.get('/api/health')).status, 401);
});

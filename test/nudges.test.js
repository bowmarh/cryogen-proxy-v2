'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createCaptainWeekly = require('../lib/captainweekly'), createWelcome = require('../lib/welcome');

h.setEnv();
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };

test('captain weekly: Sunday evening only, one message per captain and team per week, only when someone has not answered, retried only if the captain could not be reached', async () => {
  const { redis } = mem(), dms = []; let reachable = true;
  const round = { name: 'R', start: '2026-11-16', weeks: 3, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1' }, { id: 't2', name: 'Bravo', captain: '9' }, { id: 't3', name: 'NoCap', captain: '' }] };
  const signups = [['1', 'Ann Lee'], ['2', 'Bo Dunn'], ['3', 'Cy Ray'], ['9', 'Di Fox']].map(([zwid, name]) => ({ key: zwid, zwid, name, in: true }));
  const avail = { '0:1': 'yes', '0:9': 'yes' };   // Bo and Cy have not answered; Bravo has everyone
  const zrl = { load: async () => ({ round, signups, assign: { 1: ['t1'], 2: ['t1'], 3: ['t1'], 9: ['t2'] } }), loadWeekly: async () => ({ avail, lineup: {} }), availOf: (w, wk, z) => w.avail[`${wk}:${z}`] || '' };
  const cw = createCaptainWeekly({ redis, zrl, notify: async (z, t) => { if (!reachable) return false; dms.push([z, t]); return true; }, siteUrl: 'https://club.test' });
  assert.deepEqual(await cw.run(Date.parse('2026-11-15T10:00:00Z')), [], 'Sunday morning: too early'); assert.deepEqual(await cw.run(Date.parse('2026-11-14T18:00:00Z')), [], 'Saturday');
  reachable = false; assert.deepEqual(await cw.run(Date.parse('2026-11-15T18:00:00Z')), [], 'the captain cannot be messaged'); reachable = true;
  assert.deepEqual(await cw.run(Date.parse('2026-11-15T19:00:00Z')), ['captain weekly']); assert.equal(dms.length, 1, 'only Alpha: Bravo has everyone, NoCap has no captain');
  assert.equal(dms[0][0], '1'); assert.match(dms[0][1], /Alpha: 2 of 3 riders have not answered for race 1 \(2026-11-16\): Bo Dunn, Cy Ray/); assert.match(dms[0][1], /Ask the unanswered/);
  assert.deepEqual(await cw.run(Date.parse('2026-11-15T20:00:00Z')), [], 'once a week'); assert.deepEqual(await cw.run(Date.parse('2026-11-22T18:00:00Z')), ['captain weekly'], 'the next week is a new week: asked about race 2'); assert.match(dms[1][1], /race 2 \(2026-11-23\)/);
  for (const z of ['1', '2', '3', '9']) avail[`2:${z}`] = 'yes'; assert.deepEqual(await cw.run(Date.parse('2026-11-29T18:00:00Z')), [], 'everyone has answered: nothing to say');
});

test('first-race nudge: a week after finishing the welcome, once, only if not on a team, and not for a waived member', async () => {
  const { redis } = mem(), dms = [], day = 86400000, t0 = Date.parse('2026-11-01T12:00:00Z'); let onTeam = new Set(['3']);
  const w = createWelcome({ redis, HttpError, requireRole: () => {}, memberFromRequest: () => null, isStaff: () => true, verifiedLinks: async () => new Set(), teamSets: async () => onTeam, notify: async (z, t) => { dms.push([z, t]); return true; }, siteUrl: 'https://club.test', now: () => t0 });
  const state = { '1': { done: new Date(t0).toISOString() }, '2': { done: new Date(t0).toISOString() }, '3': { done: new Date(t0).toISOString() }, '4': { done: new Date(t0).toISOString(), waived: true }, '5': {} };
  for (const [z, s] of Object.entries(state)) await redis([['HSET', 'cg:welcome:state', z, JSON.stringify(s)]]);
  assert.deepEqual(await w.runSchedule(t0 + 3 * day), [], 'too soon');
  assert.deepEqual(await w.runSchedule(t0 + 8 * day), ['first-race nudge']); assert.deepEqual(dms.map(d => d[0]).sort(), ['1', '2'], 'not the one already on a team, not the waived one, not the one who never finished'); assert.match(dms[0][1], /TTT Week/);
  assert.deepEqual(await w.runSchedule(t0 + 9 * day), [], 'once only'); assert.deepEqual(await w.runSchedule(t0 + 40 * day), [], 'a month on: too late to be a nudge');
});

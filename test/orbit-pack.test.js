'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createLifecycle = require('../lib/lifecycle');
const createWeekPush = require('../lib/weekpush');

h.setEnv();
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };

test('when a member goes quiet, their ZRL captain gets one heads-up as well as the member', async () => {
  const { redis } = mem(), notes = [];
  const tidy = { analyse: async () => ({ inactive: [{ zwid: '5', name: 'Quiet Rider', inClub: true, tier: 'full', daysSinceRace: 70, lastRaced: '2026-08-26' }] }) };
  const notify = async (zwid, text, opts) => { notes.push({ zwid, text, kind: opts.kind, key: opts.key }); return true; };
  const lc = createLifecycle({ requireRole: () => {}, tidy, notify, siteUrl: 'https://club.test', redis, captainsOf: async z => (z === '5' ? [{ zwid: '9', team: 'CRYO A' }] : []) });
  const ran = await lc.runSchedule(Date.parse('2026-11-04T10:00:00Z'));
  assert.deepEqual(notes.map(n => [n.zwid, n.kind]), [['5', 'club'], ['9', 'captain']]);
  assert.match(notes[1].text, /Quiet Rider on CRYO A/);
  assert.ok(ran.includes('captain-9-5'));
  notes.length = 0; await lc.runSchedule(Date.parse('2026-11-04T18:00:00Z'));
  assert.equal(notes.length, 0, 'once a day at most');
});

test('"your week" goes out on Monday once per rider per week, only when switched on, only to active members with something on', async () => {
  const { redis } = mem(), sent = [];
  const week = { name: 'Ann Lee', items: [{ atMs: Date.parse('2026-11-12T19:00:00Z'), timed: true, kind: 'ZRL', title: 'Race 4', note: 'Are you racing?', state: 'todo' }] };
  const empty = { name: 'Bo', items: [] };
  const wp = createWeekPush({ redis, HttpError, requireRole: () => {}, siteUrl: 'https://club.test',
    myweek: { buildFor: async m => (m.zwid === '1' ? week : empty) },
    comms: { verifiedDiscordIds: async () => new Map([['1', 'd1'], ['2', 'd2'], ['3', 'd3']]), notify: async (z, text, o) => { sent.push({ z, text, kind: o.kind }); return true; } },
    rosterNames: async () => new Map([['1', 'Ann Lee'], ['2', 'Bo']]) });   // 3 is not an active member
  const MON = Date.parse('2026-11-09T09:00:00Z'), WED = Date.parse('2026-11-11T09:00:00Z');
  assert.deepEqual(await wp.runSchedule(MON), [], 'off until an administrator switches it on');
  await wp.routes['POST /api/weekpush/settings']({}, { on: true });
  assert.deepEqual(await wp.runSchedule(WED), [], 'not mid-week');
  assert.deepEqual(await wp.runSchedule(MON), ['Your week: sent to 1']);
  assert.deepEqual(sent.map(s => [s.z, s.kind]), [['1', 'week']]);
  assert.match(sent[0].text, /Needs your answer \(1\)/); assert.match(sent[0].text, /Thu 19:00 UTC/); assert.match(sent[0].text, /club\.test/);
  assert.deepEqual(await wp.runSchedule(MON + 3600000), [], 'once a week');
});

test('"your week" leads with last week\'s results, and goes to a rider who raced even with nothing on this week', async () => {
  const { redis } = mem(), sent = [];
  const NOW = Date.parse('2026-11-09T09:00:00Z');
  const wp = createWeekPush({ redis, HttpError, requireRole: () => {}, siteUrl: 'https://club.test',
    myweek: { buildFor: async () => ({ name: 'Ann Lee', items: [] }) },
    comms: { verifiedDiscordIds: async () => new Map([['1', 'd1']]), notify: async (z, text) => { sent.push(text); return true; } },
    rosterNames: async () => new Map([['1', 'Ann Lee']]),
    recentResults: async () => [{ title: 'Club Ladder', time: (NOW - 3 * 86400000) / 1000, catPos: 2, cat: 'B' }, { title: 'Old race', time: (NOW - 30 * 86400000) / 1000, catPos: 1, cat: 'B' }] });
  await wp.routes['POST /api/weekpush/settings']({}, { on: true });
  assert.deepEqual(await wp.runSchedule(NOW), ['Your week: sent to 1']);
  assert.match(sent[0], /Last week/); assert.match(sent[0], /#2 in B · Club Ladder/); assert.doesNotMatch(sent[0], /Old race/);
});

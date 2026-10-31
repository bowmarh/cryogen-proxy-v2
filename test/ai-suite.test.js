'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { rng } = require('./fitwriter');
const createAi = require('../lib/ai'), createSupport = require('../lib/support'), createAiPlans = require('../lib/aiplans'), createAiStaff = require('../lib/aistaff');

h.setEnv();

// ── A tiny in-memory Redis and a stand-in model for the scheduled jobs, which depend on the day of the week ──
function mini() {
  const db = {};
  const hash = k => (db[k] = db[k] || {});
  const redis = async cmds => cmds.map(([c, k, ...a]) => {
    switch (c) {
      case 'GET': return db[k] === undefined ? null : db[k];
      case 'SET': db[k] = a[0]; return 'OK';
      case 'EXPIRE': return 1;
      case 'INCR': db[k] = (Number(db[k]) || 0) + 1; return db[k];
      case 'HGET': return hash(k)[a[0]] === undefined ? null : hash(k)[a[0]];
      case 'HSET': hash(k)[a[0]] = a[1]; return 1;
      case 'HDEL': delete hash(k)[a[0]]; return 1;
      case 'HSETNX': if (a[0] in hash(k)) return 0; hash(k)[a[0]] = a[1]; return 1;
      case 'HINCRBY': hash(k)[a[0]] = String((Number(hash(k)[a[0]]) || 0) + Number(a[1])); return Number(hash(k)[a[0]]);
      case 'HGETALL': return Object.entries(hash(k)).flat();
      default: throw new Error('mini redis: ' + c);
    }
  });
  return { db, redis };
}
function kit({ answer = 'Plan text', riders = [] } = {}) {
  const { db, redis } = mini(), seen = [], HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
  const fetchImpl = async (u, o) => { seen.push(JSON.parse(o.body)); const text = typeof answer === 'function' ? answer(JSON.parse(o.body)) : answer; return { ok: true, json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }) }; };
  const support = createSupport({ redis, HttpError, requireRole() {}, fetchRoster: async () => ({ riders }) });
  const ai = createAi({ redis, HttpError, support, fetchImpl });
  return { db, redis, seen, HttpError, support, ai };
}
const monday = '2026-11-02T08:00:00Z', tuesday = '2026-11-03T08:00:00Z', sunday = '2026-11-01T08:00:00Z';

test('the Monday plan: queued once from supporters who said yes and opted in, sent as a coach message once, only on Monday and Tuesday, and not when the budget is used', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const k = kit({ answer: 'Tue: 60 min at 70% FTP\nThu: 2 x 15 at 90%' }), sent = [];
  await k.redis([['HSET', 'cg:support:list', '1', JSON.stringify({ since: '2026-10-01' })], ['HSET', 'cg:support:list', '2', JSON.stringify({ since: '2026-10-01' })], ['HSET', 'cg:coach:consent', '1', 'y'], ['HSET', 'cg:coach:consent', '2', 'y'], ['HSET', 'cg:coach:consent', '3', 'y'],
    ['HSET', 'cg:plan:optin', '1', 'y'], ['HSET', 'cg:plan:optin', '3', 'y']]);   // 1: supporter + yes + opted in; 2: supporter, not opted in; 3: opted in but not a supporter
  const coach = { context: async () => ({ rider: { ftpWatts: 250 }, upcoming: [] }), SYSTEM: 'COACH' };
  const plans = createAiPlans({ redis: k.redis, HttpError: k.HttpError, memberFromRequest: () => null, ai: k.ai, coach, support: k.support, notify: async (z, t, o) => { sent.push([z, t, o]); return true; }, live: { events: async () => [] }, adminReq: () => ({}), fetchRoster: async () => ({ riders: [{ riderId: 1, name: 'Ann' }] }), siteUrl: 'https://club.test', coachSystem: 'COACH', asMember: z => ({ z }) });
  assert.deepEqual(await plans.planTick(Date.parse(sunday)), [], 'not on a Sunday');
  assert.deepEqual(await plans.planTick(Date.parse('2026-11-02T03:00:00Z')), [], 'not before 6 in the morning');
  assert.deepEqual(await plans.planTick(Date.parse(monday)), ['plan-1']);
  assert.equal(sent.length, 1); assert.deepEqual([sent[0][0], sent[0][2].kind, sent[0][2].key], ['1', 'coach', 'plan:2026-11-02:1']);
  assert.match(sent[0][1], /Your plan for this week:\nTue: 60 min at 70% FTP/);
  assert.equal(JSON.parse(k.db['cg:plan:last']['1']).week, '2026-11-02');
  assert.deepEqual(await plans.planTick(Date.parse(tuesday)), [], 'nothing left to send');
  assert.ok(!JSON.stringify(k.seen[0]).includes('Ann'), 'the model does not get the name');
  // Budget used: the free coach rests, and a plan for a supporter carries on until 1.5x.
  await k.redis([['SET', 'cg:support:settings', JSON.stringify({ budget: 1, inPrice: 1000, outPrice: 0 })], ['HSET', 'cg:ai:usage', `${new Date().toISOString().slice(0, 7)}-01:in`, '2000000']]);
  assert.equal(await k.ai.available(false), false); assert.equal(await k.ai.available(true), false, 'cost 2000 is over 1.5x the budget');
});

test('the race-day briefing: one call for the whole line-up, sent once to the riders who said yes (with their own tip), and no names go to the model', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const k = kit({ answer: JSON.stringify({ team: 'Ride the first climb together and hold 4 W/kg.', riders: [{ ref: 'A', tip: 'Sit in for 20 minutes.' }, { ref: 'B', tip: 'Cover the attacks.' }, { ref: 'Z', tip: 'invented' }] }) }), sent = [];
  await k.redis([['HSET', 'cg:coach:consent', '11', 'y'], ['HSET', 'cg:coach:consent', '12', 'y']]);
  const riders = [{ riderId: 11, name: 'Ann Able', zpCategory: 'B', power: { wkg1200: 3.4 }, phenotype: { value: 'climber' } }, { riderId: 12, name: 'Bob Brown', zpCategory: 'C', power: { wkg1200: 3.1 } }, { riderId: 13, name: 'Cy Cole', zpCategory: 'C' }];
  const ev = { kind: 'ladder', id: 'm1', title: 'CRYO-GEN v Rocket', minutes: 60, riders: [{ zwid: '11', name: 'Ann Able', role: 'starter', answer: 'yes' }, { zwid: '12', name: 'Bob Brown', role: 'starter', answer: '' }, { zwid: '13', name: 'Cy Cole', role: 'starter', answer: 'yes' }, { zwid: '14', name: 'Dee', role: 'reserve' }] };
  const plans = createAiPlans({ redis: k.redis, HttpError: k.HttpError, memberFromRequest: () => null, ai: k.ai, coach: {}, support: k.support, notify: async (z, t, o) => { sent.push([z, t, o.key]); return true; }, live: { events: async () => [ev, { ...ev, id: 'far', minutes: 600 }] }, adminReq: () => ({}), fetchRoster: async () => ({ riders }), siteUrl: '', coachSystem: 'COACH', asMember: z => z });
  assert.equal((await plans.briefTick(Date.now())).length, 2);
  assert.deepEqual(sent.map(x => x[0]), ['11', '12'], 'only riders who said yes; the reserve and the far race are left out');
  assert.match(sent[0][1], /Briefing for CRYO-GEN v Rocket:\nRide the first climb together/); assert.match(sent[0][1], /For you: Sit in for 20 minutes\./);
  assert.match(sent[1][1], /For you: Cover the attacks\./); assert.ok(!/invented/.test(sent.map(x => x[1]).join()));
  assert.equal(k.seen.length, 1, 'one call for the race'); assert.ok(!/Ann|Bob|Cy/.test(JSON.stringify(k.seen[0])), 'no names to the model');
  assert.deepEqual(await plans.briefTick(Date.now()), [], 'once only');
  k.seen.length = 0; await k.redis([['HDEL', 'cg:brief:sent', 'ladder:m1']]); process.env.ANTHROPIC_API_KEY = '';
  assert.deepEqual(await plans.briefTick(Date.now()), [], 'nothing when the AI is off');
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

test('a briefing that cannot be read is given back to try again, and sends nothing', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const k = kit({ answer: 'sorry, no json here' }), sent = [];
  await k.redis([['HSET', 'cg:coach:consent', '11', 'y']]);
  const plans = createAiPlans({ redis: k.redis, HttpError: k.HttpError, memberFromRequest: () => null, ai: k.ai, coach: {}, support: k.support, notify: async (...a) => { sent.push(a); return true; }, live: { events: async () => [{ kind: 'drs', id: 's1', title: 'Stage 1', minutes: 50, riders: [{ zwid: '11', name: 'Ann', role: 'scorer' }] }] }, adminReq: () => ({}), fetchRoster: async () => ({ riders: [] }), coachSystem: '', asMember: z => z });
  assert.deepEqual(await plans.briefTick(Date.now()), []); assert.equal(sent.length, 0);
  assert.equal(JSON.parse(JSON.stringify(k.db['cg:brief:sent'] || {}))['drs:s1'], undefined, 'not marked as sent');
});

test('the weekly report: written on Monday from counts and titles only, posted once, with a plain fallback when the AI is off', async () => {
  const k = kit({ answer: 'A good week. To do: place two riders.' }), posts = [];
  const digest = async now => ({ week: '2026-11-02', needsAttention: 2, attentionTitles: ['ZRL · Every rider is on a team', 'Associate asks'], newMembers: 1, quiet: 3, supporters: 4, zrl: { round: 'R2', teams: 5, racing: 40, unplaced: 2 } });
  const staff = createAiStaff({ redis: k.redis, HttpError: k.HttpError, requireRole() {}, memberFromRequest: () => null, roleFromRequest: () => 'admin', ai: k.ai, zrl: {}, lifecycle: { quiet: async () => [] }, digest, discord: async (c, p) => { posts.push([c, p.content]); }, publicClub: async () => ({}), fetchRoster: async () => ({ riders: [] }), siteUrl: 'https://club.test' });
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  assert.deepEqual(await staff.runSchedule(Date.parse(sunday)), []); assert.equal(posts.length, 0);
  await staff.runSchedule(Date.parse(monday));
  assert.equal(posts.length, 1); assert.match(posts[0][1], /Weekly report\*\*\nA good week/);
  await staff.runSchedule(Date.parse(monday) + 3600000); assert.equal(posts.length, 1, 'once a week');
  const sent = JSON.stringify(k.seen[0].messages); assert.match(sent, /needsAttention/); assert.ok(!/@|Ann/.test(sent));
  process.env.ANTHROPIC_API_KEY = '';
  const plain = await staff.writeReport(Date.now(), 'staff', false);
  assert.equal(plain.via, 'plain'); assert.match(plain.text, /2 things need attention.*40 riders racing in 5 teams, 2 without a team.*4 supporters/);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

test('a draft for a quiet rider: warm, with the first name put back by the club, and only for someone who really is on the quiet list', async () => {
  const k = kit({ answer: 'Hi {name}, we have missed you! Fancy a social ride on Sunday?\n– the CRYO-GEN team' });
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const staff = createAiStaff({ redis: k.redis, HttpError: k.HttpError, requireRole() {}, memberFromRequest: () => null, roleFromRequest: () => 'admin', ai: k.ai, zrl: {}, lifecycle: { quiet: async () => [{ zwid: '7', name: 'Dee Dawson', days: 70, tier: 'full' }] }, digest: async () => ({}), discord: async () => {}, publicClub: async () => ({}), fetchRoster: async () => ({ riders: [] }) });
  const r = await staff.driftDraft('7');
  assert.match(r.draft, /^Hi Dee, we have missed you/); assert.match(r.note, /send it yourself/);
  assert.ok(!/Dee|Dawson/.test(JSON.stringify(k.seen[0])), 'the model never sees the name'); assert.match(k.seen[0].messages[0].content, /"weeksSinceLastRace":10/);
  await assert.rejects(() => staff.driftDraft('8'), /not on the quiet list/);
});

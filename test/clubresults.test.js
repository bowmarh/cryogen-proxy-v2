'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ ZWIFTRACING_API_KEY: 'zr-key' });
let app, world, mod;
const EVENT = { title: 'Club Ladder: CRYO vs ABC', time: Date.parse('2026-11-03T19:00:00Z') / 1000, type: 'RACE', results: [
  { riderId: 555, name: 'Not Ours', position: 1, positionInCategory: 1, category: 'B' },
  { riderId: 1001, name: 'Rider 1', position: 2, positionInCategory: 2, category: 'B', time: 1801.2 },
  { riderId: 1000, name: 'Rider 0', position: 5, positionInCategory: 1, category: 'A', time: 1820 },
] };
before(async () => { world = h.createWorld(); app = await h.startApp(world); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; world.zr = { status: 200, body: EVENT, seen: [] }; });

test('the event ID comes out of Zwift, ZwiftPower and ZwiftRacing.app links', () => {
  const r = require('../lib/clubresults')({ redis: async () => [], HttpError: Error, requireRole() {}, roleFromRequest() {}, memberFromRequest() {}, fetchZrResults() {}, clubRiders: async () => new Map() });
  assert.equal(r.eventIdOf('https://www.zwift.com/uk/events/view/5188741'), '5188741');
  assert.equal(r.eventIdOf('https://zwiftpower.com/events.php?zid=5188741'), '5188741');
  assert.equal(r.eventIdOf('https://www.zwiftracing.app/events/5188741'), '5188741');
  assert.equal(r.eventIdOf(' 5188741 '), '5188741');
  assert.equal(r.eventIdOf('hello'), '');
});

test('staff add an event; only CRYO-GEN riders are kept, best first; members see it, the public does not', async () => {
  const add = await app.post('/api/results/add', { event: 'https://www.zwift.com/events/view/5188741' }, { token: mod });
  assert.equal(add.status, 200, JSON.stringify(add.body)); assert.equal(add.body.fetched, true);
  assert.match(world.zr.seen[0].path, /\/api\/public\/results\/5188741$/); assert.equal(world.zr.seen[0].auth, 'zr-key');
  assert.deepEqual(add.body.event.riders.map(r => [r.zwid, r.pos, r.cat]), [['1001', 2, 'B'], ['1000', 5, 'A']]);
  assert.equal((await app.get('/api/results')).status, 401);
  const member = await app.get('/api/results', { token: await app.memberSession('1002') });
  assert.equal(member.status, 200); assert.equal(member.body.events[0].title, EVENT.title); assert.equal(member.body.queue, undefined, 'the queue is staff-only');
});

test('an event without results yet waits in the queue; riders cannot add events', async () => {
  world.zr = { status: 404, body: { message: 'not found' }, seen: [] };
  const r = await app.post('/api/results/add', { event: '7777777' }, { token: mod });
  assert.equal(r.body.queued, true);
  assert.equal((await app.get('/api/results', { token: mod })).body.queue[0].id, '7777777');
  assert.equal((await app.post('/api/results/add', { event: '7777777' }, { token: await app.memberSession('1002') })).status, 403, 'signed in, but not staff or a captain');
  assert.equal((await app.post('/api/results/add', { event: 'nope' }, { token: mod })).status, 400);
});

test('a Ladder match with a Zwift event link is picked up and fetched after the race by the scheduled job, one event per run', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c)), fetched = [];
  db['cg:ladder:matches'] = { m1: JSON.stringify({ teamName: 'CRYO Ladder', at: '2026-11-03T19:00:00Z', eventLink: 'https://www.zwift.com/events/view/111111' }), m2: JSON.stringify({ teamName: 'CRYO Ladder', at: '2026-11-03T20:00:00Z', eventLink: 'https://www.zwift.com/events/view/222222' }) };
  const r = require('../lib/clubresults')({ redis, HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, requireRole() {}, roleFromRequest() {}, memberFromRequest() {},
    fetchZrResults: async id => { fetched.push(id); return { title: `Race ${id}`, time: 1, results: [{ riderId: 1000, position: 3 }] }; }, clubRiders: async () => new Map([['1000', 'Rider 0']]) });
  const NOW = Date.parse('2026-11-04T10:00:00Z');
  assert.deepEqual(await r.runSchedule(NOW), ['Results: Race 111111 (1 of ours)']);
  assert.deepEqual(await r.runSchedule(NOW + 60000), ['Results: Race 222222 (1 of ours)']);
  assert.deepEqual(await r.runSchedule(NOW + 120000), [], 'nothing left, and fetched events are not queued again');
  assert.deepEqual(fetched, ['111111', '222222']);
});

test('a ZRL captain can add a race link; a rider who is not a captain cannot', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
  const r = require('../lib/clubresults')({ redis, HttpError, requireRole() {}, roleFromRequest: () => '', memberFromRequest: req => req.member,
    fetchZrResults: async id => ({ title: `Race ${id}`, time: 1, results: [{ riderId: 1000, position: 1 }] }), clubRiders: async () => new Map([['1000', 'Rider 0']]), isCaptain: async z => z === '9' });
  const ok = await r.routes['POST /api/results/add']({ member: { zwid: '9' } }, { event: '123456' });
  assert.equal(ok.fetched, true);
  await assert.rejects(() => r.routes['POST /api/results/add']({ member: { zwid: '5' } }, { event: '123457' }), /captains/);
  assert.equal((await r.routes['GET /api/results']({ member: { zwid: '9' } })).canAdd, true);
  assert.equal((await r.routes['GET /api/results']({ member: { zwid: '5' } })).canAdd, false);
});

test('the season leaderboard counts races, podiums and wins since 1 September; a rider sees their own results', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const r = require('../lib/clubresults')({ redis, HttpError: Error, requireRole() {}, roleFromRequest: () => '', memberFromRequest: req => req.member, fetchZrResults() {}, clubRiders: async () => new Map() });
  const ev = (id, iso, riders) => JSON.stringify({ id, title: `Race ${id}`, time: Date.parse(iso) / 1000, field: 50, riders });
  db['cg:results:events'] = {
    a: ev('a', '2026-09-10T19:00:00Z', [{ zwid: '1', name: 'Ann', catPos: 1, cat: 'B' }, { zwid: '2', name: 'Bo', catPos: 3, cat: 'B' }]),
    b: ev('b', '2026-10-10T19:00:00Z', [{ zwid: '1', name: 'Ann', catPos: 2, cat: 'B' }]),
    old: ev('old', '2026-08-20T19:00:00Z', [{ zwid: '2', name: 'Bo', catPos: 1, cat: 'B' }]),   // last season
  };
  const L = await r.leaderboard(Date.parse('2026-11-04T10:00:00Z'));
  assert.equal(L.since, '2026-09-01');
  assert.deepEqual(L.races.map(x => [x.name, x.races]), [['Ann', 2], ['Bo', 1]]);
  assert.deepEqual(L.wins.map(x => [x.name, x.wins]), [['Ann', 1]], 'last season does not count');
  assert.deepEqual(L.podiums.map(x => [x.name, x.podiums]), [['Ann', 2], ['Bo', 1]]);
  const mine = await r.routes['GET /api/me/results']({ member: { zwid: '2' } });
  assert.deepEqual(mine.results.map(x => x.id), ['a', 'old'], 'their whole history, newest first');
});

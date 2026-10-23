'use strict';
// Event check: a ZRL race's results (ZwiftRacing.app) matched to our teams and the captain's line-up for that race week.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => { delete process.env.ZWIFTRACING_API_KEY; app.close(); });

const TITLE = 'Zwift Racing League 26/27: Fast & Fresh : Open Shamrock League Division 4 - Race 2';
const result = (riderId, position, extra = {}) => ({ riderId, name: `R${riderId} [XYZ]`, category: 'B', time: 2400 + position, gap: position, position, positionInCategory: position, ...extra });
const check = (id = '5737438', token = admin) => app.get(`/api/zrl/event-check?id=${id}`, { token });

beforeEach(async () => {
  process.env.ZWIFTRACING_API_KEY = 'zr-secret-key';
  world.zr = { status: 200, seen: [], body: { eventId: '5737438', time: 1791912780, title: TITLE, type: 'Race', subType: 'Team Time Trial', distance: 29.9, results: [result(3033869, 1), result(1002, 3), result(777, 4)] } };
  app.world.db = {};
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 3 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Ventoux', region: 'eu', league: 'Shamrock', division: 'Division 4' }, { name: 'CRYO-GEN Mint', region: 'eu', league: 'Mint', division: 'Division 1' }] }, { token: admin });
  for (const [n, z, t] of [['Rider 2', '1002', 'cryo-gen-ventoux'], ['Ann Able', '4378027', 'cryo-gen-ventoux'], ['Bob Baker', '2436518', 'cryo-gen-mint']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
    await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
  }
  await app.post('/api/zrl/lineup', { week: 1, team: 'cryo-gen-ventoux', zwids: ['1002', '4378027'] }, { token: admin });
});

test('staff only; needs the key and a numeric id; their errors are explained', async () => {
  assert.equal((await check('5737438', null)).status, 401);
  assert.equal((await check('5737438', await app.memberSession('1002'))).status, 401);
  assert.equal((await check('abc')).status, 400);
  world.zr = { status: 429, body: { message: 'Too many', retryAfter: 41 }, seen: [] };
  let r = await check(); assert.equal(r.status, 429); assert.match(r.body.error, /one results request a minute.*41 seconds/);
  world.zr = { status: 401, body: { message: 'Unauthorized' }, seen: [] };
  assert.equal((await check()).status, 502);
  world.zr = { status: 200, body: '<!DOCTYPE html><html></html>', seen: [] };
  assert.equal((await check()).status, 404);
  delete process.env.ZWIFTRACING_API_KEY;
  r = await check(); assert.equal(r.status, 503); assert.match(r.body.error, /ZWIFTRACING_API_KEY/);
});

test('the title gives the race week; our riders are found by Zwift ID with how they finished and whether they were picked', async () => {
  const r = await check('5737438', mod);
  assert.equal(r.status, 200);
  assert.deepEqual(world.zr.seen, [{ path: '/api/public/results/5737438', auth: 'zr-secret-key' }]);
  assert.deepEqual(r.body.parsed, { league: 'Shamrock', division: 4, race: 2 });
  assert.equal(r.body.week, 1, 'race 2 is week index 1');
  assert.equal(r.body.event.finishers, 3);
  assert.deepEqual(r.body.teams.map(t => t.name), ['CRYO-GEN Ventoux'], 'Mint is in another division: not in this event');
  const t = r.body.teams[0];
  assert.deepEqual(t.raced.map(x => [x.name, x.position, x.picked]), [['Rider 2', 3, true]]);
  assert.deepEqual(t.missing, ['Ann Able'], 'picked, but not in the results');
  assert.ok(!JSON.stringify(r.body).includes('zr-secret-key'));
});

test('a team the title names whose whole line-up is missing is still listed; a race beyond the round has no week; picks that were not made are not blamed', async () => {
  world.zr.body.results = [result(3033869, 1)];
  let r = await check();
  assert.deepEqual(r.body.teams.map(t => [t.name, t.raced.length, t.missing]), [['CRYO-GEN Ventoux', 0, ['Rider 2', 'Ann Able']]]);
  world.zr.body.title = TITLE.replace('Race 2', 'Race 9'); world.zr.body.results = [result(1002, 2)];
  r = await check();
  assert.equal(r.body.week, null); assert.deepEqual(r.body.teams[0].raced.map(x => x.picked), [false], 'no week, no line-up to compare with');
  world.zr.body.title = 'Some other event'; world.zr.body.results = [result(1002, 2), result(2436518, 5)];
  r = await check();
  assert.equal(r.body.parsed, null);
  assert.deepEqual(r.body.teams.map(t => t.name).sort(), ['CRYO-GEN Mint', 'CRYO-GEN Ventoux'], 'without a title match, any team with a finisher counts');
});

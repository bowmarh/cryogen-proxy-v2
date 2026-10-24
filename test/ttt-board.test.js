'use strict';
// TTT Week: sign-ups from the club's Google Form sheet come in as real sign-ups, auto-allocation can be previewed, and a rider can run last week back in one tap.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());

const COLS = ['CAT', 'RIDERS LEFT TO ALLOCATE', 'AVAILABLE', 'PRACTICE OR RACE?', 'REGION', 'DOUBLE UP?'];
const YES = 'I am available this week', NO = 'I am not available this week', COMP = 'Competetive (captain decides how the team rides)', MEH = 'Not bothered';
const view = async (token = admin) => (await app.get('/api/ttt', { token })).body;
const imp = (body, token = admin) => app.post('/api/ttt/import-sheet', body, { token });

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  world.sheet = { first: 'TEAM LIST', html: false, tabs: { 'TEAM LIST': { cols: COLS, rows: [
    ['-', 'Rider 0', YES, COMP, '-', 'No'],
    ['B', 'Rider 1', YES, MEH, 'EU', 'Yes'],
    ['-', 'Newcomer Nigel', YES, COMP, '-', 'No'],
    ['-', 'Rider 3', NO, MEH, '-', 'No'],
    ['-', 'Rider 0', YES, MEH, '-', 'Yes'],            // a later row for the same rider wins
    ['-', '-', '', '', '', ''],
  ] } } };
  assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(10) }, { token: admin })).status, 200);
});

test('importing is staff only; the preview matches riders to the roster and changes nothing', async () => {
  assert.equal((await imp({}, null)).status, 401);
  assert.equal((await imp({}, await app.memberSession('1002'))).status, 401);
  const p = (await imp({})).body.preview;
  assert.deepEqual(p.counts, { total: 4, new: 4, exists: 0, unmatched: 1, unavailable: 1 });
  const r0 = p.rows.find(r => r.name === 'Rider 0');
  assert.deepEqual([r0.zwid, r0.cat, r0.style, r0.doubleUp, r0.available], ['1000', 'A', 'casual', true, true], 'matched to the roster (category too), last row wins');
  const nigel = p.rows.find(r => r.name === 'Newcomer Nigel');
  assert.deepEqual([nigel.zwid, nigel.style], ['', 'race'], 'not in the roster: still listed, no ID');
  assert.equal(p.rows.find(r => r.name === 'Rider 1').cat, 'B', 'a category on the sheet is kept');
  assert.equal(p.rows.find(r => r.name === 'Rider 3').available, false);
  assert.equal((await view()).signups.length, 0, 'a preview writes nothing');
});

test('applying imports the new riders as sign-ups and never overwrites an in-app sign-up', async () => {
  await app.post('/api/ttt/signup', { name: 'Rider 1', zwid: '1001', cat: 'C', style: 'race', available: true, preferred: [] });
  const r = await imp({ apply: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 3, 'Rider 1 already signed up in the app');
  const v = await view();
  assert.equal(v.signups.length, 4);
  const one = v.signups.find(s => s.name === 'Rider 1');
  assert.deepEqual([one.cat, one.style], ['C', 'race'], 'the in-app answer stands');
  assert.equal(v.signups.find(s => s.name === 'Rider 3').available, false);
  assert.equal((await imp({ apply: true })).body.imported, 0, 'a second import adds nothing');
  // and they can now be allocated like any other sign-up
  const a = await app.post('/api/ttt/auto-assign', {}, { token: admin });
  assert.ok(Object.keys(a.body.assign).length >= 2);
});

test('a sheet without a rider column or one that is not shared is explained', async () => {
  world.sheet.tabs['TEAM LIST'] = { cols: ['Foo', 'Bar'], rows: [['1', '2']] };
  assert.equal((await imp({})).status, 422);
  world.sheet.html = true;
  assert.equal((await imp({})).status, 502);
});

test('the auto-allocation preview shows the plan and changes nothing; applying it places the riders', async () => {
  await imp({ apply: true });
  const before = await view();
  const pre = (await app.post('/api/ttt/auto-assign', { preview: true }, { token: admin })).body;
  assert.ok(pre.plan.length >= 3 && pre.plan.every(x => x.name && x.teams.length));
  assert.ok(pre.summary.placed >= 3);
  assert.deepEqual((await view()).assign, before.assign, 'nothing was placed by the preview');
  const done = (await app.post('/api/ttt/auto-assign', {}, { token: admin })).body;
  assert.equal(Object.keys(done.assign).length, pre.plan.length);
});

test('run it back signs a rider up again with their last available settings, and tells them what it will do', async () => {
  const ann = await app.memberSession('4378027', { name: 'Ann Able' });
  const ids = (await view()).week.teams.map(t => t.id);
  assert.equal((await app.post('/api/ttt/repeat', {}, { token: ann })).status, 404, 'nothing to copy yet');
  assert.equal((await app.post('/api/ttt/repeat', {}, { token: null })).status, 401);
  await app.post('/api/ttt/signup', { cat: 'C', style: 'race', doubleUp: true, captain: true, preferred: [ids[0], ids[1], 'gone-team'], available: true, comments: 'private' }, { token: ann });
  // next week: the sign-ups are cleared, the settings are remembered
  await app.post('/api/ttt/new-week', { date: h.ymd(17) }, { token: admin });
  const mine = (await app.get('/api/ttt/mine', { token: ann })).body;
  assert.equal(mine.signup, null);
  assert.deepEqual([mine.repeat.style, mine.repeat.doubleUp, mine.repeat.captain, mine.repeat.same], ['race', true, true, false]);
  assert.equal(mine.repeat.preferred.length, 2);
  assert.equal((await app.post('/api/ttt/repeat', {}, { token: ann })).status, 200);
  const s = (await view()).signups.find(x => x.zwid === '4378027');
  assert.deepEqual([s.available, s.style, s.doubleUp, s.captain, s.cat], [true, 'race', true, true, 'C']);
  assert.deepEqual(s.preferred, ids.slice(0, 2), 'only teams that still exist');
  assert.equal(s.comments, '', 'comments are not carried over');
  assert.equal((await app.get('/api/ttt/mine', { token: ann })).body.repeat.same, true);
  await app.post('/api/ttt/status', { open: false }, { token: admin });
  assert.equal((await app.post('/api/ttt/repeat', {}, { token: ann })).status, 409, 'closed');
});

test('the sign-up announcements point riders at run it back', async () => {
  await app.post('/api/ttt/new-week', { date: h.ymd(24) }, { token: admin });
  assert.ok(app.world.discord.some(p => /Run it back/.test(JSON.stringify(p.body))), 'the weekly announcement mentions it');
});

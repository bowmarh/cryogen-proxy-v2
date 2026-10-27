'use strict';
// Duplicate and inactive members: found and reported (staff only); acting on them uses the existing member tools.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const DAY = 86400000, sec = ms => Math.floor(ms / 1000);
const rider = (id, name, extra = {}) => ({ riderId: id, name, country: 'gb', zpCategory: 'C', race: { finishes: 5, ...extra } });
const member = (id, name, extra = {}) => ({ id: 5000 + id % 1000, zwift_id: String(id), name, status: 'active', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0', ...extra });
before(async () => {
  world = h.createWorld({ riders: [
    rider(8001, 'Sam Rivers [CRYO-GEN]', { last: { date: sec(Date.now() - 5 * DAY) } }),      // the current account
    rider(8002, 'Sam Rivers', { last: { date: sec(Date.now() - 400 * DAY) } }),               // an old account, same name
    rider(8003, 'Pat Quiet', { last: { date: sec(Date.now() - 300 * DAY) } }),                // in the club, raced long ago
    rider(8004, 'Never Raced', { finishes: 0 }),
    rider(8005, 'Busy Bee', { last: { date: sec(Date.now() - 2 * DAY) } }),
  ] });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(() => {
  world.members = [
    member(8001, 'Sam Rivers'), member(8002, 'Sam Rivers', { status: 'left' }), member(8003, 'Pat Quiet'), member(8004, 'Never Raced'), member(8005, 'Busy Bee'),
    member(8006, 'Gone Away'),                                    // active in WordPress, not in the Zwift club
    member(8007, 'Newbie Assoc', { tier: 'associate' }),          // an associate need not be in the club
    member(8008, 'Twice Listed'), member(8008, 'Twice Listed', { tier: 'associate' }),   // WordPress holds the Zwift ID twice
    { id: 9000, zwift_id: '', name: 'No Id Person', status: 'active', tier: 'full' },
    { id: 9001, zwift_id: 'n/a', name: 'Bad Id Person', status: 'active', tier: 'associate' },
  ];
});
const tidy = (token = admin) => app.get('/api/members/tidy', { token });

test('staff only', async () => {
  assert.equal((await tidy(null)).status, 401);
  assert.equal((await tidy(await app.memberSession('8005', { name: 'Busy Bee' }))).status, 401);
  assert.equal((await tidy()).status, 200);
});

test('the same name under two Zwift IDs is grouped, with a suggestion to keep the active club account', async () => {
  const d = (await tidy()).body.duplicates.sameName;
  const sam = d.find(g => g.key === 'sam rivers');
  assert.ok(sam, 'a [CRYO-GEN] tag does not hide a duplicate');
  assert.deepEqual(sam.members.map(m => m.zwid), ['8001', '8002']);
  assert.equal(sam.keep, '8001');
  assert.deepEqual([sam.members[0].inClub, sam.members[0].status, sam.members[1].status], [true, 'active', 'left']);
  assert.ok(sam.members[0].daysSinceRace <= 6 && sam.members[1].daysSinceRace >= 399);
  assert.equal(d.some(g => g.key === 'pat quiet'), false, 'one account is not a duplicate');
});

test('WordPress records held twice or with no usable Zwift ID are listed to fix on the website', async () => {
  const d = (await tidy()).body.duplicates;
  assert.deepEqual(d.sameId.map(x => [x.zwid, x.records.length]), [['8008', 2]]);
  assert.deepEqual(d.noId.map(x => x.name).sort(), ['Bad Id Person', 'No Id Person']);
  assert.equal((await tidy()).body.counts.noId, 2);
});

test('inactive members: not in the club (associates excepted), never raced, and how long since the last race', async () => {
  const body = (await tidy()).body, by = Object.fromEntries(body.inactive.map(i => [i.zwid, i]));
  assert.deepEqual(by['8006'].reasons, ['not-in-club']);
  assert.equal(by['8007'], undefined, 'an associate who is not in the club is not flagged');
  assert.ok(by['8004'].reasons.includes('never-raced'));
  assert.ok(by['8003'].reasons.includes('last-raced') && by['8003'].daysSinceRace >= 299);
  assert.equal(by['8002'], undefined, 'a member who has already left is not listed again');
  assert.equal(body.inactive.find(i => i.reasons.includes('last-raced')).zwid, '8003', 'the one who raced longest ago comes first');
  assert.deepEqual([body.counts.notInClub, body.counts.neverRaced], [1, 1]);
});

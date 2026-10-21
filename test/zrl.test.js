'use strict';
// ZRL round sign-up: rounds, teams, rider sign-up, demand per time zone, and the schedule.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left'); // every test rider can sign in
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; delete process.env.REQUIRE_MEMBER_LOGIN; });

const view = token => app.get('/api/zrl', { token }).then(r => r.body);
const newRound = (extra = {}, token = admin) => app.post('/api/zrl/round', { name: 'Round 2 · Team Tempo', start: '2026-11-17', closes: h.ymd(10), ...extra }, { token });
const setTeams = (teams, token = admin) => app.post('/api/zrl/teams', { teams }, { token });
const signup = (body, token) => app.post('/api/zrl/signup', body, { token });
const TEAMS = [
  { name: 'CRYO Ice', region: 'eu', slot: 'Tue 19:00 UK', captain: '1002' },
  { name: 'CRYO Frost', region: 'eu', slot: 'Tue 20:00 UK', captain: '' },
  { name: 'CRYO Stateside', region: 'am', slot: 'Tue 20:00 NY', captain: '' },
];
const posts = channel => app.world.discord.filter(p => p.channel === channel);

test('before any round exists: an empty page, and nothing can be changed without a login', async () => {
  const v = await view();
  assert.equal(v.round, null);
  assert.equal((await signup({ regions: ['eu'], name: 'Gary' })).status, 409, 'no round yet');
  for (const [path, body] of [['/api/zrl/round', { name: 'R', start: '2026-11-17' }], ['/api/zrl/teams', { teams: [] }], ['/api/zrl/status', { open: false }]]) {
    assert.equal((await app.post(path, body)).status, 401, path);
    assert.equal((await app.post(path, body, { token: await app.memberSession('1002') })).status, 401, `${path} (member)`);
  }
});

test('starting a round: validated, announced on Discord, and the previous round is archived with its teams carried over', async () => {
  assert.equal((await newRound({ name: '' })).status, 400);
  assert.equal((await newRound({ start: 'soon' })).status, 400);
  assert.equal((await newRound({ closes: '2026-13-45' })).status, 400);
  assert.equal((await newRound({}, mod)).status, 200, 'a moderator can start a round');
  const v = await view();
  assert.equal(v.round.name, 'Round 2 · Team Tempo');
  assert.equal(v.round.open, true);
  assert.equal(v.round.weeks, 6);
  assert.equal(v.round.rosterSize, 10);
  assert.equal(v.round.racing, 5);
  assert.ok(v.round.closesAt);
  assert.equal(posts('public').length, 1, 'the club is told sign-ups are open');
  assert.match(posts('public')[0].body.content, /sign-ups are open/);
  assert.match(posts('public')[0].body.content, /Asia-Pacific/, 'and the call to grow Asia-Pacific races is there');
  assert.equal((await newRound()).status, 409, 'the same start date twice');

  await setTeams(TEAMS);
  await signup({ name: 'Gary', regions: ['eu'] });
  assert.equal((await newRound({ name: 'Round 3', start: '2027-01-12' })).status, 200);
  const next = await view();
  assert.equal(next.round.name, 'Round 3');
  assert.deepEqual(next.round.teams.map(t => t.name), TEAMS.map(t => t.name), 'teams carry over');
  assert.deepEqual(next.signups, [], 'riders sign up afresh');
  assert.deepEqual(next.archive, ['2026-11-17']);
  const archived = JSON.parse(app.world.db['cg:zrl:archive']['2026-11-17']);
  assert.equal(archived.signups[0].name, 'Gary', 'the old sign-ups are kept');
});

test('teams: staff set them; names, time zones and captains are checked; captains are named from the roster', async () => {
  await newRound();
  assert.equal((await setTeams([{ name: 'A', region: 'eu' }, { name: 'a', region: 'am' }])).status, 400, 'two teams with the same name');
  assert.equal((await setTeams([{ name: 'A', region: 'mars' }])).status, 400);
  assert.equal((await setTeams([{ name: 'A', region: 'eu', captain: 'rick' }])).status, 400);
  assert.equal((await setTeams([{ name: '', region: 'eu' }])).status, 400);
  assert.equal((await setTeams(Array.from({ length: 26 }, (_, i) => ({ name: `T${i}`, region: 'eu' })))).status, 400);
  assert.equal((await setTeams(TEAMS)).status, 200);
  const t = (await view()).round.teams;
  assert.deepEqual(t.map(x => [x.name, x.region, x.slot]), [['CRYO Ice', 'eu', 'Tue 19:00 UK'], ['CRYO Frost', 'eu', 'Tue 20:00 UK'], ['CRYO Stateside', 'am', 'Tue 20:00 NY']]);
  assert.equal(t[0].captain, '1002');
  assert.equal(t[0].captainName, 'Rider 2', 'the captain is shown by name');
});

test('a rider signs up: category from their profile, time zones required, updating keeps their place', async () => {
  await newRound(); await setTeams(TEAMS);
  const r1 = await app.memberSession('1001'); // roster category B
  assert.equal((await signup({ regions: [] }, r1)).status, 400, 'at least one time zone');
  assert.equal((await signup({ regions: ['mars'] }, r1)).status, 400);
  assert.equal((await signup({ name: 'Someone Else', zwid: '999', regions: ['eu', 'ap', 'eu'], captain: true, comments: 'Tuesdays only' }, r1)).status, 200);
  await signup({ regions: ['am'] }, await app.memberSession('1003'));
  let v = await view(admin);
  const mine = v.signups.find(s => s.name === 'Rider 1');
  assert.equal(mine.zwid, '1001', 'recorded as the signed-in rider, whatever the request said');
  assert.equal(mine.cat, 'B', 'category taken from their profile');
  assert.deepEqual(mine.regions, ['eu', 'ap'], 'duplicates dropped');
  assert.equal(mine.captain, true);
  assert.ok(!v.signups.some(s => s.name === 'Someone Else'));

  await signup({ regions: ['eu'], cat: 'C' }, r1);
  v = await view(admin);
  assert.deepEqual(v.signups.map(s => s.name), ['Rider 1', 'Rider 3'], 'still first in the queue after updating');
  assert.equal(v.signups[0].cat, 'C', 'a rider can correct their category');
  assert.deepEqual(v.signups[0].regions, ['eu']);
});

test('opting out is one click and needs no time zone; withdrawing removes the sign-up', async () => {
  await newRound();
  const r1 = await app.memberSession('1001');
  assert.equal((await signup({ in: false }, r1)).status, 200);
  assert.equal((await view()).signups[0].in, false);
  assert.equal((await view()).demand.riders, 0, 'not racing is not counted as demand');
  await signup({ regions: ['eu'] }, r1);
  assert.equal((await view()).demand.riders, 1);
  assert.equal((await app.post('/api/zrl/withdraw', {}, { token: r1 })).status, 200);
  assert.deepEqual((await view()).signups, []);
});

test('comments and Zwift IDs are staff-only; the public sees names, category and time zones', async () => {
  await newRound();
  await signup({ regions: ['eu'], comments: 'private note' }, await app.memberSession('1001'));
  const pub = await view();
  assert.deepEqual(Object.keys(pub.signups[0]).sort(), ['captain', 'cat', 'in', 'key', 'name', 'regions']);
  assert.ok(!JSON.stringify(pub).includes('private note'));
  assert.equal((await view(admin)).signups[0].comments, 'private note');
});

test('a closed round refuses sign-ups; staff can reopen it; guests follow REQUIRE_MEMBER_LOGIN', async () => {
  await newRound();
  assert.equal((await signup({ name: 'Guest Gary', regions: ['eu'] })).status, 200, 'guests can by default');
  process.env.REQUIRE_MEMBER_LOGIN = '1';
  assert.equal((await signup({ name: 'Guest Gary', regions: ['eu'] })).status, 401);
  assert.equal((await signup({ regions: ['eu'] }, await app.memberSession('1001'))).status, 200);
  delete process.env.REQUIRE_MEMBER_LOGIN;
  assert.equal((await app.post('/api/zrl/status', { open: false })).status, 401);
  assert.equal((await app.post('/api/zrl/status', { open: false }, { token: mod })).status, 200);
  const closed = await signup({ regions: ['eu'] }, await app.memberSession('1002'));
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /closed/);
  await app.post('/api/zrl/status', { open: true }, { token: admin });
  assert.equal((await signup({ regions: ['eu'] }, await app.memberSession('1002'))).status, 200);
});

test('demand per time zone shows where riders are short, including a zone with no team yet', async () => {
  await newRound(); await setTeams(TEAMS);
  const ride = async (zwid, regions) => signup({ regions }, await app.memberSession(zwid));
  await ride('1000', ['eu']); await ride('1001', ['eu', 'am']); await ride('1002', ['ap']); await ride('1003', ['ap']); await ride('1004', ['ap']);
  const d = (await view()).demand;
  const by = Object.fromEntries(d.regions.map(r => [r.id, r]));
  assert.deepEqual([by.eu.riders, by.eu.teams, by.eu.places], [2, 2, 20]);
  assert.deepEqual([by.am.riders, by.am.teams, by.am.places], [1, 1, 10]);
  assert.deepEqual([by.ap.riders, by.ap.teams, by.ap.places], [3, 0, 0], 'riders want Asia-Pacific but no team exists yet');
  assert.equal(d.riders, 5, 'each rider counted once overall, though the choice of zones overlaps');
  assert.deepEqual(d.cats, { A: 1, B: 2, C: 1, D: 1, E: 0 });
});

test('schedule: a reminder 24 hours before close, then sign-ups close by themselves; each fires once', async () => {
  const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const setRound = patch => { const r = JSON.parse(app.world.db['cg:zrl:round']); app.world.db['cg:zrl:round'] = JSON.stringify({ ...r, ...patch }); };
  await newRound(); await setTeams(TEAMS);
  await signup({ regions: ['ap'] }, await app.memberSession('1001'));
  app.world.discord.length = 0;

  assert.deepEqual((await tick()).body.ran, [], 'nothing yet: the close is days away');
  setRound({ closesAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString() });
  assert.deepEqual((await tick()).body.ran, ['zrl-reminder']);
  assert.match(posts('public')[0].body.content, /close in 24 hours/);
  assert.match(posts('public')[0].body.content, /Asia-Pacific.*1 rider/s, 'the reminder says where riders are wanted');
  assert.deepEqual((await tick()).body.ran, [], 'the reminder is not repeated');

  setRound({ closesAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual((await tick()).body.ran, ['zrl-close']);
  assert.equal((await view()).round.open, false);
  assert.ok(posts('public').some(p => /closed/.test(p.body.content)));
  assert.ok(posts('admin').some(p => /Form the teams/.test(p.body.content)), 'admins are told it is time to form teams');
  assert.deepEqual((await tick()).body.ran, [], 'and it closes only once');
});

test('a round with no close date never closes by itself', async () => {
  await newRound({ closes: '' });
  const tick = await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.deepEqual(tick.body.ran, []);
  assert.equal((await view()).round.open, true);
});

test('names with markdown or mentions cannot break or ping on Discord', async () => {
  await newRound({ name: '@everyone **Round**' });
  for (const p of app.world.discord) assert.deepEqual(p.body.allowed_mentions, { parse: [] });
  assert.ok(!/\*\*Round\*\*/.test(posts('public')[0].body.content.replace(/^🏁 \*\*ZRL /, '').replace(/\*\*: sign-ups.*/s, '')), 'the round name is escaped');
});

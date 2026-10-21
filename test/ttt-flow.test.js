'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => {
  app = await h.startApp(h.createWorld());
  admin = await app.login('admin');
  mod = await app.login('mod');
});
after(() => app.close());

const WEEK = () => h.ymd(10);
beforeEach(async () => {
  app.world.db = {};
  app.world.discord.length = 0;
  assert.equal((await app.post('/api/ttt/new-week', { date: WEEK() }, { token: admin })).status, 200);
});

const view = async (token) => (await app.get('/api/ttt', { token })).body;
const signup = (name, extra = {}, token) => app.post('/api/ttt/signup', { name, ...extra }, { token });
const assign = (name, teams, token = admin) => app.post('/api/ttt/assign', { name, teams }, { token });
const teamIds = async () => (await view(admin)).week.teams.map(t => t.id);
// Replace the week's teams with small ones, so fullness is easy to reach.
async function smallTeams(...maxes) {
  const teams = maxes.map((max, i) => ({ name: `Team ${i + 1}`, level: 'Latte', zone: `Zone ${i + 1}`, max }));
  assert.equal((await app.post('/api/ttt/teams', { teams }, { token: admin })).status, 200);
  return teamIds();
}

test('only staff can start a week, and the date must be valid and new', async () => {
  assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(20) })).status, 401);
  assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(20) }, { token: await app.memberSession('1002') })).status, 401);
  assert.equal((await app.post('/api/ttt/new-week', { date: 'next friday' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/ttt/new-week', { date: WEEK() }, { token: admin })).status, 409, 'same week twice');
  const week = (await view()).week;
  assert.equal(week.open, true);
  assert.equal(week.published, false);
  assert.ok(week.closesAt, 'a future week gets an automatic close time');
  assert.equal(week.teams.length, 9);
  assert.ok(week.teams.every(t => t.max === 6), 'default team size limit is 6');
});

test('sign-up: validation, picks filtered to real teams, update keeps queue place', async () => {
  const [t1] = await teamIds();
  assert.equal((await signup('')).status, 400);
  assert.equal((await signup('G', { comments: 'x'.repeat(301) })).status, 400);
  assert.equal((await signup('Gary', { preferred: [t1, 'not-a-team'], cat: 'Z', style: 'weird' })).status, 200);
  const first = (await view(admin)).signups[0];
  assert.deepEqual(first.preferred, [t1]);
  assert.equal(first.cat, '');
  assert.equal(first.style, 'casual');
  await signup('Zed');
  await signup('Gary', { comments: 'updated' });
  const list = (await view(admin)).signups;
  assert.deepEqual(list.map(s => s.name), ['Gary', 'Zed'], 'Gary keeps his place in the queue after updating');
  assert.equal(list[0].comments, 'updated');
});

test('closed weeks refuse sign-ups, and status changes are staff only', async () => {
  assert.equal((await app.post('/api/ttt/status', { open: false })).status, 401);
  assert.equal((await app.post('/api/ttt/status', { open: false }, { token: mod })).status, 200);
  assert.equal((await signup('Late Larry')).status, 409);
  await app.post('/api/ttt/status', { open: true }, { token: admin });
  assert.equal((await signup('Late Larry')).status, 200);
});

test('comments are staff-only and line-ups stay hidden until published', async () => {
  const [t1] = await teamIds();
  await signup('Gary', { comments: 'private note', captain: true });
  await assign('Gary', [t1]);
  const pub = await view();
  assert.equal(pub.signups[0].comments, undefined);
  assert.deepEqual(pub.assign, {});
  assert.deepEqual(pub.captains, {});
  assert.equal((await view(admin)).signups[0].comments, 'private note');
  assert.deepEqual((await view(admin)).assign.gary, [t1]);

  await app.post('/api/ttt/status', { published: true }, { token: admin });
  const after = await view();
  assert.deepEqual(after.assign.gary, [t1]);
  assert.equal(after.signups[0].comments, undefined, 'comments stay private after publishing');
});

test('manual assignment rules', async () => {
  const [t1, t2, t3] = await teamIds();
  await signup('Gary');
  assert.equal((await assign('Gary', [t1], undefined)).status, 200);
  assert.equal((await assign('Gary', [t1], null)).status, 401, 'no login');
  assert.equal((await assign('Nobody', [t1])).status, 404);
  assert.equal((await assign('Gary', ['nope'])).status, 400);
  assert.equal((await assign('Gary', [t1, t2, t3])).status, 400, 'at most 2 teams');
  assert.equal((await assign('Gary', [t1, t2])).status, 200);
  assert.equal((await assign('Gary', [])).status, 200);
  assert.deepEqual((await view(admin)).assign, {});
});

test('auto-assign respects team size and availability, and never moves manual placements', async () => {
  const ids = await teamIds();
  const names = Array.from({ length: 14 }, (_, i) => `Rider${String(i).padStart(2, '0')}`);
  for (const [i, n] of names.entries()) await signup(n, { cat: ['A', 'B', 'C'][i % 3], available: i !== 3, preferred: [ids[i % 3]], captain: i % 2 === 0 });
  assert.equal((await assign('Rider05', [ids[8]])).status, 200); // manual: leave alone
  const r = await app.post('/api/ttt/auto-assign', {}, { token: admin });
  assert.equal(r.status, 200);
  const a = (await view(admin)).assign;
  assert.deepEqual(a.rider05, [ids[8]], 'manual placement untouched');
  assert.equal(a.rider03, undefined, 'unavailable rider is not placed');
  const week = (await view(admin)).week;
  for (const t of week.teams) {
    const n = Object.values(a).filter(x => x.includes(t.id)).length;
    assert.ok(n <= t.max, `${t.name} has ${n} riders, max ${t.max}`);
  }
  assert.ok(Object.values(a).every(x => x.length >= 1 && x.length <= 2));
  assert.ok(r.body.summary, 'a summary is returned');
  for (const t of week.teams) {
    const inTeam = Object.values(a).some(x => x.includes(t.id));
    if (inTeam) assert.ok(week.captains[t.id] || r.body.summary.noCaptain.includes(t.name), `${t.name} has a captain or is listed without one`);
  }
});

test('waitlist: late sign-ups queue when teams are full, and move up when someone withdraws', async () => {
  const [solo] = await smallTeams(2);
  for (const n of ['Anna', 'Ben']) { await signup(n, { preferred: [solo] }); await assign(n, [solo]); }
  await app.post('/api/ttt/status', { published: true }, { token: admin });
  app.world.discord.length = 0;

  await signup('Cara', { preferred: [solo] });
  await signup('Dan', { preferred: [solo] });
  let v = await view();
  assert.deepEqual(v.waitlist, ['Cara', 'Dan']);
  assert.deepEqual(v.assign.cara, undefined);
  assert.ok(app.world.discord.some(p => p.channel === 'admin' && /waitlist/i.test(p.body.content)), 'admins are told about the waitlist');

  await app.post('/api/ttt/withdraw', { name: 'Anna' });
  v = await view();
  assert.deepEqual(v.assign.cara, [solo], 'first in the queue moves up');
  assert.deepEqual(v.waitlist, ['Dan']);
  assert.ok(app.world.discord.some(p => p.channel === 'public' && /waitlist/i.test(p.body.content)), 'the club is told');

  // updating a sign-up does not lose your place in the queue
  await signup('Dan', { preferred: [solo], comments: 'still keen' });
  assert.deepEqual((await view()).waitlist, ['Dan']);
});

test('captains: staff pick from the team; a leaving captain is replaced by another volunteer', async () => {
  const [t1] = await smallTeams(4);
  await signup('Cap', { captain: true }); await signup('Vol', { captain: true }); await signup('Plain');
  for (const n of ['Cap', 'Vol', 'Plain']) await assign(n, [t1]);
  assert.equal((await app.post('/api/ttt/captain', { team: t1, name: 'Cap' })).status, 401);
  assert.equal((await app.post('/api/ttt/captain', { team: 'nope', name: 'Cap' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/ttt/captain', { team: t1, name: 'Stranger' }, { token: admin })).status, 400, 'not in that team');
  assert.equal((await app.post('/api/ttt/captain', { team: t1, name: 'Cap' }, { token: admin })).status, 200);
  assert.equal((await view(admin)).captains[t1], 'cap');
  await app.post('/api/ttt/status', { published: true }, { token: admin });
  await app.post('/api/ttt/withdraw', { name: 'Cap' });
  assert.equal((await view()).captains[t1], 'vol', 'the other volunteer takes over');
  assert.equal((await app.post('/api/ttt/captain', { team: t1, name: '' }, { token: admin })).status, 200);
  assert.equal((await view(admin)).captains[t1], undefined, 'captain can be cleared');
});

test('results: validated, staff-only, public once entered, and editable after rollover', async () => {
  const [t1, t2] = await teamIds();
  const weekId = WEEK();
  const post = (results, token = admin) => app.post('/api/ttt/results', { weekId, results }, { token });
  assert.equal((await post({ [t1]: { time: '24:31' } }, null)).status, 401);
  assert.equal((await post({ [t1]: { time: 'fast' } })).status, 400);
  assert.equal((await post({ [t1]: { position: 5, of: 3 } })).status, 400, 'position beyond number of teams');
  assert.equal((await post({ [t1]: { link: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await post({ [t1]: { time: '24:31', position: 2, of: 9 }, [t2]: { dnf: true } })).status, 200);
  const res = (await view()).week.results;
  assert.equal(res[t1].time, '24:31');
  assert.equal(res[t1].position, 2);
  assert.equal(res[t2].dnf, true);

  // next week starts, then results for the finished week are corrected in the archive
  await app.post('/api/ttt/new-week', { date: h.ymd(17) }, { token: admin });
  assert.equal((await post({ [t1]: { time: '23:59', position: 1, of: 9 } })).status, 200);
  const archived = (await app.get(`/api/ttt/archive?id=${weekId}`)).body;
  assert.equal(archived.week.results[t1].time, '23:59');
  assert.equal((await app.get('/api/ttt/archive?id=1999-01-01')).status, 404);
});

test('My TTT: each state a rider can be in', async () => {
  const [t1] = await smallTeams(2);
  const me = await app.memberSession('1002');
  const mine = async (token = me) => (await app.get('/api/ttt/mine', { token })).body;

  assert.equal((await app.get('/api/ttt/mine')).status, 401);
  assert.equal((await app.get('/api/ttt/mine', { token: admin })).status, 401, 'staff tokens are not member sessions');

  let m = await mine();
  assert.equal(m.signup, null, 'not signed up yet');
  assert.deepEqual(m.teams, []);

  await app.post('/api/ttt/signup', { preferred: [t1], style: 'race', captain: true }, { token: me });
  m = await mine();
  assert.deepEqual(m.signup.preferred, ['Team 1']);
  assert.equal(m.signup.captain, true);
  assert.deepEqual(m.teams, [], 'no team shown before line-ups are published');

  await signup('Mate', { captain: true });
  await assign('Rider 2', [t1]); await assign('Mate', [t1]);
  await app.post('/api/ttt/captain', { team: t1, name: 'Mate' }, { token: admin });
  m = await mine();
  assert.deepEqual(m.teams, [], 'still hidden: not published');
  await app.post('/api/ttt/status', { published: true }, { token: admin });
  m = await mine();
  assert.equal(m.teams.length, 1);
  assert.deepEqual({ name: m.teams[0].name, captain: m.teams[0].captain, iAmCaptain: m.teams[0].iAmCaptain, mates: m.teams[0].mates }, { name: 'Team 1', captain: 'Mate', iAmCaptain: false, mates: ['Mate'] });

  await app.post('/api/ttt/results', { weekId: WEEK(), results: { [t1]: { time: '25:00', position: 3, of: 8 } } }, { token: admin });
  assert.equal((await mine()).teams[0].result.position, 3);

  const waiting = await app.memberSession('1003');
  await app.post('/api/ttt/signup', {}, { token: waiting });
  assert.equal((await mine(waiting)).waitlist, 1, 'the team of 2 is full, so a late sign-up is first on the waitlist');
  assert.deepEqual((await mine(waiting)).teams, []);

  // history after the week rolls over
  await app.post('/api/ttt/new-week', { date: h.ymd(17) }, { token: admin });
  m = await mine();
  assert.equal(m.week.date, h.ymd(17));
  assert.equal(m.signup, null);
  assert.equal(m.history.length, 1);
  assert.equal(m.history[0].id, WEEK());
  assert.deepEqual(m.history[0].teams.map(t => [t.name, t.result && t.result.position]), [['Team 1', 3]]);
});

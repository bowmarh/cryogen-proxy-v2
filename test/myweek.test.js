'use strict';
// The rider's "My week" card.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

const post = (path, body, token = admin) => app.post(path, body, { token });
const mine = token => app.get('/api/me/week', { token });
const rider = () => app.memberSession('1002', { name: 'Rider Two' });

test('needs a member sign-in', async () => {
  assert.equal((await mine(null)).status, 401);
  assert.equal((await mine(admin)).status, 401, 'staff passwords are not a rider');
});

test('an empty week is an empty list', async () => {
  const w = (await mine(await rider())).body;
  assert.deepEqual(w.items, []);
  assert.equal(w.todo, 0);
  assert.equal(w.name, 'Rider 2');
});

test('the TTT: to do while sign-ups are open, then signed up, then the team once published', async () => {
  const t = await rider();
  await post('/api/ttt/new-week', { date: h.ymd(3) });
  let item = (await mine(t)).body.items.find(i => i.kind === 'TTT');
  assert.equal(item.state, 'todo');
  assert.equal(item.go, 'ttt');
  await app.post('/api/ttt/signup', { cat: 'B', available: true }, { token: t });
  item = (await mine(t)).body.items.find(i => i.kind === 'TTT');
  assert.equal(item.state, 'in');
  assert.match(item.note, /signed up/);
});

test('ZRL: each published team and race this week, with the rider\'s own answer to give', async () => {
  const t = await rider();
  await post('/api/zrl/round', { name: 'Round 2', start: h.ymd(4), closes: h.ymd(2), weeks: 3 });
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Bravo', region: 'am' }] });
  await app.post('/api/zrl/signup', { regions: ['eu', 'am'], cat: 'C' }, { token: t });
  await post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' });
  await post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-bravo', add: true });
  assert.deepEqual((await mine(t)).body.items.filter(i => i.kind === 'ZRL'), [], 'nothing before publishing');
  await post('/api/zrl/status', { published: true });
  let z = (await mine(t)).body.items.filter(i => i.kind === 'ZRL');
  assert.equal(z.length, 2, 'one for each team, race 1 only');
  assert.ok(z.every(i => i.state === 'todo' && i.avail.week === 0 && i.avail.mine === ''));
  assert.equal((await mine(t)).body.todo, 2);
  await app.post('/api/zrl/availability', { week: 0, status: 'yes' }, { token: t });
  z = (await mine(t)).body.items.filter(i => i.kind === 'ZRL');
  assert.ok(z.every(i => i.state === 'in' && i.avail.mine === 'yes'));
});

test('social rides: in when they RSVPed, on offer otherwise, and later ones are left out', async () => {
  const t = await rider();
  await post('/api/rides', { title: 'Sunday spin', date: h.ymd(2) });
  await post('/api/rides', { title: 'Midweek ride', date: h.ymd(3) });
  await post('/api/rides', { title: 'Far away', date: h.ymd(25) });
  const rides = Object.values(app.world.db['cg:rides']).map(r => JSON.parse(r));
  await app.post('/api/rsvps', { rideId: rides.find(r => r.title === 'Sunday spin').id }, { token: t });
  const r = (await mine(t)).body.items.filter(i => i.kind === 'Ride');
  assert.deepEqual(r.map(i => [i.title, i.state]), [['Sunday spin', 'in'], ['Midweek ride', 'info']]);
});

test('an associate gets the TTT, ZRL and rides only, and may call it', async () => {
  const nora = await app.memberSession('5551', { name: 'Newbie Nora', associate: true });
  await post('/api/ttt/new-week', { date: h.ymd(3) });
  await post('/api/rides', { title: 'Sunday spin', date: h.ymd(2) });
  const res = await mine(nora);
  assert.equal(res.status, 200);
  assert.equal(res.body.associate, true);
  assert.deepEqual([...new Set(res.body.items.map(i => i.kind))].sort(), ['Ride', 'TTT']);
});

test('a rider on the Ladder sees the match with what to answer, and the line-up once they are in it', async () => {
  const t = await rider();
  assert.equal((await mine(t)).body.items.some(i => i.kind === 'Ladder'), false, 'not on the roster: nothing');
  await post('/api/ladder/roster', { zwid: '1002' });
  const m = await post('/api/ladder/match', { opponent: 'Team Rocket', challenger: 'us', date: h.ymd(2), time: '19:30' });
  assert.equal(m.status, 200);
  const item = async () => (await mine(t)).body.items.find(i => i.kind === 'Ladder');
  assert.equal((await item()).state, 'todo');
  assert.equal((await item()).title, 'vs Team Rocket');
  assert.equal((await item()).timed, true);
  const id = m.body.matches[0].id;
  await app.post('/api/ladder/availability', { match: id, status: 'yes' }, { token: t });
  assert.equal((await item()).state, 'in');
});

test('a rider in the DIRT squad sees the stage, and others do not', async () => {
  const t = await rider();
  assert.equal((await post('/api/drs/season', { name: 'DRS Autumn', division: 'Platinum', threshold: 1500, slot: 'Tuesday EU', time: '19:30', tz: 'Europe/London' })).status, 200);
  assert.equal((await post('/api/drs/squad', { zwid: '1002', force: true })).status, 200);
  assert.equal((await post('/api/drs/stage', { type: 'scratch', route: 'Dirt Loop', km: 28, date: h.ymd(3), time: '19:30' })).status, 200);
  const stage = async token => (await mine(token)).body.items.find(i => i.kind === 'DIRT Series');
  assert.match((await stage(t)).title, /Dirt Loop/);
  assert.equal(await stage(await app.memberSession('1003', { name: 'Rider Three' })), undefined);
});

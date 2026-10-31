'use strict';
// "Your season": one rider's ZRL, TTT, social-ride and ride-cover record in a single answer.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, ann;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); ann = await app.memberSession('4378027', { name: 'Ann Able' });
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const season = (token = ann) => app.get('/api/me/season', { token });

test('only a signed-in rider has a season', async () => {
  assert.equal((await season(null)).status, 401);
  assert.equal((await season(admin)).status, 401, 'staff have no rider record');
  const r = (await season()).body;
  assert.equal(r.zrl, null, 'no ZRL round yet');
  assert.deepEqual(r.cover, { past: 0, led: 0, swept: 0, upcoming: [] });
  assert.deepEqual(r.rides, { rsvps: 0, attended: 0 });
  assert.deepEqual(r.highlights, []);
});

test('ZRL: races picked for, answers, team points and podiums come from the published round', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(-13), closes: h.ymd(-20), weeks: 4 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }] }, { token: admin });
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
  await app.post('/api/zrl/status', { published: true }, { token: admin });
  let r = (await season()).body.zrl;
  assert.deepEqual([r.placed, r.races, r.picked, r.points], [true, 2, 0, 0], 'two races have happened, none picked for yet');
  await app.post('/api/zrl/lineup', { week: 0, team: 'cryo-gen-alpha', zwids: ['4378027'] }, { token: admin });
  await app.post('/api/zrl/lineup', { week: 1, team: 'cryo-gen-alpha', zwids: ['4378027'] }, { token: admin });
  await app.post('/api/zrl/availability', { week: 0, status: 'yes' }, { token: ann });
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'cryo-gen-alpha', pos: 2, pts: 15 }] }, { token: admin });
  await app.post('/api/zrl/results', { week: 1, rows: [{ team: 'cryo-gen-alpha', pos: 5, pts: 12 }] }, { token: admin });
  const body = (await season()).body;
  r = body.zrl;
  assert.deepEqual([r.picked, r.races, r.yes, r.answered, r.points, r.podiums, r.team], [2, 2, 1, 1, 27, 1, 'CRYO-GEN Alpha']);
  assert.ok(body.highlights.includes('🏁 Raced every ZRL race so far'));
  assert.ok(body.highlights.some(t => /1 ZRL podium/.test(t)));
});

test('social rides count the rider\'s RSVPs, past ones as attended; ride cover counts rides led and swept and lists the next duties', async () => {
  await app.post('/api/rides', { title: 'Old ride', date: h.ymd(-3) }, { token: admin });
  await app.post('/api/rides', { title: 'New ride', date: h.ymd(5) }, { token: admin });
  const rides = Object.keys(app.world.db['cg:rides'] || {});
  assert.equal(rides.length, 2);
  for (const id of rides) await app.post('/api/rsvps', { rideId: id }, { token: ann });
  await app.post('/api/rsvps', { rideId: rides[0], name: 'Somebody Else' }, { token: admin });
  assert.deepEqual((await season()).body.rides, { rsvps: 2, attended: 1 });

  // ride cover: a past date counts, a cancelled one does not, a coming one is a duty
  const dow = d => new Date(Date.now() + d * 86400000).getUTCDay();
  const mk = async (d, title) => (await app.post('/api/cover/series', { title, dow: dow(d), time: '19:00', zone: 'Europe/London' }, { token: admin })).body.series.find(s => s.title === title);
  await app.post('/api/cover/approve', { zwid: '4378027', name: 'Ann Able', lead: true, sweep: true }, { token: admin });
  const s = await mk(2, 'Duty Spin');
  const o = s.occurrences[0];
  await app.post('/api/cover/volunteer', { series: s.id, date: o.date, role: 'leader' }, { token: ann });
  // a slot on a date already gone (written straight to storage: the app only offers coming dates)
  const gone = h.ymd(-7);
  app.world.db['cg:cover:slots'][`${s.id}|${gone}|sweeper`] = JSON.stringify({ zwid: '4378027', name: 'Ann Able' });
  app.world.db['cg:cover:slots'][`${s.id}|${h.ymd(-14)}|leader`] = JSON.stringify({ zwid: '4378027', name: 'Ann Able' });
  app.world.db['cg:cover:cancelled'] = { [`${s.id}|${h.ymd(-14)}`]: new Date().toISOString() };
  const c = (await season()).body.cover;
  assert.deepEqual([c.past, c.led, c.swept], [1, 0, 1], 'only the date that happened and was not cancelled');
  assert.equal(c.upcoming.length, 1);
  assert.deepEqual([c.upcoming[0].title, c.upcoming[0].role], ['Duty Spin', 'Leader']);
});

test('a rider can share their season to the club channel, once a day, and only when there is something to share', async () => {
  const share = () => app.post('/api/me/season/share', {}, { token: ann });
  assert.equal((await app.post('/api/me/season/share', {})).status, 401);
  assert.equal((await share()).status, 409, 'nothing to share yet');
  app.world.db['cg:rides'] = { r1: JSON.stringify({ date: h.ymd(-3), title: 'Sunday ride' }) };
  app.world.db['cg:rsvps'] = { 'r1|ann': JSON.stringify({ name: 'Ann Able' }) };
  const ok = await share();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const post = app.world.discord.find(d => /Ann Able's season/.test(d.body.content));
  assert.ok(post && /1 social ride/.test(post.body.content));
  assert.equal((await share()).status, 429);
});

'use strict';
// End-of-round recognition: a preview for staff, a post to the club channel, and a once-only nudge when the last race is done.
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

const A = () => ({ token: admin });
const preview = (token = admin) => app.get('/api/zrl/recognition', { token });
const post = (token = admin) => app.post('/api/zrl/post-recognition', {}, { token });
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(-20), closes: h.ymd(-30), weeks: 3 }, A());
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }, { name: 'CRYO-GEN Beta', region: 'eu', division: 'Division 1' }] }, A());
  for (const [n, z, t] of [['Ann Able', '4378027', 'cryo-gen-alpha'], ['Rider 2', '1002', 'cryo-gen-alpha'], ['Bob Baker', '2436518', 'cryo-gen-beta']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
    await app.post('/api/zrl/assign', { key: z, team: t }, A());
  }
  await app.post('/api/zrl/status', { published: true }, A());
});

async function raceAll() {
  for (const w of [0, 1, 2]) {
    await app.post('/api/zrl/lineup', { week: w, team: 'cryo-gen-alpha', zwids: w === 2 ? ['4378027'] : ['4378027', '1002'] }, A());
    await app.post('/api/zrl/lineup', { week: w, team: 'cryo-gen-beta', zwids: ['2436518'] }, A());
    await app.post('/api/zrl/results', { week: w, rows: [{ team: 'cryo-gen-alpha', pos: w === 0 ? 1 : 2, pts: 10 }, { team: 'cryo-gen-beta', pos: 6, pts: 3 }] }, A());
    await app.post('/api/zrl/availability', { week: w, status: 'yes' }, { token: ann });
  }
}

test('staff only, and nothing to recognise until races have been run and entered', async () => {
  assert.equal((await preview(null)).status, 401);
  assert.equal((await preview(ann)).status, 401, 'a rider is not staff');
  assert.equal((await post(null)).status, 401);
  assert.equal((await preview()).status, 409, 'races have run but nothing is entered');
  await app.post('/api/zrl/round', { name: 'Future', start: h.ymd(30), closes: h.ymd(20), weeks: 2 }, A());
  assert.equal((await preview()).status, 409, 'no race has happened yet');
});

test('the recognition lists the table leaders, riders who raced every race, podium riders and who always answered', async () => {
  await raceAll();
  const r = (await preview()).body;
  assert.equal(r.races, 3);
  const text = r.messages.join('\n');
  assert.match(text, /round recognition after 3 races/);
  assert.match(text, /Top of the table\*\*\n• Division 1: Alpha \(30 pts\)/);
  assert.match(text, /Raced every race \(3 of 3\)\*\*\nAnn Able/, 'only Ann was picked every week');
  assert.ok(!/Raced every race[^\n]*\n[^\n]*Rider 2/.test(text), 'Rider 2 missed a race');
  assert.match(text, /• Ann Able: 3 podiums/, 'Alpha was 1st, 2nd, 2nd with her in every line-up: only the top three count, 2nd is a podium');
  assert.match(text, /Always told their captain if they could race\*\*\nAnn Able/);
  assert.ok(r.messages.every(m => m.length <= 2000));
});

test('ride-cover stars join the list, counting only rides that happened and were not cancelled', async () => {
  await raceAll();
  const dow = new Date(Date.now() - 3 * 86400000).getUTCDay();
  const s = (await app.post('/api/cover/series', { title: 'Old Spin', dow, time: '10:00', zone: 'Europe/London' }, A())).body.series[0];
  const slots = (app.world.db['cg:cover:slots'] = app.world.db['cg:cover:slots'] || {});
  slots[`${s.id}|${h.ymd(-3)}|leader`] = JSON.stringify({ zwid: '1002', name: 'Rider 2' });
  slots[`${s.id}|${h.ymd(-10)}|sweeper`] = JSON.stringify({ zwid: '1002', name: 'Rider 2' });
  slots[`${s.id}|${h.ymd(-17)}|sweeper`] = JSON.stringify({ zwid: '1002', name: 'Rider 2' });
  slots[`${s.id}|${h.ymd(-40)}|leader`] = JSON.stringify({ zwid: '1002', name: 'Rider 2' });   // before the round
  app.world.db['cg:cover:cancelled'] = { [`${s.id}|${h.ymd(-17)}`]: new Date().toISOString() };
  const text = (await preview()).body.messages.join('\n');
  assert.match(text, /Ride-cover stars[^\n]*\n• Rider 2: 2 rides/);
});

test('posting goes to the club channel once every five minutes, and a finished round nudges the staff once', async () => {
  await raceAll();
  app.world.discord.length = 0;
  assert.equal((await post()).status, 200);
  const pub = app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content).join('\n');
  assert.match(pub, /round recognition after 3 races/);
  assert.equal((await post()).status, 429);
  app.world.discord.length = 0;
  await tick();
  const nudge = () => app.world.discord.filter(p => p.channel === 'admin' && /last race is done/.test(p.body.content));
  assert.equal(nudge().length, 1);
  assert.match(nudge()[0].body.content, /Round recognition/);
  app.world.discord.length = 0;
  await tick();
  assert.equal(nudge().length, 0, 'once only');
});

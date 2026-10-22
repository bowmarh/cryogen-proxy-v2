'use strict';
// Staff can add, change and remove any rider's sign-up, and the sheet import never undoes it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const FORM_HEAD = ['Timestamp', 'Email address', 'Full Name', 'Discord', 'ZwiftPower Profile URL', 'Primary ZRL Racing Zone', 'Backup region', 'Commitment level', 'Sub-team preference', 'Team Captain?', 'Comments'];
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  world.sheet.tabs.Other = { cols: ['A'], rows: [['x']] };
  world.sheet.tabs['Form responses'] = { cols: FORM_HEAD.map((_, i) => `C${i}`), rows: [FORM_HEAD,
    ['2026-08-19 10:00:00', 'b@x.test', 'Bob Baker', 'bob', '2436518', '🔴 Red League (EMEA West / Europe & UK)', 'None', 'Full-Season Starter', 'None', 'No', 'None']] };
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'am' }] }, { token: admin });
  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'B', comments: 'her words' });
  await app.post('/api/zrl/assign', { key: '4378027', team: 'cryo-gen-alpha' }, { token: admin });
});
const edit = (body, token = admin) => app.post('/api/zrl/signup-edit', body, { token });
const remove = (key, token = admin) => app.post('/api/zrl/signup-remove', { key }, { token });
const view = () => app.get('/api/zrl', { token: admin }).then(r => r.body);
const find = async key => (await view()).signups.find(s => s.key === key);

test('staff only', async () => {
  const member = await app.memberSession('1002');
  for (const call of [() => edit({ key: '4378027', cat: 'A' }, null), () => edit({ key: '4378027', cat: 'A' }, member), () => remove('4378027', null), () => remove('4378027', member)]) {
    assert.equal((await call()).status, 401);
  }
  assert.equal((await find('4378027')).cat, 'B');
});

test('change any detail of a sign-up; the rest stays as it was', async () => {
  const r = await edit({ key: '4378027', cat: 'A', regions: ['eu', 'ap'], commit: 'reserve', captain: true, comments: 'staff note' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await find('4378027');
  assert.deepEqual([s.cat, s.regions, s.commit, s.captain, s.comments, s.in, s.name], ['A', ['eu', 'ap'], 'reserve', true, 'staff note', true, 'Ann Able']);
  assert.equal((await view()).assign['4378027'], 'cryo-gen-alpha', 'still on her team');
});

test('moving a rider to another team, or off a team, from the editor', async () => {
  await edit({ key: '4378027', team: 'cryo-gen-beta' });
  assert.equal((await view()).assign['4378027'], 'cryo-gen-beta');
  await edit({ key: '4378027', team: '' });
  assert.deepEqual((await view()).assign, {});
  assert.equal((await edit({ key: '4378027', team: 'nope' })).status, 400);
});

test('marking a rider not racing keeps them listed; checks on the values', async () => {
  assert.equal((await edit({ key: '4378027', in: false })).status, 200);
  assert.equal((await find('4378027')).in, false);
  assert.equal((await edit({ key: '4378027', in: true, regions: [] })).status, 400, 'racing needs a time zone');
  assert.equal((await edit({ key: '4378027', cat: 'Z' })).status, 400);
  assert.equal((await edit({ key: '4378027', commit: 'sometimes' })).status, 400);
  assert.equal((await edit({ key: '4378027', preferred: 'nope' })).status, 400);
  assert.equal((await edit({ key: '4378027', zwid: 'abc' })).status, 400);
  assert.equal((await edit({ key: 'nobody', cat: 'A' })).status, 404);
});

test('add a rider who signed up elsewhere, with or without a Zwift ID; no second sign-up for the same person', async () => {
  const r = await edit({ name: 'Cal  Cole', zwid: '1381556', regions: ['ap'], cat: 'C', team: 'cryo-gen-alpha' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cal = await find('1381556');
  assert.deepEqual([cal.name, cal.regions, cal.source], ['Cal Cole', ['ap'], 'staff']);
  assert.equal((await view()).assign['1381556'], 'cryo-gen-alpha');
  assert.equal((await edit({ name: 'Nick No-Id', regions: ['eu'] })).status, 200);
  assert.ok(await find('nick no-id'));
  assert.equal((await edit({ name: 'Someone Else', zwid: '1381556', regions: ['eu'] })).status, 409, 'that Zwift ID already has a sign-up');
  assert.equal((await edit({ name: '', regions: ['eu'] })).status, 400);
});

test('changing the name or Zwift ID moves the sign-up and keeps the team place', async () => {
  assert.equal((await edit({ key: '4378027', zwid: '5555555', name: 'Ann Able-Jones' })).status, 200);
  assert.equal(await find('4378027'), undefined);
  assert.equal((await find('5555555')).name, 'Ann Able-Jones');
  assert.deepEqual((await view()).assign, { 5555555: 'cryo-gen-alpha' });
  await app.post('/api/zrl/signup', { name: 'Dee Dunn', zwid: '9999999', regions: ['eu'] });
  assert.equal((await edit({ key: '5555555', zwid: '9999999' })).status, 409, 'cannot take another rider\'s ID');
});

test('remove a rider from the round', async () => {
  assert.equal((await remove('4378027')).status, 200);
  const v = await view();
  assert.deepEqual([v.signups.length, v.assign], [0, {}]);
  assert.equal((await remove('4378027')).status, 404);
});

test('a later sheet import never overwrites a staff edit', async () => {
  await edit({ name: 'Bob Baker', zwid: '2436518', regions: ['ap'], cat: 'D', comments: 'moved by staff' });
  const r = await app.post('/api/zrl/import-signups', { tab: 'Form responses', apply: true }, { token: admin });
  assert.deepEqual(r.body.imported, { signups: 0, keptOwn: 1 });
  const bob = await find('2436518');
  assert.deepEqual([bob.regions, bob.cat, bob.comments], [['ap'], 'D', 'moved by staff']);
});

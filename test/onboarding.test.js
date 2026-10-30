'use strict';
// New-member onboarding: the first run only remembers who is already here; anyone who joins later is listed with what they still have to do and nudged.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const A = { get token() { return admin; } };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const list = async () => (await app.get('/api/onboarding', A)).body;
// The page keeps the club roster for five minutes, so a new member shows up after the server is started again (as a fresh instance would).
const join = async (id, zwid, name) => { world.members.push({ id, zwift_id: zwid, name, status: 'active', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' }); await app.close(); app = await h.startApp(world); admin = await app.login('admin'); };
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); process.env.DISCORD_BOT_TOKEN = 'bot'; });

test('the first run only remembers who is already here; a member who joins later is listed with the steps they have left; staff only', async () => {
  assert.deepEqual((await list()).members, []);
  assert.equal((await app.get('/api/onboarding')).status, 401);
  assert.equal((await app.get('/api/onboarding', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  await join(9101, '8800001', 'Newbie Nora');
  const m = (await list()).members;
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].name === 'Newbie Nora' || m[0].zwid === '8800001', m[0].days, m[0].complete], [true, 0, false]);
  assert.deepEqual(m[0].steps.map(s => [s.id, s.done]), [['discord', false], ['category', false], ['series', false]]);
  await app.post('/api/comms/link', { zwid: '8800001', discordId: '123456789012345678' }, A);
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/signup', { name: 'Newbie Nora', zwid: '8800001', regions: ['eu'], cat: 'C' });
  const after = (await list()).members[0];
  assert.deepEqual(after.steps.map(s => [s.id, s.done]).filter(([id]) => id !== 'category'), [['discord', true], ['series', true]]);
});

test('on the third day a linked member with no team gets a friendly message, once; with automatic messages off, nothing', async () => {
  await list();   // seed
  await join(9102, '8800002', 'Newbie Sam');
  await list();
  await app.post('/api/comms/link', { zwid: '8800002', discordId: '223456789012345678' }, A);
  const seen = JSON.parse(app.world.db['cg:onboard:seen']['8800002']);
  app.world.db['cg:onboard:seen']['8800002'] = JSON.stringify({ ...seen, at: new Date(Date.now() - 3.5 * 86400000).toISOString() });
  await tick();
  assert.equal(world.dms.length, 0, 'automatic messages are off');
  await app.post('/api/comms/auto', { nudge: true }, A);
  await tick();
  const welcome = world.dms.filter(d => /Welcome to CRYO-GEN/.test(d.body.content));
  assert.equal(welcome.length, 1);
  await tick();
  assert.equal(world.dms.filter(d => /Welcome to CRYO-GEN/.test(d.body.content)).length, 1, 'once');
});

test('This week lists new members who have not finished after three days, and anyone seen over a month ago drops off', async () => {
  await list(); await join(9103, '8800003', 'Newbie Pat'); await list();
  const seen = JSON.parse(app.world.db['cg:onboard:seen']['8800003']);
  app.world.db['cg:onboard:seen']['8800003'] = JSON.stringify({ ...seen, at: new Date(Date.now() - 4 * 86400000).toISOString() });
  const w = (await app.get('/api/week', A)).body;
  assert.ok(w.attention.some(a => a.id === 'onboarding' && /1 new member has not finished/.test(a.title)));
  assert.equal(w.newMembers.length, 1);
  app.world.db['cg:onboard:seen']['8800003'] = JSON.stringify({ ...seen, at: new Date(Date.now() - 40 * 86400000).toISOString() });
  assert.equal((await list()).members.length, 0);
});

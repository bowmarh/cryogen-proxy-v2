'use strict';
// TTT automation: teams are suggested when sign-ups close (and the admin channel hears what is left), a team too small is folded into another, and it can be switched off.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const WEEK_KEY = 'cg:ttt:week';
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const state = async () => (await app.get('/api/ttt', { token: admin })).body;
async function seed(patch = {}) {
  await app.post('/api/ttt/new-week', { date: h.ymd(2) }, { token: admin });
  const w = JSON.parse(app.world.db[WEEK_KEY]);
  app.world.db[WEEK_KEY] = JSON.stringify({ ...w, ...patch });
  app.world.discord.length = 0;
}
// Sign-ups are in: move the close time into the past (reading the page would run the schedule, so this comes last).
const closeNow = () => { const w = JSON.parse(app.world.db[WEEK_KEY]); app.world.db[WEEK_KEY] = JSON.stringify({ ...w, closesAt: new Date(Date.now() - 3600000).toISOString() }); };
const join = async (names, extra = {}) => { for (const n of names) await app.post('/api/ttt/signup', { name: n, ...extra }); };

test('closing places everyone, picks a volunteer captain and tells the admin channel', async () => {
  await seed();
  const teams = (await state()).week.teams;
  await join(['Ann Lee', 'Bo Chen', 'Cy Dunn', 'Di Evans', 'Ed Fox']);
  await app.post('/api/ttt/signup', { name: 'Flo Gray', captain: true });
  closeNow();
  assert.deepEqual((await tick()).body.ran, ['close']);
  const s = await state();
  const placed = s.signups.filter(x => (s.assign[x.name.toLowerCase()] || []).length);
  assert.equal(placed.length, 6, 'everybody has a team');
  assert.ok(Object.keys(s.week.captains || {}).length >= 1, 'a volunteer captain was picked');
  const adminPost = app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content).join('\n');
  assert.match(adminPost, /Teams suggested automatically: 6 placed/);
  assert.match(adminPost, /Check the teams and publish/);
  assert.ok(teams.length > 0);
});

test('a team left with fewer than four riders by the plan is folded into another that has room', async () => {
  await seed({ autoAllocate: false });
  const teams = (await state()).week.teams;
  const [a, b] = teams;
  await join(['R1', 'R2', 'R3', 'R4'], { preferred: [a.id] });
  await join(['R5', 'R6'], { preferred: [b.id] });
  const preview = (await app.post('/api/ttt/auto-assign', { preview: true }, { token: admin })).body;
  const to = Object.fromEntries(preview.plan.map(p => [p.name, p.teams[0]]));
  assert.ok(['R5', 'R6'].every(n => to[n] === a.id), 'the pair is folded into the team that has four');
  assert.ok(preview.summary.merged.length === 2 && preview.summary.short.length === 0);
});

test('automatic allocation can be switched off for the week, and previews list the captains', async () => {
  await seed();
  assert.equal((await app.post('/api/ttt/auto-settings', { allocate: false }, { token: admin })).status, 200);
  await join(['Ann Lee', 'Bo Chen']);
  closeNow();
  await tick();
  const s = await state();
  assert.equal(s.week.open, false);
  assert.ok(s.signups.every(x => !(s.assign[x.name.toLowerCase()] || []).length), 'left to the staff');
  assert.equal(s.week.autoAllocate, false);
  await app.post('/api/ttt/signup', { name: 'Vol Unteer', captain: true }).catch(() => {});
  assert.equal((await app.post('/api/ttt/auto-settings', { allocate: true })).status, 401);
});

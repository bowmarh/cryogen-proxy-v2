'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { rng } = require('./fitwriter');

h.setEnv();
let app, admin, world;
before(async () => {
  world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = { token: await app.login('admin') };
});
after(() => { delete process.env.ANTHROPIC_API_KEY; return app.close(); });
beforeEach(() => { world.anthropic = { reply: 'Spin easy.', status: 200, seen: [] }; process.env.ANTHROPIC_API_KEY = 'sk-test'; app.world.db = {}; });
const rider = async (z, name = 'R') => ({ token: await app.memberSession(z, { name }) });
const yes = async who => app.post('/api/coach/consent', { on: true }, who);
const ask = (who, m = 'hi') => app.post('/api/coach/chat', { message: m }, who);
const month = new Date().toISOString().slice(0, 7);

test('only an admin sets the supporters and the prices; bad links are refused', async () => {
  assert.equal((await app.get('/api/support')).status, 401);
  assert.equal((await app.get('/api/support', { token: await app.login('mod') })).status, 403);
  assert.equal((await app.post('/api/support/settings', { payUrl: 'http://x.test' }, admin)).status, 400);
  const s = (await app.post('/api/support/settings', { payUrl: 'https://ko-fi.com/cryogen', price: 3, freeWeekly: 3, supporterDaily: 15, budget: 20, inPrice: 2, outPrice: 10, shareCost: true }, admin)).body.settings;
  assert.deepEqual([s.payUrl, s.price, s.budget, s.shareCost], ['https://ko-fi.com/cryogen', 3, 20, true]);
  assert.equal((await app.post('/api/support/add', { zwid: '1002', note: 'Paid via Ko-fi <b>' }, admin)).status, 200);
  assert.equal((await app.post('/api/support/add', { zwid: '1003', until: 'soon' }, admin)).status, 400);
  const l = (await app.get('/api/support', admin)).body;
  assert.deepEqual([l.supporters.length, l.supporters[0].name, l.supporters[0].active, l.income], [1, 'Rider 2', true, 3]);
  assert.ok(!l.supporters[0].note.includes('<'));
  await app.post('/api/support/remove', { zwid: '1002' }, admin);
  assert.equal((await app.get('/api/support', admin)).body.supporters.length, 0);
});

test('free riders have 3 a week, supporters 15 a day; a supporter whose date has passed is back to free; the star shows to members', async () => {
  const free = await rider('1003', 'Rider Three'), sup = await rider('1004', 'Rider Four');
  await yes(free); await yes(sup);
  await app.post('/api/support/add', { zwid: '1004' }, admin);
  let st = (await app.get('/api/coach/status', sup)).body;
  assert.deepEqual([st.tier, st.period, st.remaining, st.limit], ['supporter', 'today', 15, 15]);
  for (let i = 0; i < 4; i++) await ask(sup, 'q' + i);
  assert.equal((await app.get('/api/coach/status', sup)).body.remaining, 11);
  st = (await app.get('/api/coach/status', free)).body; assert.deepEqual([st.tier, st.remaining], ['free', 3]);
  assert.deepEqual((await app.get('/api/avatars', free)).body.supporters, ['1004']);
  await app.post('/api/support/add', { zwid: '1004', until: '2020-01-01' }, admin);   // it ran out
  assert.equal((await app.get('/api/coach/status', sup)).body.tier, 'free');
  assert.deepEqual((await app.get('/api/avatars', free)).body.supporters, []);
});

test('explaining a ride: one free a month, then a supporter extra', async () => {
  const R = rng(3), s = { t: [], p: [], hr: [], cad: [], spd: [], dist: [], alt: [] };
  for (let i = 0; i < 1500; i++) { s.t.push(i); s.p.push(Math.round(200 + (R() - .5) * 20)); s.hr.push(140); s.cad.push(90); s.spd.push(9); s.dist.push(i * 9); s.alt.push(0); }
  const free = await rider('1003', 'Rider Three'); await yes(free);
  assert.equal((await app.get('/api/coach/status', free)).body.ridesLeft, 1);
  assert.equal((await app.post('/api/coach/ride', { samples: s }, free)).status, 200);
  const again = await app.post('/api/coach/ride', { samples: s }, free);
  assert.equal(again.status, 403); assert.match(again.body.error, /supporter extra/);
  assert.equal((await ask(free)).status, 200, 'questions are still open');
  await app.post('/api/support/add', { zwid: '1003' }, admin);
  assert.equal((await app.post('/api/coach/ride', { samples: s }, free)).status, 200);
  assert.equal((await app.get('/api/coach/status', free)).body.ridesLeft, null, 'no limit for supporters');
});

test('the AI is counted in tokens and money; past the budget the free coach rests, well past it everyone does; members only see the cost if the club shares it', async () => {
  await app.post('/api/support/settings', { payUrl: 'https://ko-fi.com/cryogen', price: 3, budget: 10, inPrice: 2, outPrice: 10, shareCost: false }, admin);
  const free = await rider('1003', 'Rider Three'), sup = await rider('1004', 'Rider Four');
  await yes(free); await yes(sup); await app.post('/api/support/add', { zwid: '1004' }, admin);
  world.anthropic.usage = { input_tokens: 3000, output_tokens: 500 };
  assert.equal((await ask(free)).status, 200);
  const mo = (await app.get('/api/support', admin)).body.month;
  assert.deepEqual([mo.answers, mo.tokensIn, mo.tokensOut, mo.cost], [1, 3000, 500, 0.01]);
  assert.equal((await app.get('/api/coach/status', free)).body.transparency, null, 'not shared');
  const health = (await app.get('/api/health', admin)).body.checks.find(c => c.id === 'usage');
  assert.match(health.detail, /AI today: 1 answers, 3000 tokens in, 500 tokens out/);
  // 12 pounds this month: over the budget of 10.
  app.world.db['cg:ai:usage'][`${month}-15:in`] = String(5e6); app.world.db['cg:ai:usage'][`${month}-15:out`] = '0';
  const rest = await ask(free); assert.equal(rest.status, 429); assert.match(rest.body.error, /free coach has used this month's budget.*Supporters can still ask/);
  assert.equal((await ask(sup)).status, 200, 'supporters carry on');
  app.world.db['cg:ai:usage'][`${month}-16:in`] = String(5e6);   // 22 pounds: over one and a half times
  const all = await ask(sup); assert.equal(all.status, 429); assert.match(all.body.error, /resting until next month/);
  await app.post('/api/support/settings', { payUrl: 'https://ko-fi.com/cryogen', price: 3, budget: 10, inPrice: 2, outPrice: 10, shareCost: true }, admin);
  const t = (await app.get('/api/coach/status', free)).body.transparency;
  assert.deepEqual([t.supporters, t.monthly, t.cost > 20], [1, 3, true]);
  assert.equal((await app.get('/api/coach/status', free)).body.payUrl, 'https://ko-fi.com/cryogen');
});

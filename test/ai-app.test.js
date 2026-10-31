'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { rng } = require('./fitwriter');

h.setEnv();
let app, world, admin, mod;
const CATS = ['Ruby', 'Ruby', 'Emerald', 'Emerald', 'Sapphire', 'Sapphire', 'Sapphire'];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 3000 + i, name: `Squad ${i}`, country: 'gb', zpCategory: 'B', zpFTP: 250, power: { wkg300: 4 - i * 0.1, wkg1200: 3.4 - i * 0.1 }, race: { current: { rating: 1500 - i * 50, mixed: { category: cat } } } })) });
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = { token: await app.login('admin') }; mod = { token: await app.login('mod') };
});
after(() => { delete process.env.ANTHROPIC_API_KEY; return app.close(); });
beforeEach(() => { world.anthropic = { reply: 'ok', status: 200, seen: [] }; process.env.ANTHROPIC_API_KEY = 'sk-test'; });
const ID = i => String(3000 + i);

async function team() {
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(5), closes: h.ymd(-1), weeks: 3 }, admin);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B' }] }, admin);
  for (let i = 0; i < 7; i++) { await app.post('/api/zrl/signup', { name: `Squad ${i}`, zwid: ID(i), regions: ['eu'], cat: 'B' }); await app.post('/api/zrl/assign', { key: ID(i), team: 'alpha' }, admin); }
  await app.post('/api/zrl/captain', { team: 'alpha', key: ID(0) }, admin);
  for (let i = 0; i < 7; i++) await app.post('/api/zrl/availability', { week: 0, zwid: ID(i), status: i === 6 ? 'no' : 'yes' }, admin);
  await app.post('/api/zrl/lineup', { team: 'alpha', week: 0, zwids: [0, 1, 2, 3, 4].map(ID) }, admin);
}

test('the line-up review is a second opinion: staff or the captain only, swaps checked against the real answers, names kept from the model, and nothing changed', async () => {
  await team();
  world.anthropic.reply = JSON.stringify({ explanation: 'Balanced, but no one strong on the climbs.', swaps: [{ out: 'E', in: 'F', why: 'F is a better climber' }, { out: 'A', in: 'G', why: 'G said no' }, { out: 'F', in: 'A', why: 'F is not picked' }], risks: ['Two unsure riders'] });
  const before = JSON.stringify(app.world.db['cg:zrl:weekly']);
  assert.equal((await app.post('/api/ai/lineup-review', { team: 'alpha', week: 0 })).status, 403);
  assert.equal((await app.post('/api/ai/lineup-review', { team: 'alpha', week: 0 }, { token: await app.memberSession(ID(3), { name: 'Squad 3' }) })).status, 403, 'a rider who is not the captain');
  const r = await app.post('/api/ai/lineup-review', { team: 'alpha', week: 0 }, mod);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.swaps.map(s => [s.out, s.in]), [['Squad 4', 'Squad 5']], 'the swap onto a rider who said no, and the one from an unpicked rider, are dropped');
  assert.deepEqual(r.body.picked, ['Squad 0', 'Squad 1', 'Squad 2', 'Squad 3', 'Squad 4']);
  assert.match(r.body.note, /Nothing has been changed/); assert.equal(JSON.stringify(app.world.db['cg:zrl:weekly']), before);
  assert.ok(!/Squad|300\d/.test(world.anthropic.seen.at(-1).body.messages[0].content), 'no names or Zwift IDs to the model');
  const cap = await app.post('/api/ai/lineup-review', { team: 'alpha', week: 0 }, { token: await app.memberSession(ID(0), { name: 'Squad 0' }) });
  assert.equal(cap.status, 200, 'the captain can ask');
});

test('the weekly report and the quiet-rider drafts are for staff; the report can be written on demand and posted', async () => {
  assert.equal((await app.get('/api/ai/report')).status, 401);
  assert.equal((await app.post('/api/ai/report', {}, { token: await app.memberSession(ID(0), { name: 'S' }) })).status, 401);
  world.anthropic.reply = 'A steady week. To do: check the line-ups.';
  app.world.discord.length = 0;
  const r = (await app.post('/api/ai/report', { post: true }, mod)).body.report;
  assert.deepEqual([r.via, r.text.slice(0, 8)], ['ai', 'A steady']);
  assert.ok(app.world.discord.some(d => /Weekly report/.test(d.body.content)));
  assert.equal((await app.get('/api/ai/report', admin)).body.report.text, r.text);
  const q = (await app.get('/api/ai/drift', admin)).body; assert.ok(Array.isArray(q.quiet));
  assert.equal((await app.post('/api/ai/drift', { zwid: '999' }, admin)).status, 404);
  assert.equal((await app.post('/api/ai/club-story', {}, mod)).status, 200);
});

test('a supporter opts in to the weekly plan; a free rider is told it is a supporter extra', async () => {
  const sup = { token: await app.memberSession(ID(1), { name: 'Squad 1' }) }, free = { token: await app.memberSession(ID(2), { name: 'Squad 2' }) };
  await app.post('/api/support/add', { zwid: ID(1) }, admin);
  assert.equal((await app.post('/api/plan/optin', { on: true }, sup)).status, 403, 'needs the coach yes first');
  await app.post('/api/coach/consent', { on: true }, sup); await app.post('/api/coach/consent', { on: true }, free);
  assert.equal((await app.post('/api/plan/optin', { on: true }, free)).status, 403);
  assert.equal((await app.post('/api/plan/optin', { on: true }, sup)).body.optIn, true);
  assert.deepEqual([(await app.get('/api/plan', sup)).body.optIn, (await app.get('/api/plan', sup)).body.supporter, (await app.get('/api/plan', free)).body.supporter], [true, true, false]);
  assert.equal((await app.post('/api/plan/optin', { on: false }, sup)).body.optIn, false);
});

test('ask the club answers from the club\'s data and the rider\'s own week, the season story uses the rider\'s numbers, and a race debrief changes what the coach is asked', async () => {
  const me = { token: await app.memberSession(ID(2), { name: 'Squad 2' }) };
  await app.post('/api/coach/consent', { on: true }, me);
  world.anthropic.reply = 'Alpha lead Division 1.';
  const q = await app.post('/api/coach/club', { message: 'How are the teams doing?' }, me);
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.reply, 'Alpha lead Division 1.');
  const sent = world.anthropic.seen.at(-1).body;
  assert.match(sent.system, /ONLY the data you are given/); assert.match(sent.messages[0].content, /Club data:/);
  assert.ok(!/Squad 2|"weight"/.test(sent.messages[0].content));
  assert.equal((await app.post('/api/coach/club', { message: ' ' }, me)).status, 400);
  world.anthropic.reply = 'This year I raced a lot.';
  const st = await app.post('/api/coach/story', {}, me); assert.equal(st.status, 200); assert.equal(st.body.reply, 'This year I raced a lot.');
  assert.equal(st.body.remaining, 1, 'the club question and the story each used one of the three free questions');
  const R = rng(4), s = { t: [], p: [], hr: [], cad: [], spd: [], dist: [], alt: [] };
  for (let i = 0; i < 1500; i++) { s.t.push(i); s.p.push(Math.round((i % 300 < 20 ? 420 : 200) + (R() - .5) * 10)); s.hr.push(150); s.cad.push(90); s.spd.push(9); s.dist.push(i * 9); s.alt.push(0); }
  await app.post('/api/support/add', { zwid: ID(2) }, admin);
  world.anthropic.reply = 'You won it on the surges.';
  const d = await app.post('/api/coach/ride', { samples: s, mode: 'debrief' }, me);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const msg = world.anthropic.seen.at(-1).body.messages[0].content;
  assert.match(msg, /This was a RACE/); assert.match(msg, /surgesAbove150PercentOfNp/); assert.match(msg, /lastQuarterAvgPower/);
});

test('a failed AI call gives the question back for the club answer and the story', async () => {
  const me = { token: await app.memberSession(ID(5), { name: 'Squad 5' }) };
  await app.post('/api/coach/consent', { on: true }, me);
  world.anthropic.status = 500;
  assert.equal((await app.post('/api/coach/story', {}, me)).status, 502);
  assert.equal((await app.post('/api/coach/club', { message: 'x' }, me)).status, 502);
  assert.equal((await app.get('/api/coach/status', me)).body.remaining, 3);
});

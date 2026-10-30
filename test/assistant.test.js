'use strict';
// "Ask the club": a model turns plain words into a plan from a fixed menu; names are matched here; nothing runs until staff confirm.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald'];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin'); process.env.ANTHROPIC_API_KEY = 'sk-test';
});
after(() => { delete process.env.ANTHROPIC_API_KEY; return app.close(); });
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
const say = message => app.post('/api/assistant', { message }, A);
const model = actions => { world.anthropic = { reply: JSON.stringify({ reply: 'Okay.', actions }), status: 200, seen: [] }; };
beforeEach(async () => {
  app.world.db = {}; world.anthropic = null;
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }] }, A);
  for (const i of [0, 1, 2]) await app.post('/api/zrl/signup', { name: `Lad ${i}`, zwid: ID(i), regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/assign', { key: ID(0), team: 'cryo-gen-alpha' }, A);
});

test('staff only, needs the key, and the model sees the club data but the staff member\'s words are the only request', async () => {
  assert.equal((await app.post('/api/assistant', { message: 'hi there' })).status, 401);
  assert.equal((await app.post('/api/assistant', { message: 'hi there' }, { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  assert.equal((await say('x')).status, 400);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await say('move someone')).status, 503);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  model([]);
  const r = await say('Do something odd');
  assert.equal(r.status, 200); assert.deepEqual(r.body.plan, []);
  const sent = world.anthropic.seen[0];
  assert.equal(sent.key, 'sk-test'); assert.match(sent.body.system, /Lad 1/); assert.equal(sent.body.messages[0].content, 'Do something odd');
});

test('a plan is shown with names matched to real riders and teams, changes nothing, and anything outside the menu or unmatched is reported, not run', async () => {
  model([{ type: 'zrl_assign', args: { rider: 'lad 1', team: 'Beta' } }, { type: 'zrl_captain', args: { team: 'Alpha', rider: 'Lad 0' } }, { type: 'delete_everything', args: {} }, { type: 'zrl_assign', args: { rider: 'Nobody', team: 'Beta' } }]);
  const r = (await say('Move Lad 1 to Beta and make Lad 0 captain of Alpha')).body;
  assert.deepEqual(r.plan.map(p => p.text), ['Move Lad 1 to CRYO-GEN Beta', 'Make Lad 0 captain of CRYO-GEN Alpha']);
  assert.equal(r.problems.length, 2); assert.match(r.problems.join(' '), /not something the assistant can do/); assert.match(r.problems.join(' '), /No rider matches "Nobody"/);
  assert.equal((await app.get('/api/zrl', A)).body.placements[ID(1)], undefined, 'nothing changed yet');
});

test('confirming runs the plan, each step can be undone, and a failing step does not stop the others', async () => {
  model([{ type: 'zrl_assign', args: { rider: 'Lad 1', team: 'Beta' } }, { type: 'zrl_captain', args: { team: 'Alpha', rider: 'Lad 0' } }]);
  const plan = (await say('go ahead')).body.plan;
  assert.equal((await app.post('/api/assistant/run', { plan }, { token: null })).status, 401);
  assert.equal((await app.post('/api/assistant/run', { plan: [{ type: 'rm', args: {} }] }, A)).status, 400);
  const out = (await app.post('/api/assistant/run', { plan }, A)).body.done;
  assert.deepEqual(out.map(d => d.ok), [true, true]);
  const v = (await app.get('/api/zrl', A)).body;
  assert.equal(v.placements[ID(1)][0], 'cryo-gen-beta'); assert.equal(v.round.teams.find(t => t.id === 'cryo-gen-alpha').captain, ID(0));
  const entries = (await app.get('/api/auto', A)).body.entries.filter(e => e.by === 'assistant');
  assert.equal(entries.length, 2);
  for (const e of entries) await app.post('/api/auto/undo', { id: e.id }, A);
  const back = (await app.get('/api/zrl', A)).body;
  assert.equal(back.placements[ID(1)], undefined); assert.ok(!back.round.teams.find(t => t.id === 'cryo-gen-alpha').captain || back.round.teams.find(t => t.id === 'cryo-gen-alpha').captain === '');
  const bad = (await app.post('/api/assistant/run', { plan: [{ type: 'zrl_assign', args: { key: 'nope', team: 'cryo-gen-beta' }, text: 'x' }, ...plan] }, A)).body.done;
  assert.deepEqual(bad.map(d => d.ok), [false, true, true]);
});

test('a broken model answer or a model error is a clear message; the daily limit holds', async () => {
  world.anthropic = { reply: 'sorry, no json', status: 200, seen: [] };
  assert.equal((await say('do it please')).status, 502);
  world.anthropic = { reply: '', status: 500, seen: [] };
  assert.equal((await say('do it please')).status, 502);
  model([]);
  app.world.db['cg:assistant:count:' + new Date().toISOString().slice(0, 10)] = '60';
  assert.equal((await say('one more thing')).status, 429);
});

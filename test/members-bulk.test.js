'use strict';
// Staff change the same field on many members at once.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());
beforeEach(() => { world.patches.length = 0; world.patchStatus = 200; });

const bulk = (body, token = admin) => app.post('/api/members/bulk', body, { token });
const roster = async () => (await app.get('/api/roster', { token: admin })).body.members;

test('staff only', async () => {
  assert.equal((await bulk({ zwids: ['1000'], changes: { tier: 'associate' } }, null)).status, 401);
  assert.equal((await bulk({ zwids: ['1000'], changes: { tier: 'associate' } }, await app.memberSession('1002', { name: 'Rider Two' }))).status, 401);
  assert.equal((await bulk({ zwids: ['1000'], changes: { tier: 'associate' } }, mod)).status, 200);
});

test('one change for many members: each is saved, and the roster shows it straight away', async () => {
  const r = await bulk({ zwids: ['1000', '1001', '1002'], changes: { status: 'suspended' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.saved, r.body.failed], [3, 0]);
  assert.deepEqual(world.patches.map(p => p.body), [{ status: 'suspended' }, { status: 'suspended' }, { status: 'suspended' }]);
  assert.ok((await roster()).filter(m => ['1000', '1001', '1002'].includes(m.zwift_id)).every(m => m.status === 'suspended'));
});

test("the old 'half' value is saved as associate", async () => {
  const r = await bulk({ zwids: ['1000'], changes: { tier: 'half' } });
  assert.equal(r.status, 200);
  assert.deepEqual(world.patches.map(p => p.body), [{ tier: 'associate' }]);
});

test('a member with no record is reported, the rest are still saved', async () => {
  const r = await bulk({ zwids: ['1000', '999999'], changes: { tier: 'full' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map(x => [x.zwid, x.ok]), [['1000', true], ['999999', false]]);
  assert.match(r.body.results[1].error, /no member record/);
  assert.deepEqual([r.body.saved, r.body.failed], [1, 1]);
});

test('WordPress refusing is reported per member, not as a crash', async () => {
  world.patchStatus = 403;
  const r = await bulk({ zwids: ['1000', '1001'], changes: { tier: 'full' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.saved, r.body.failed], [0, 2]);
  assert.match(r.body.results[0].error, /refused/);
});

test('a change WordPress does not keep is not reported as saved', async () => {
  const echo = world.patchEcho;
  world.patchApply = () => {};   // the plugin accepts the call but stores nothing, and says nothing back
  world.patchEcho = [];
  try {
    const r = await bulk({ zwids: ['1000'], changes: { tier: 'associate' } });
    assert.equal(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /did not keep/);
  } finally { world.patchApply = (rec, body) => Object.assign(rec, body); world.patchEcho = echo; }
});

test('bad requests: nobody picked, too many, not numbers, nothing or something invalid to change', async () => {
  assert.equal((await bulk({ zwids: [], changes: { tier: 'full' } })).status, 400);
  assert.equal((await bulk({ zwids: Array.from({ length: 101 }, (_, i) => String(2000 + i)), changes: { tier: 'full' } })).status, 400);
  assert.equal((await bulk({ zwids: ['abc'], changes: { tier: 'full' } })).status, 400);
  assert.equal((await bulk({ zwids: ['1000'], changes: {} })).status, 400);
  assert.equal((await bulk({ zwids: ['1000'], changes: { tier: 'platinum' } })).status, 400);
  assert.equal((await bulk({ zwids: ['1000'], changes: { name: 'Someone Else' } })).status, 400, 'only tier, status and off-boarding ticks');
  assert.equal(world.patches.length, 0);
});

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => {
  world = h.createWorld();
  app = await h.startApp(world);
  admin = await app.login('admin');
  mod = await app.login('mod');
});
after(() => app.close());

const members = async token => (await app.get('/api/roster', { token })).body.members;
const patch = (zwid, body, token = admin) => app.post(`/api/members/${zwid}`, body, { token });

test('the public roster is slimmed: no age, gender, height or weight', async () => {
  const r = await app.get('/api/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.riders.length, 5);
  const text = JSON.stringify(r.body.riders);
  for (const k of ['"age"', '"gender"', '"height"', '"weight"']) assert.ok(!text.includes(k), `${k} leaked`);
  assert.equal(r.body.riders[0].name, 'Rider 0');
  assert.ok(r.body.riders[0].power.wkg1200, 'dashboard fields are kept');
});

test('member records: one per Zwift ID (last wins), placeholders dropped, public sees only name/status/tier', async () => {
  const list = await members();
  assert.deepEqual(list.map(m => m.zwift_id).sort(), ['1000', '1001', '1002']);
  const two = list.find(m => m.zwift_id === '1002');
  assert.deepEqual(two, { zwift_id: '1002', name: 'Rider Two', status: 'active', tier: 'full' });
  assert.deepEqual(Object.keys(list[0]).sort(), ['name', 'status', 'tier', 'zwift_id']);
  const staff = await members(admin);
  assert.ok('offboard_discord' in staff[0], 'staff also see off-boarding progress');
});

test('only staff can change member records', async () => {
  assert.equal((await patch('1000', { tier: 'half' }, null)).status, 401);
  assert.equal((await patch('1000', { tier: 'half' }, await app.memberSession('1002'))).status, 401);
  assert.equal((await patch('1000', { tier: 'half' }, mod)).status, 200);
});

test('values are validated and unknown fields are never forwarded to WordPress', async () => {
  world.patches.length = 0;
  assert.equal((await patch('1000', { tier: 'gold' })).status, 400);
  assert.equal((await patch('1000', { status: 'banned' })).status, 400);
  assert.equal((await patch('1000', { offboard_fb: 'yes' })).status, 400);
  assert.equal((await patch('1000', {})).status, 400, 'nothing to change');
  assert.equal((await patch('1000', { name: 'Hacker', role: 'administrator' })).status, 400, 'only the known fields count');
  assert.equal((await patch('424242', { tier: 'half' })).status, 404, 'no record for that Zwift ID');
  assert.equal((await patch('abc', { tier: 'half' })).status, 404, 'the route only takes numeric IDs');
  assert.equal(world.patches.length, 0, 'nothing reached WordPress');
  const ok = await patch('1000', { tier: 'full', name: 'ignored' });
  assert.equal(ok.status, 200);
  assert.deepEqual(world.patches.at(-1).body, { tier: 'full' }, 'only whitelisted fields are sent');
});

test('a save goes to the record the page shows, and the roster updates straight away', async () => {
  world.patches.length = 0;
  const r = await patch('1002', { tier: 'half' });
  assert.equal(r.status, 200);
  assert.equal(world.patches.at(-1).id, '4', 'the last duplicate record, not the first');
  assert.equal(r.body.member.tier, 'half');
  assert.equal((await members()).find(m => m.zwift_id === '1002').tier, 'half', 'no stale cache');
});

test('status and off-boarding steps save too', async () => {
  assert.equal((await patch('1000', { status: 'suspended' })).status, 200);
  assert.equal((await members()).find(m => m.zwift_id === '1000').status, 'suspended');
  assert.equal((await patch('1001', { offboard_discord: '1', offboard_fb: '1' })).status, 200);
  const staff = (await members(admin)).find(m => m.zwift_id === '1001');
  assert.equal(staff.offboard_discord, '1');
  assert.equal(staff.offboard_fb, '1');
  assert.equal((await members()).find(m => m.zwift_id === '1001').offboard_discord, undefined, 'hidden from the public');
});

test('a field WordPress quietly ignores is reported as not saved', async () => {
  world.patchApply = (rec, body) => { const { offboard_zp, ...rest } = body; Object.assign(rec, rest); };
  try {
    const r = await patch('1000', { offboard_zp: '1' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /didn't save: offboard_zp/);
    assert.match(r.body.error, /Patched \/members\/1 with/, 'the message says what was sent, to help diagnose');
  } finally { world.patchApply = (rec, body) => Object.assign(rec, body); }
});

test('a cached member list does not make a saved change look failed (the stale-read bug)', async () => {
  world.staleMembers = JSON.parse(JSON.stringify(world.members)); // GET keeps returning old data
  try {
    const r = await patch('1000', { tier: 'half' });
    assert.equal(r.status, 200, 'WordPress echoed tier, so it counts as saved');
    assert.equal(r.body.member.tier, 'half');
  } finally { world.staleMembers = null; world.members.find(m => m.id === 1).tier = 'full'; }
});

test('member reads ask WordPress for an uncached copy', async () => {
  await patch('1000', { tier: 'full' });
  const last = world.memberRequests.at(-1);
  assert.match(last.url, /[?&]_cb=\d+/);
  assert.equal(last.headers['Cache-Control'], 'no-cache');
});

test('WordPress refusing the change is reported with its reason', async () => {
  world.patchStatus = 403; world.patchMessage = 'You must be an admin';
  try {
    const r = await patch('1000', { tier: 'half' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /403/);
    assert.match(r.body.error, /You must be an admin/);
  } finally { world.patchStatus = 200; world.patchMessage = null; }
});

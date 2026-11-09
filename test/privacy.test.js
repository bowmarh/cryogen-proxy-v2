'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, ann, bo;
before(async () => {
  app = await h.startApp(h.createWorld());
  admin = await app.login('admin'); ann = await app.memberSession('2000', { name: 'Ann Lee' }); bo = await app.memberSession('2001', { name: 'Bo Dunn' });
});
after(() => app.close());
beforeEach(() => {
  app.world.discord.length = 0;
  app.world.db = {
    'cg:rider:velo': { 2000: JSON.stringify([['2026-10-01', 1400]]), 2001: JSON.stringify([['2026-10-01', 1200]]) },
    'cg:fair:snap': { 2000: JSON.stringify([{ d: '2026-11-01', w: 61, v: 1400 }]), 2001: JSON.stringify([{ d: '2026-11-01', w: 80, v: 1200 }]) },
    'cg:fair:weights': { 2000: '61.5', 2001: '80' },
    'cg:zrl:weekly': { '0:2000:alpha': 'yes', '0:2001:alpha': 'no' },
    'cg:ttt:signups': { 'ann lee': JSON.stringify({ name: 'Ann Lee', zwid: '2000', cat: 'B' }), 'bo dunn': JSON.stringify({ name: 'Bo Dunn', zwid: '2001' }) },
    'cg:comms:discord': { 2000: JSON.stringify({ id: '111', verified: true, code: '123456', dm: true }) },
    'cg:push:subs': { 2000: JSON.stringify({ endpoint: 'https://push.example/secret', keys: { auth: 'x', p256dh: 'y' } }) },
    'cg:fair:flags': { '2000:wkg_spike:p5': JSON.stringify({ zwid: '2000', type: 'wkg_spike', note: 'staff note' }) },
    'cg:cases:log': { l1: JSON.stringify({ id: 'l1', zwift_id: '2000', note: 'staff only' }) },
    'cg:inv:cases': { c1: JSON.stringify({ id: 'c1', zwid: '2000', title: 'secret case' }) },
  };
});

test('a rider downloads their own data: found by Zwift ID and by name, secrets removed, nothing of anyone else, nothing staff hold', async () => {
  assert.equal((await app.get('/api/me/data')).status, 401);
  const d = (await app.get('/api/me/data', { token: ann })).body, text = JSON.stringify(d);
  const keys = d.stores.map(s => s.key);
  for (const k of ['cg:rider:velo', 'cg:fair:snap', 'cg:fair:weights', 'cg:zrl:weekly', 'cg:ttt:signups', 'cg:comms:discord', 'cg:push:subs']) assert.ok(keys.includes(k), `${k} is included`);
  assert.equal(d.stores.find(s => s.key === 'cg:zrl:weekly').entries.length, 1, 'only their own availability answer');
  assert.ok(text.includes('1400') && !text.includes('1200'), 'their vELO, not Bo\'s');
  assert.ok(!text.includes('123456') && !text.includes('push.example') && !/"auth"/.test(text), 'codes and push keys are never shown');
  assert.equal(d.stores.find(s => s.key === 'cg:push:subs').entries, undefined, 'devices are counted, not listed');
  assert.ok(!text.includes('staff note') && !text.includes('secret case') && !text.includes('staff only'), 'staff-held records are not in the download');
});

test('asking for erasure tells the admin channel once; only an administrator sees and acts on requests', async () => {
  const a = await app.post('/api/me/data/erase-request', {}, { token: ann });
  assert.equal(a.status, 200); assert.equal(app.world.discord.filter(p => p.channel === 'admin').length, 1);
  assert.equal((await app.post('/api/me/data/erase-request', {}, { token: ann })).body.already, true);
  assert.equal(app.world.discord.filter(p => p.channel === 'admin').length, 1, 'no second alert');
  assert.equal(/Ann/.test(app.world.discord[0].body.content), false, 'the alert names no one');
  assert.equal((await app.get('/api/staff/privacy', { token: ann })).status, 401);
  assert.equal((await app.get('/api/staff/privacy', { token: await app.login('mod') })).status, 403);
  const list = (await app.get('/api/staff/privacy', { token: admin })).body;
  assert.equal(list.requests[0].zwid, '2000'); assert.equal(list.requests[0].status, 'open');
});

test('erasure previews first, then removes only that rider from the personal stores, and leaves staff records for a person to decide', async () => {
  await app.post('/api/me/data/erase-request', {}, { token: ann });
  const pre = (await app.post('/api/staff/privacy/erase', { zwid: '2000' }, { token: admin })).body;
  assert.equal(pre.preview, true); assert.ok(pre.removed.length >= 6);
  assert.ok(app.world.db['cg:rider:velo']['2000'], 'a preview deletes nothing');
  assert.deepEqual(pre.staffHeld.map(s => s.key).sort(), ['cg:cases:log', 'cg:fair:flags', 'cg:inv:cases']);
  const done = (await app.post('/api/staff/privacy/erase', { zwid: '2000', preview: false }, { token: admin })).body;
  assert.equal(done.preview, false);
  const db = app.world.db;
  assert.equal(db['cg:rider:velo']['2000'], undefined); assert.equal(db['cg:fair:weights']['2000'], undefined); assert.equal(db['cg:ttt:signups']['ann lee'], undefined);
  assert.equal(db['cg:zrl:weekly']['0:2000:alpha'], undefined);
  assert.ok(db['cg:rider:velo']['2001'] && db['cg:ttt:signups']['bo dunn'] && db['cg:zrl:weekly']['0:2001:alpha'], 'Bo is untouched');
  assert.ok(db['cg:fair:flags']['2000:wkg_spike:p5'] && db['cg:cases:log'].l1 && db['cg:inv:cases'].c1, 'staff records are not erased automatically');
  const after = (await app.get('/api/staff/privacy', { token: admin })).body;
  assert.equal(after.requests[0].status, 'done'); assert.equal(after.log[0].zwid, '2000'); assert.equal(JSON.stringify(after.log).includes('1400'), false, 'the log holds counts, never the data');
  assert.equal((await app.get('/api/me/data', { token: ann })).body.stores.length, 0, 'nothing left to download');
});

test('erasure needs a Zwift ID and is for administrators only', async () => {
  assert.equal((await app.post('/api/staff/privacy/erase', { zwid: 'abc' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/staff/privacy/erase', { zwid: '2000' }, { token: await app.login('mod') })).status, 403);
  assert.equal((await app.post('/api/staff/privacy/erase', { zwid: '2000' }, { token: bo })).status, 401);
});

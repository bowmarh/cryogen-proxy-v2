'use strict';
// The registration list a captain pastes into WTRL.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
});
const exp = (token = admin) => app.get('/api/zrl/export', { token });
const join = (name, zwid, extra = {}) => app.post('/api/zrl/signup', { name, zwid, regions: ['eu'], cat: 'C', ...extra });
const put = (key, team) => app.post('/api/zrl/assign', { key, team }, { token: admin });

test('export is staff only and needs a round', async () => {
  assert.equal((await exp(null)).status, 401);
  assert.equal((await exp(await app.memberSession('1002'))).status, 401);
  delete app.world.db['cg:zrl:round'];
  assert.equal((await exp()).status, 409);
});

test('export: a block per team, captain first, ids, a CSV; problems are listed', async () => {
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', slot: 'Tue 19:00 UK', captain: '1000', division: 'Division 1', grade: 'Open B' },
    { name: 'CRYO-GEN Beta', region: 'ap' },
  ] }, { token: admin });
  await join('Zed Zimmer', '1000');
  await join('Rider 2', '1002');
  await join('Reserve Ray', '1003', { cat: 'D' });
  await join('No Id Nick', '', { cat: '' });
  await join('Free Agent', '1004');
  const sheetEntry = JSON.parse(app.world.db['cg:zrl:signups']['1003']);   // a reserve comes from the sheet import
  app.world.db['cg:zrl:signups']['1003'] = JSON.stringify({ ...sheetEntry, commit: 'reserve' });
  for (const [k, t] of [['1000', 'cryo-gen-alpha'], ['1002', 'cryo-gen-alpha'], ['1003', 'cryo-gen-alpha'], ['no id nick', 'cryo-gen-beta']]) assert.equal((await put(k, t)).status, 200);
  const x = (await exp()).body;
  const a = x.teams[0];
  assert.deepEqual(a.riders.map(r => r.name), ['Zed Zimmer', 'Rider 2', 'Reserve Ray'], 'captain first, then full-season riders, reserves last');
  assert.equal(a.riders[0].isCaptain, true);
  assert.equal(a.riders[1].isCaptain, false);
  assert.match(a.text, /^CRYO-GEN Alpha — Division 1 · Open B — Europe — Tue 19:00 UK\nCaptain: Rider 0 \(1000\)\n1\. Zed Zimmer — 1000 — C\n2\. Rider 2 — 1002 — C\n3\. Reserve Ray — 1003 — D \(reserve\)$/);
  assert.equal(a.ids, '1000\n1002\n1003');
  assert.deepEqual(a.issues, ['3 riders, 10 expected']);
  const b = x.teams[1];
  assert.deepEqual(b.issues, ['no captain yet', '1 rider, 10 expected', '1 without a Zwift ID', '1 without a category']);
  assert.match(b.text, /Captain: not chosen yet\n1\. No Id Nick — no Zwift ID$/);
  assert.deepEqual(x.unassigned.map(u => u.name), ['Free Agent']);
  const lines = x.csv.split('\n');
  assert.equal(lines[0], 'Team,Division,Grade,Time zone,Race time,Rider,Zwift ID,Category,Captain,Commitment');
  assert.equal(lines.length, 1 + 4);
  assert.ok(lines[1].startsWith('CRYO-GEN Alpha,Division 1,Open B,Europe,Tue 19:00 UK,Zed Zimmer,1000,C,yes,full season'));
});

test('export: names that look like spreadsheet formulas, or hold commas and quotes, are made safe in the CSV', async () => {
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await join('=HYPERLINK("http://evil.test","x")', '1000');
  await join('Smith, Jo "JJ"', '1002');
  await put('1000', 'cryo-gen-alpha'); await put('1002', 'cryo-gen-alpha');
  const csv = (await exp()).body.csv;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`), csv);
  assert.ok(csv.includes('"Smith, Jo ""JJ"""'), csv);
  assert.ok(!/^=|,=/.test(csv.split('\n').slice(1).join('\n')), 'no cell starts with =');
});

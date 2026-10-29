'use strict';
// Google Sheet sync: the app writes its teams to a mirror tab through a service account (the club's own tabs are never touched), and pulls the sheet's
// published teams into the app with the sheet winning. Off until an administrator turns it on.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv();
const TTT_SHEET = '1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw', ZRL_SHEET = '1s8lrYj3f-nD3qSmlA_kaSRJxzvun7-ZJfIl8kR5Pjsc';
let app, world, admin, mod;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY_JSON = JSON.stringify({ client_email: 'sync@cryogen-test.iam.gserviceaccount.com', private_key: privateKey });
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => { delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; return app.close(); });
const A = { get token() { return admin; } };

const FORM = ['Timestamp', 'Please select your name or select *OTHER*', 'Zwift Power ID Number', 'Availability'];
function teamListGrid(tags) {   // a TEAM LIST with a block per [tag, riders[]] starting at column C, E, ...
  const rows = Array.from({ length: 12 }, () => Array(2 + tags.length * 4).fill(''));
  tags.forEach(([tag, riders], i) => { const c = 2 + i * 4; rows[1][c] = `(CRYO-GEN ${tag})`; riders.forEach((n, j) => { rows[4 + j][c] = n; }); });
  return { cols: rows[0].map((_, i) => `c${i}`), rows };
}
beforeEach(async () => {
  app.world.db = {};
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = KEY_JSON;
  world.gs = { sheets: { [TTT_SHEET]: { tabs: { 'TEAM LIST': [] } }, [ZRL_SHEET]: { tabs: { 'TEAM LIST': [] } } }, calls: [], tokenCalls: 0 };
  world.sheet = { first: 'Form Responses 1', html: false, tabs: { 'Form Responses 1': { cols: FORM, rows: [['x', 'Rider 0', '1000', 'I am available this week'], ['x', 'Rider 1', '1001', 'I am available this week']] }, 'TEAM LIST': teamListGrid([['Hawks', ['Rider 0', 'Rider 1']]]) } };
  await app.post('/api/ttt/new-week', { date: h.ymd(10) }, A);
});
const get = (token = admin) => app.get('/api/sync', { token });
const settings = (b, token = admin) => app.post('/api/sync/settings', b, { token });
const run = (b, token = admin) => app.post('/api/sync/run', b, { token });

test('who may see it and change it; nothing is on to begin with', async () => {
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(await app.memberSession('1002', { name: 'Rider Two' }))).status, 401);
  const v = (await get(mod)).body;
  assert.deepEqual([v.google.configured, v.google.email, v.canChange], [true, 'sync@cryogen-test.iam.gserviceaccount.com', false]);
  assert.deepEqual(Object.keys(v.series), ['ttt', 'zrl']);
  assert.equal(v.series.ttt.sheetId, TTT_SHEET); assert.equal(v.series.zrl.sheetId, ZRL_SHEET);
  assert.deepEqual([v.series.ttt.settings, v.series.zrl.settings], [{ pull: false, push: false }, { pull: false, push: false }]);
  assert.equal((await settings({ series: 'ttt', push: true }, mod)).status, 403, 'administrators only');
  assert.equal(JSON.stringify(v).includes('PRIVATE KEY'), false, 'the key is never shown');
  assert.equal((await settings({ series: 'nope', push: true })).status, 404);
});

test('publishing writes the TTT teams to a mirror tab it creates, and an unchanged week is not written twice', async () => {
  await app.post('/api/ttt/import-sheet', { apply: true }, A);
  const hawks = (await app.get('/api/ttt', A)).body.week.teams.find(t => t.name === 'Hawks').id;
  await app.post('/api/ttt/assign', { name: 'Rider 0', teams: [hawks] }, A);
  const r = await run({ series: 'ttt', direction: 'push' });
  assert.equal(r.status, 200);
  assert.equal(r.body.series.ttt.state.push.ok, true);
  const tab = world.gs.sheets[TTT_SHEET].tabs['CRYO-GEN App TTT'];
  assert.ok(tab, 'the mirror tab was created');
  assert.match(tab[0][0], /this tab is written by the app/);
  const body = tab.slice(2);
  assert.deepEqual(body[0], ['Team', 'Level', 'Zone', 'Rider', 'Zwift ID', 'Cat', 'Volunteer captain', 'Double up']);
  assert.ok(body.some(r => r[0] === 'Hawks' && r[3] === 'Rider 0' && r[4] === '1000'));
  assert.ok(body.some(r => r[0] === '— Not in a team —' && r[3] === 'Rider 1'), 'available riders without a team are listed');
  assert.equal(JSON.stringify(world.gs.sheets[TTT_SHEET].tabs['TEAM LIST']), '[]', "the club's own tab is never written");
  const writes = () => world.gs.calls.filter(c => c.method === 'PUT').length;
  assert.equal(writes(), 1);
  assert.equal(world.gs.tokenCalls, 1, 'one sign-in, reused');
  await run({ series: 'ttt', direction: 'push' });
  assert.equal(writes(), 1, 'nothing changed, so nothing was written');
  await run({ series: 'ttt', direction: 'push', force: true });
  assert.equal(writes(), 2, 'unless forced');
});

test('problems are explained: no key, a sheet not shared, a bad key, a missing tab never blocks the other direction', async () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let r = await run({ series: 'ttt', direction: 'push' });
  assert.equal(r.status, 409); assert.match(r.body.error, /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.equal((await settings({ series: 'ttt', push: true })).status, 409, 'publishing cannot be turned on without the key');
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = KEY_JSON;
  world.gs.sheets[TTT_SHEET].locked = true;
  r = await run({ series: 'ttt', direction: 'push' });
  assert.equal(r.body.result.push.error.includes('sync@cryogen-test.iam.gserviceaccount.com'), true, 'it says who to share the sheet with');
  assert.equal(r.body.series.ttt.state.push.ok, false);
  world.gs.sheets[TTT_SHEET].locked = false; world.gs.tokenFail = true;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'other@cryogen-test.iam.gserviceaccount.com', private_key: privateKey });   // a different account signs in afresh
  r = await run({ series: 'ttt', direction: 'push', force: true });
  assert.match(r.body.result.push.error, /would not sign the service account in/);
  world.gs.tokenFail = false;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{not json';
  assert.equal((await get()).body.google.configured, false);
});

test('the ZRL sheet id can be changed, and settings accept a pasted link', async () => {
  const link = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing';
  const v = (await settings({ series: 'zrl', sheetId: link })).body;
  assert.equal(v.series.zrl.sheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(v.series.zrl.customSheet, true);
  assert.equal((await settings({ series: 'zrl', sheetId: 'not a link!' })).status, 400);
  assert.equal((await settings({ series: 'zrl', sheetId: '' })).body.series.zrl.sheetId, ZRL_SHEET, 'blank goes back to the club sheet');
});

test('pull for TTT: the sheet wins: sign-ups and the published teams come in, and a rider no longer in a block comes off it', async () => {
  const hawks = (await app.get('/api/ttt', A)).body.week.teams.find(t => t.name === 'Hawks').id;
  await app.post('/api/ttt/import-sheet', { apply: true }, A);
  await app.post('/api/ttt/assign', { name: 'Rider 1', teams: [hawks] }, A);        // the app has Rider 1 on Hawks; the sheet does not list them any more
  world.sheet.tabs['TEAM LIST'] = teamListGrid([['Hawks', ['Rider 0']]]);
  const r = await run({ series: 'ttt', direction: 'pull' });
  assert.equal(r.status, 200);
  assert.equal(r.body.series.ttt.state.pull.ok, true);
  const v = (await app.get('/api/ttt', A)).body;
  assert.deepEqual(v.assign['rider 0'], [hawks], 'placed as the sheet has it');
  assert.equal(v.assign['rider 1'], undefined, 'taken off, as the sheet no longer lists them');
  assert.deepEqual([r.body.result.pull.placed, r.body.result.pull.removed], [1, 1]);
});

// A ZRL board in the real shape: blocks with the team's name, division and grade above a Rider / Gender / ID / Wkg / Type / Cat table.
function zrlBoard(teams) {
  const rows = Array.from({ length: 12 }, () => Array(6 * teams.length).fill(''));
  teams.forEach(([name, riders], i) => {
    const c = i * 6;
    rows[0][c] = 'Red'; rows[1][c] = name; rows[2][c] = 'Division 2'; rows[3][c] = 'Open B';
    ['Rider', 'Gender', 'ID', 'Wkg', 'Type', 'Cat'].forEach((v, j) => { rows[4][c + j] = v; });
    riders.forEach(([n, id, cat], j) => { rows[5 + j][c] = n; rows[5 + j][c + 2] = id; rows[5 + j][c + 5] = cat; });
  });
  return { cols: rows[0].map((_, i) => `c${i}`), rows };
}
test('pull for ZRL: the sheet wins for riders on teams the app has; captains, race times and teams only one side has are left alone', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, A);
  world.sheet.tabs['TEAM LIST'] = zrlBoard([['CRYO Alpha', [['Ann Able', 4378027, 'B'], ['Bob Baker', 2436518, 'D']]], ['CRYO Beta', [['Rider 2', 1002, 'B']]]]);
  const regions = { 'cryo-alpha': 'eu', 'cryo-beta': 'am' };
  assert.equal((await app.post('/api/zrl/import', { tab: 'TEAM LIST', apply: true, regions }, A)).status, 200);
  await app.post('/api/zrl/team-slot', { teams: ['cryo-alpha'], slot: 'Tue 18:00 UTC' }, A);
  await app.post('/api/zrl/captain', { team: 'cryo-alpha', key: '4378027' }, A);
  await app.post('/api/zrl/signup-edit', { name: 'App Only', zwid: '1004', regions: ['eu'], cat: 'C', team: 'cryo-alpha' }, A);   // placed in the app only
  // the sheet now: Bob has moved to Beta, Cat Cole is new on Alpha, and a team the app does not have has appeared
  world.sheet.tabs['TEAM LIST'] = zrlBoard([['CRYO Alpha', [['Ann Able', 4378027, 'B'], ['Cat Cole', 1381556, 'C']]], ['CRYO Beta', [['Rider 2', 1002, 'B'], ['Bob Baker', 2436518, 'D']]], ['CRYO Gamma', [['Phantom', 9999999, 'C']]]]);
  const r = await run({ series: 'zrl', direction: 'pull' });
  assert.equal(r.body.series.zrl.state.pull.ok, true, JSON.stringify(r.body.series.zrl.state.pull));
  const sync = r.body.result.pull;
  assert.deepEqual([sync.teams, sync.placed, sync.removed, sync.created], [2, 2, 2, 1]);
  assert.deepEqual([sync.newOnSheet, sync.notOnSheet], [['CRYO Gamma'], []]);
  const v = (await app.get('/api/zrl', A)).body, at = k => v.placements[k];
  assert.deepEqual([at('4378027'), at('1381556'), at('2436518'), at('1002')], [['cryo-alpha'], ['cryo-alpha'], ['cryo-beta'], ['cryo-beta']]);
  assert.equal(at('1004'), undefined, 'the app-only placement is taken off, the sheet wins');
  const alpha = v.round.teams.find(t => t.id === 'cryo-alpha');
  assert.deepEqual([alpha.slot, alpha.captain], ['Tue 18:00 UTC', '4378027'], 'race time and captain untouched');
  assert.equal(v.round.teams.length, 2, 'a team only the sheet has is reported, not created');
  assert.equal(v.signups.some(x => x.key === '1381556'), true, 'a rider only the sheet has gets a sign-up');
  // a sheet that has none of the app's teams (the wrong tab) changes nothing and says so
  world.sheet.tabs['TEAM LIST'] = zrlBoard([['Some Other Team', [['Someone', 1234567, 'C']]]]);
  const bad = await run({ series: 'zrl', direction: 'pull' });
  assert.match(bad.body.series.zrl.state.pull.error, /None of the teams on that sheet match|does not look like the team board/);
  assert.deepEqual((await app.get('/api/zrl', A)).body.placements['4378027'], ['cryo-alpha']);
});

test('automatic runs: off by default, run when switched on, at most every ten minutes, and the daily tick publishes', async () => {
  assert.deepEqual((await app.post('/api/sync/auto', { series: 'ttt' }, A)).body.ran, []);
  await settings({ series: 'ttt', push: true });
  const first = (await app.post('/api/sync/auto', { series: 'ttt' }, A)).body;
  assert.deepEqual(first.ran, ['push']);
  assert.deepEqual((await app.post('/api/sync/auto', { series: 'ttt' }, A)).body.ran, [], 'not again within ten minutes');
  await app.post('/api/ttt/import-sheet', { apply: true }, A);   // something changed
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const tab = world.gs.sheets[TTT_SHEET].tabs['CRYO-GEN App TTT'];
  assert.ok(tab.some(r => r[3] === 'Rider 0'), 'the tick published the change');
  const health = (await app.get('/api/health', A)).body.checks.find(c => c.id === 'sheetsync');
  assert.equal(health.status, 'ok');
});

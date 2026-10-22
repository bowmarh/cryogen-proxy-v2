'use strict';
// Importing the team board from the ZRL tab of the Google Sheet: preview, apply, and the odd shapes in the real board.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;

// A small board shaped like the real one: blocks of different widths, a ghost team, a repeated team name, a rider on two teams.
function board() {
  const rows = Array.from({ length: 10 }, () => Array(20).fill(''));
  const put = (r, c, vals) => vals.forEach((v, i) => { rows[r][c + i] = v; });
  // Block 1, cols 0-5: Rider, Gender, ID, Wkg, Type, Cat
  put(0, 0, ['Red']); put(1, 0, ['CRYO Alpha']); put(2, 0, ['Division 2']); put(3, 0, ['Open B']);
  put(4, 0, ['Rider', 'Gender', 'ID', 'Wkg', 'Type', 'Cat']);
  put(5, 0, ['Ann Able', 'F', 4378027, 3.2, 'Climber', 'B']);
  put(6, 0, ['Bob Baker', 'M', 2436518, 2.2, 'Sprinter', 'D']);
  put(7, 0, ['Cat Cole', 'M', 1381556]);                          // new sign-up: ID but no stats
  put(8, 0, ['Av WKG / Power / Riders', '', '', 0, 0]);           // summary rows under the riders are not riders
  // Block 2, cols 6-10, no ID column: Rider, Wkg, Power, Type, Cat
  put(0, 6, ['Teal']); put(1, 6, ['CRYO Beta']); put(2, 6, ['Division 1']); put(3, 6, ['C']);
  put(4, 6, ['Rider', 'Wkg', 'Power', 'Type', 'Cat']);
  put(5, 6, ['Rider 2', 3.86, 282, 'All-Rounder', 'B']);           // found in the club roster by name
  put(6, 6, ['Nobody Known', 3.1, 250, 'Sprinter', 'C']);
  // Block 3: a ghost team
  put(0, 11, ['Blue']); put(1, 11, ['Ghost Team']); put(2, 11, ['Division 1']);
  put(4, 11, ['Rider', 'Wkg', 'Power', 'Type', 'Cat']); put(5, 11, ['Phantom', 3, 200, 'x', 'C']);
  // Block 4: same name as block 1, other division, and Ann is listed here too
  put(0, 16, ['AMERICAS E']); put(1, 16, ['CRYO Alpha']); put(2, 16, ['Division 3']); put(3, 16, ['Open B']);
  put(4, 16, ['Rider', 'Gender', 'ID', 'Cat']);
  put(5, 16, ['Ann Able', 'F', 4378027, 'B']);
  put(6, 16, ['Dee Dunn', 'F', 5555555, 'A+']);
  return rows;
}

before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  world.sheet.tabs.Other = { cols: ['A'], rows: [['x']] };
  world.sheet.tabs.ZRL = { cols: Array.from({ length: 20 }, (_, i) => `C${i}`), rows: board() };
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
});

const imp = (body, token = admin) => app.post('/api/zrl/import', { tab: 'ZRL', ...body }, { token });
const view = token => app.get('/api/zrl', { token }).then(r => r.body);

test('import is staff only and needs a real tab', async () => {
  assert.equal((await imp({}, null)).status, 401);
  assert.equal((await imp({}, await app.memberSession('1002'))).status, 401);
  assert.equal((await imp({ tab: 'No such tab' })).status, 404);
  assert.equal((await imp({ tab: 'Other' })).status, 422, 'a tab that is not a team board');
});

test('another sheet can be named by link or ID; anything else is refused', async () => {
  const id = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  assert.equal((await imp({ sheet: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0` })).status, 200);
  assert.equal((await imp({ sheet: id })).status, 200);
  assert.equal((await imp({ sheet: 'not a sheet' })).status, 400);
  assert.equal((await imp({ sheet: 'https://example.com/x' })).status, 400);
});

test('preview reads each block: names, divisions, ids, categories, region hints; ghost team dropped; repeated name made unique', async () => {
  const r = await imp({});
  assert.equal(r.status, 200);
  const { teams, warnings } = r.body.preview;
  assert.deepEqual(teams.map(t => t.name), ['CRYO Alpha', 'CRYO Beta', 'CRYO Alpha (Division 3)']);
  assert.deepEqual(teams.map(t => t.region), ['eu', '', 'am'], 'Red and AMERICAS labels give a region; a colour that is not in the league table does not');
  assert.equal(teams[0].division, 'Division 2'); assert.equal(teams[0].grade, 'Open B');
  assert.deepEqual(teams[0].riders.map(x => [x.name, x.zwid, x.cat]), [['Ann Able', '4378027', 'B'], ['Bob Baker', '2436518', 'D'], ['Cat Cole', '1381556', '']]);
  assert.deepEqual(teams[1].riders.map(x => [x.name, x.zwid, x.idFrom]), [['Rider 2', '1002', 'roster'], ['Nobody Known', '', '']]);
  assert.deepEqual(teams[2].riders.map(x => [x.name, x.cat]), [['Dee Dunn', 'A']], 'A+ becomes A; Ann stays on the first team');
  assert.ok(warnings.some(w => /Ann Able is listed on CRYO Alpha and CRYO Alpha \(Division 3\)/.test(w)));
  assert.ok(warnings.some(w => /Nobody Known .* no Zwift ID/.test(w)));
  assert.ok(!teams[0].riders.some(x => /WKG/i.test(x.name)), 'the summary row is not a rider');
  assert.equal((await view(admin)).round.teams.length, 0, 'preview changes nothing');
});

test('apply needs a time zone for every team; then teams, sign-ups and rosters are written', async () => {
  const bad = await imp({ apply: true });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /CRYO Beta/);
  const ok = await imp({ apply: true, regions: { 'cryo-beta': 'ap' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.imported, { teams: 3, riders: 6 });
  const v = await view(admin);
  assert.deepEqual(v.round.teams.map(t => [t.name, t.region, t.division]), [['CRYO Alpha', 'eu', 'Division 2'], ['CRYO Beta', 'ap', 'Division 1'], ['CRYO Alpha (Division 3)', 'am', 'Division 3']]);
  assert.equal(v.assign['4378027'], v.round.teams[0].id);
  assert.equal(v.assign['nobody known'], v.round.teams[1].id, 'a rider with no id is keyed by name');
  const ann = v.signups.find(s => s.zwid === '4378027');
  assert.deepEqual([ann.in, ann.cat, ann.regions], [true, 'B', ['eu']]);
  assert.deepEqual(['eu', 'ap', 'am'].map(id => v.demand.regions.find(r => r.id === id).riders), [3, 2, 1]);
  assert.equal((await view()).assign, undefined, 'rosters are staff-only for now');
});

test('importing again keeps a rider\'s own sign-up and replaces the rosters; editing a team keeps its division', async () => {
  const member = await app.memberSession('1002');
  await app.post('/api/zrl/signup', { regions: ['ap'], cat: 'A', comments: 'night owl' }, { token: member });
  await imp({ apply: true, regions: { 'cryo-beta': 'ap' } });
  const v = await view(admin);
  const mine = v.signups.find(s => s.zwid === '1002');
  assert.deepEqual([mine.regions, mine.cat, mine.comments], [['ap'], 'A', 'night owl'], 'existing sign-up untouched');
  assert.equal(v.assign['1002'], v.round.teams[1].id);
  const edited = v.round.teams.map(t => ({ name: t.name, region: t.region, slot: 'Tue 19:00 UK', captain: t.captain }));
  assert.equal((await app.post('/api/zrl/teams', { teams: edited }, { token: admin })).status, 200);
  assert.equal((await view(admin)).round.teams[0].division, 'Division 2');
});

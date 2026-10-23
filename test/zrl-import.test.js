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

const FORM_HEAD = ['Timestamp', 'Email address', 'Full Name', 'Discord', 'ZwiftPower Profile URL', 'Select your Primary ZRL Racing Zone (Required)', 'If your primary choice is full or needs cover, which backup regions can you race in?', 'What is your commitment level for this season? (Required)', 'For returning CRYO-GEN riders: Sub-team preference', 'Are you interested in being a Team Captain?', 'Any other useful comments or questions?'];
const FORM = [
  FORM_HEAD,
  ['Date(2026,7,18,12,0,0)', 'a@x.test', 'Ann Able', 'ann', 'https://zwiftpower.com/profile.php?z=4378027', '🔴 Red League (EMEA West / Europe & UK)', '🟢 Lime League - 6:00 PM UTC', 'Full-Season Starter (Committed for all weeks)', 'CRYO Alpha', 'Yes', 'None'],
  ['2026-08-19 10:00:00', 'b@x.test', 'Bob Baker', 'bob', '2436518.0', '🩷 Pink League - 8:30 AM UTC', 'Primary choice only — cannot flex', 'Reserve / Rotation Rider', 'Stay with my previous sub-team (if spot is available)', 'No', 'Happy to ride at odd hours'],
  ['2026-08-20 10:00:00', 'c@x.test', 'Rider 2', 'r2', '[link removed]', '🟡 Yellow League (Americas)', 'None', 'Full-Season Starter (Committed for all weeks)', 'Open to any team in my selected region', 'None', 'x'.repeat(400)],
  ['2026-08-21 10:00:00', 'd@x.test', 'Nobody Known', 'nk', 'my profile', '🟠 Orange League - (Time TBD)', 'None', 'Full-Season Starter (Committed for all weeks)', 'Cryo- Gen Alfa', 'None', 'None'],
  ['2026-08-22 10:00:00', 'e@x.test', 'Ann Able', 'ann', 'https://zwiftpower.com/profile.php?z=4378027', '🟣 Indigo League - 12:30 AM UTC', 'None', 'Full-Season Starter (Committed for all weeks)', 'CRYO Alpha', 'Yes', 'second answer'],
];

before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  world.sheet.tabs.Other = { cols: ['A'], rows: [['x']] };
  world.sheet.tabs['Form responses'] = { cols: FORM_HEAD.map((_, i) => `C${i}`), rows: FORM };
  world.sheet.tabs.Unused = { cols: ['A'], rows: [['x']] };
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
  assert.equal((await imp({ tab: 'No such tab' })).status, 422, 'Google answers an unknown tab with the first one, which is not a team board');
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

const sup = (body, token = admin) => app.post('/api/zrl/import-signups', { tab: 'Form responses', ...body }, { token });

test('sign-up import is staff only; a tab that is not the form responses is refused', async () => {
  assert.equal((await sup({}, null)).status, 401);
  assert.equal((await sup({}, await app.memberSession('1002'))).status, 401);
  assert.equal((await sup({ tab: 'Other' })).status, 422);
});

test('sign-up preview: ids from the link, a bare number or the roster; latest answer wins; zones from the league labels', async () => {
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  const r = await sup({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { summary, warnings, sample } = r.body.preview;
  assert.equal(summary.riders, 4, 'Ann submitted twice');
  const by = n => sample.find(x => x.name === n);
  assert.deepEqual([by('Ann Able').zwid, by('Ann Able').comments], ['4378027', 'second answer'], 'the later answer wins');
  assert.deepEqual(by('Ann Able').regions, ['am'], 'Indigo 12:30 AM UTC is an American evening');
  assert.equal(by('Bob Baker').zwid, '2436518', 'a bare number with .0 from the sheet');
  assert.deepEqual([by('Bob Baker').regions, by('Bob Baker').commit, by('Bob Baker').prevTeam], [['ap'], 'reserve', 'stay'], 'Pink 8:30 AM UTC is an Asia-Pacific evening');
  assert.deepEqual([by('Rider 2').zwid, by('Rider 2').idFrom, by('Rider 2').regions], ['1002', 'roster', ['am']], 'a removed link falls back to the club roster by name');
  assert.equal(by('Rider 2').comments.length, 300, 'long comments are cut');
  assert.equal(by('Nobody Known').zwid, '');
  assert.equal(by('Nobody Known').preferred, 'cryo-gen-alpha', 'a near-miss team name is matched');
  assert.ok(warnings.some(w => /Ann Able submitted more than once/.test(w)));
  assert.ok(warnings.some(w => /Nobody Known has no usable Zwift ID/.test(w)));
  assert.ok(warnings.some(w => /Nobody Known: no time zone/.test(w)), 'Orange (time TBD) gives no zone');
  assert.deepEqual(summary.regions, { eu: 0, am: 2, ap: 1 });
});

test('sign-up import keeps riders\' own sign-ups and refreshes earlier sheet imports', async () => {
  await app.post('/api/zrl/signup', { regions: ['eu'], cat: 'B', comments: 'my own words' }, { token: await app.memberSession('1002') });
  const r = await sup({ apply: true });
  assert.deepEqual(r.body.imported, { signups: 3, keptOwn: 1 });
  const v = await view(admin);
  assert.equal(v.signups.find(s => s.zwid === '1002').comments, 'my own words');
  const bob = v.signups.find(s => s.zwid === '2436518');
  assert.deepEqual([bob.source, bob.commit, bob.league], ['sheet', 'reserve', 'Pink League - 8:30 AM UTC']);
  assert.equal(v.signups.find(s => s.name === 'Nobody Known').key, 'nobody known');
  assert.equal((await view()).signups.find(s => s.zwid === '2436518'), undefined, 'ids stay staff-only');
  const again = await sup({ apply: true });
  assert.equal(again.body.imported.signups, 3, 'running it twice changes nothing but the timestamps stay');
});

test('the board\'s league label is kept on each team, and a refresh updates only the labels', async () => {
  await imp({ apply: true, regions: { 'cryo-beta': 'ap' } });
  let v = await view(admin);
  assert.deepEqual(v.round.teams.map(t => t.league), ['Red', 'Teal', 'AMERICAS E']);
  // staff work on the teams, and the stored labels get lost (as for a round imported before labels were kept)
  await app.post('/api/zrl/team-slot', { teams: ['cryo-alpha'], slot: 'Tue 18:00 UTC' }, { token: admin });
  await app.post('/api/zrl/captain', { team: 'cryo-alpha', key: '4378027' }, { token: admin });
  const stored = JSON.parse(app.world.db['cg:zrl:round']);
  stored.teams = stored.teams.map(t => ({ ...t, league: '', division: '', grade: '' }));
  app.world.db['cg:zrl:round'] = JSON.stringify(stored);
  const r = await imp({ apply: true, refresh: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.refreshed, { teams: 3, missing: [] });
  v = await view(admin);
  const alpha = v.round.teams.find(t => t.id === 'cryo-alpha');
  assert.deepEqual([alpha.league, alpha.division, alpha.grade], ['Red', 'Division 2', 'Open B']);
  assert.deepEqual([alpha.slot, alpha.captain], ['Tue 18:00 UTC', '4378027'], 'race time and captain untouched');
  assert.ok(Object.keys(v.assign).length >= 5, 'placements untouched');
});

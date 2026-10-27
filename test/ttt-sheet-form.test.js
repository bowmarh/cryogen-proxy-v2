'use strict';
// The TTT sheet: sign-ups are read from the Google Form responses (found even when they are not on the TEAM LIST tab), with the form's real column
// headings; the published teams are read from the TEAM LIST tab wherever its blocks of names and Zwift IDs sit (DH/DI, FV/FW, GH/GI ...).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
const A = { get token() { return admin; } };

// The form's headings as the club's sheet has them.
const FORM_COLS = [
  'Timestamp', 'Email address',
  'Please select your name or select *OTHER* if unable to find yours then add your name below, your name will typically be added after riding 2 or 3 TTTs......',
  'If you selected *OTHER* please enter your first name and surname here',
  'NEW\nIndicate below that you have read and agree to the terms of the TTT-Rules-and-Expectations V2.3',
  'The Teams you would like to ride with [either or and if you are doubling-up] (coffee classes are typical, these may vary depending on sign-ups).  Team allocation is not guaranteed, TTT Admin will decide the make-up of the teams based on sign-ups',
  'Do you want to Double up? (more than 1 race across time regions?)', "Select your level for this week's TTT", 'Which Region is your preference?',
  'Select all available zones that you can race', 'Zwift Power ID Number - https://zwiftpower.com/profile.php?z=********', 'Availability',
  'Comments Any other comments and/or questions.', 'Tick the zones you are able to ride (note we do not field teams in all zones)'];
const COMP = 'Competetive (captain decides how the team rides)';
const formRow = (name, other, teams, dbl, level, id, avail) => ['22/10/2026 22:09:16', 'someone@example.com', name, other, 'Yes', teams, dbl, level, '', '', id, avail, '', 'Zone 12, Zone 13'];
const FORM_ROWS = [
  formRow('Alice Example', '', 'Hawks - Latte (Zone 22)', 'No', COMP, '7000001', 'I am available this week'),
  formRow('Bob Sample', '', 'Magpies - Latte+ (Zone 22), Kites - Mocha (Zone 22)', 'Yes', 'Not bothered', '7000002', 'I am available this week'),
  formRow('*OTHER*', 'Carol Newcomer', '', 'No', 'Practice', '7000003', 'I am available this week'),
  formRow('Dan Away', '', '', 'No', COMP, '7000004', 'NOT AVAILABLE'),
  formRow('Alice Example', '', 'Hawks - Latte (Zone 22)', 'No', COMP, '7000001', 'I am available this week'),   // sent twice: one rider
];

// TEAM LIST: a wide tab; blocks of names with the Zwift ID in the column to the right, at DH:DI, FV:FW and GH:GI.
const LETTER_TO_INDEX = L => [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function teamListGrid() {
  const width = LETTER_TO_INDEX('GI') + 1, rows = Array.from({ length: 12 }, () => Array(width).fill(''));
  const put = (col, label, riders) => { const c = LETTER_TO_INDEX(col); rows[1][c] = label; rows[2][c] = 'Rider'; rows[2][c + 1] = 'ID'; riders.forEach(([n, id], i) => { rows[3 + i][c] = n; rows[3 + i][c + 1] = id; }); };
  put('DH', 'Hawks', [['Alice Example', '7000001'], ['Bob Sample', '7000002'], ['Eve Placed', '7000005']]);
  put('FV', 'Kites', [['Carol Newcomer', '7000003'], ['Frank Other', '7000006']]);
  put('GH', 'Mystery Team', [['Gina Nowhere', '7000007'], ['Hugo Nowhere', '7000008']]);
  rows[0][0] = 'TEAM LIST'; rows[5][3] = 'Total'; rows[6][4] = '1054';   // other things on the sheet that are not riders
  return { cols: rows[0].map((_, i) => `C${i}`), rows };
}
beforeEach(async () => {
  app.world.db = {};
  world.sheet = { first: 'Form Responses 1', html: false, tabs: { 'Form Responses 1': { cols: FORM_COLS, rows: FORM_ROWS }, 'TEAM LIST': teamListGrid() } };
  assert.equal((await app.post('/api/ttt/new-week', { date: h.ymd(10) }, A)).status, 200);
});
const imp = (body, token = admin) => app.post('/api/ttt/import-sheet', body, { token });
const board = (body, token = admin) => app.post('/api/ttt/import-board', body, { token });
const view = async () => (await app.get('/api/ttt', A)).body;

test('sign-ups come from the form responses even though the TEAM LIST tab holds the published teams', async () => {
  const p = (await imp({})).body.preview;
  assert.deepEqual(p.rows.map(r => r.name).sort(), ['Alice Example', 'Bob Sample', 'Carol Newcomer', 'Dan Away']);
  const by = Object.fromEntries(p.rows.map(r => [r.name, r]));
  assert.equal(by['Alice Example'].zwid, '7000001', 'the Zwift Power ID answer is used when the roster does not know the rider');
  assert.equal(by['Carol Newcomer'].name, 'Carol Newcomer', 'the *OTHER* answer supplies the name');
  assert.equal(by['Dan Away'].available, false, 'the Availability column, not the zones question');
  assert.equal(by['Alice Example'].available, true);
  assert.deepEqual([by['Alice Example'].style, by['Bob Sample'].style, by['Carol Newcomer'].style], ['race', 'casual', 'casual'], 'the level for this week');
  assert.deepEqual([by['Bob Sample'].doubleUp, by['Alice Example'].doubleUp], [true, false]);
  assert.deepEqual(by['Bob Sample'].preferredNames, ['Magpies', 'Kites']);
  assert.equal(JSON.stringify(p).includes('example.com'), false, 'emails never leave the server');
});

test('applying turns the teams a rider asked for into their preferred teams', async () => {
  const r = await imp({ apply: true });
  assert.equal(r.status, 200);
  const teams = (await view()).week.teams, id = n => teams.find(t => t.name === n).id;
  const bob = (await view()).signups.find(s => s.name === 'Bob Sample');
  assert.deepEqual(bob.preferred, [id('Magpies'), id('Kites')]);
});

test('a named form tab is used, and a workbook with no form tab is explained', async () => {
  process.env.SHEET_TAB_TTT_FORM = 'Sign-ups';
  world.sheet.tabs['Sign-ups'] = world.sheet.tabs['Form Responses 1']; delete world.sheet.tabs['Form Responses 1'];
  assert.equal((await imp({})).status, 200);
  delete process.env.SHEET_TAB_TTT_FORM;
  world.sheet = { first: 'TEAM LIST', html: false, tabs: { 'TEAM LIST': teamListGrid() } };
  const r = await imp({});
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Please select your name/);
});

test('the TEAM LIST board is read wherever the blocks are: columns, labels and who the app already agrees on', async () => {
  await imp({ apply: true });
  const teams = (await view()).week.teams, hawks = teams.find(t => t.name === 'Hawks').id;
  await app.post('/api/ttt/assign', { name: 'Alice Example', teams: [hawks] }, A);          // the app already has Alice on Hawks: the sheet agrees
  await app.post('/api/ttt/assign', { name: 'Carol Newcomer', teams: [teams.find(t => t.name === 'Magpies').id] }, A);   // the sheet says Kites
  const p = (await board({})).body.preview;
  assert.deepEqual(p.blocks.map(b => [b.cols, b.label, b.riders, b.team]), [['DH:DI', 'Hawks', 3, true], ['FV:FW', 'Kites', 2, true], ['GH:GI', 'Mystery Team', 2, false]], 'the columns read are shown, and the other things on the sheet are ignored');
  const st = Object.fromEntries(p.plan.map(x => [x.name, x.status]));
  assert.deepEqual(st, { 'Alice Example': 'same', 'Bob Sample': 'unplaced', 'Eve Placed': 'new', 'Carol Newcomer': 'elsewhere', 'Frank Other': 'new', 'Gina Nowhere': 'no-team', 'Hugo Nowhere': 'no-team' });
  assert.deepEqual(p.plan.find(x => x.name === 'Carol Newcomer').appTeams, ['Magpies']);
  assert.deepEqual(p.counts, { same: 1, new: 2, unplaced: 1, elsewhere: 1, 'no-team': 2 });
  assert.equal((await view()).signups.some(s => s.name === 'Eve Placed'), false, 'a preview writes nothing');
});

test('applying the board places unplaced riders and creates missing sign-ups; riders the app has elsewhere move only on request; full teams are left alone', async () => {
  await imp({ apply: true });
  let teams = (await view()).week.teams;
  await app.post('/api/ttt/assign', { name: 'Carol Newcomer', teams: [teams.find(t => t.name === 'Magpies').id] }, A);
  const done = await board({ apply: true });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.board.created, done.body.board.placed], [2, 4]);
  let v = await view();
  const at = n => (v.assign || {})[n.toLowerCase()];
  const id = n => v.week.teams.find(t => t.name === n).id;
  assert.deepEqual([at('Bob Sample'), at('Eve Placed'), at('Frank Other')], [[id('Hawks')], [id('Hawks')], [id('Kites')]]);
  assert.deepEqual(at('Carol Newcomer'), [id('Magpies')], 'not moved without being asked');
  assert.equal(at('Gina Nowhere'), undefined);
  await board({ apply: true, overwrite: true });
  v = await view();
  assert.deepEqual(at('Carol Newcomer'), [id('Kites')], 'moved when asked');
  // staff only
  assert.equal((await board({}, null)).status, 401);
  assert.equal((await board({}, await app.memberSession('1002', { name: 'Rider Two' }))).status, 401);
});

// The TEAM LIST as the club's sheet really lays it out: a zone cell, then a "(CRYO-GEN Name)" tag, then the pen, the riders' names down that column
// (a Zwift ID beside them in some blocks and not in others), the stats to the right, and tables of other things further down.
function realLayoutGrid() {
  const width = LETTER_TO_INDEX('GI') + 1, rows = Array.from({ length: 30 }, () => Array(width).fill(''));
  const block = (col, zone, tag, pen, riders, ids) => {
    const c = LETTER_TO_INDEX(col);
    rows[0][c] = zone; rows[1][c] = `(CRYO-GEN ${tag})`; rows[2][c] = pen; rows[5][c + 9] = 'ZP Cat';
    riders.forEach((n, i) => { rows[6 + i][c] = n; if (ids) rows[6 + i][c + 1] = ids[i]; rows[6 + i][c + 2] = '3.06'; });
    rows[14][c] = 'Average Power / Riders'; rows[19][c] = 'Latte'; rows[20][c] = 'Time Zones'; rows[21][c] = '09:00'; rows[21][c + 1] = '09:00';
  };
  block('DH', 'Zone 22', 'Hawks', 'PEN A', ['Rider 0', 'Rider 1'], null);                                    // IDs not shown beside the names
  block('FV', 'Zone 22', 'Kites', 'PEN B', ['Rider 2', 'Newcomer Nina'], ['1002', '7000100']);                // IDs shown
  block('GH', 'Zone 8', 'Owls', 'PEN B', [], null);                                                          // a team with nobody this week
  rows[0][3] = 'Time zone >'; rows[1][3] = 'Zwiftpower name tag >';
  return { cols: rows[0].map((_, i) => `C${i}`), rows };
}

test('the real TEAM LIST layout: blocks found by their name tag, riders matched to the roster when no ID is beside them', async () => {
  world.sheet.tabs['TEAM LIST'] = realLayoutGrid();
  await imp({ apply: true });
  const p = (await board({})).body.preview;
  assert.deepEqual(p.blocks.map(b => [b.cols, b.label, b.zone, b.riders, b.withId, b.team]), [['DH:DI', 'Hawks', 'Zone 22', 2, 0, true], ['FV:FW', 'Kites', 'Zone 22', 2, 2, true]], 'the empty Owls block and the stats, tables and headers are left out');
  const by = Object.fromEntries(p.plan.map(x => [x.name, x]));
  assert.deepEqual([by['Rider 0'].zwid, by['Rider 1'].zwid], ['1000', '1001'], 'no ID beside the names: matched to the club roster by name');
  assert.equal(by['Newcomer Nina'].zwid, '7000100', 'an ID beside the name is used');
  assert.equal(by['Rider 0'].status, 'new', 'not signed up here yet');
  const done = await board({ apply: true });
  assert.deepEqual([done.body.board.created, done.body.board.placed], [4, 4]);
  const v = await view(), id = n => v.week.teams.find(t => t.name === n).id;
  assert.deepEqual(v.assign['rider 0'], [id('Hawks')]);
  assert.deepEqual(v.assign['newcomer nina'], [id('Kites')]);
});

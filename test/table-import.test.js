'use strict';
// Results from a pasted table: ZRL team results and DIRT stage points, previewed before anything is saved.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const csv = require('../lib/csv');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
beforeEach(() => { app.world.db = {}; });

test('the table reader handles commas, tabs, semicolons, quotes and a heading row below a title', () => {
  assert.deepEqual(csv.parseTable('a,b\n"x, y",2\n'), [['a', 'b'], ['x, y', '2']]);
  assert.deepEqual(csv.parseTable('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csv.parseTable('a;b\n1;"q ""z"""'), [['a', 'b'], ['1', 'q "z"']]);
  const t = csv.parseTable('Division 4 results\nTeam,Pos,Pts\nA,1,10');
  assert.equal(csv.columns(t, { team: /^team/i, pos: /^pos/i }).header, 1);
});

test('ZRL: team results are matched by name, shown first, saved with the league points rule, kept when the table lacks them, and can be undone', async () => {
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }, { name: 'CRYO-GEN Beta', region: 'eu' }] }, A);
  const table = 'Rank,Team,Teams started\n1,Other Club,8\n3,Alpha,8\n5,CRYO-GEN BETA,8\n';
  const pre = (await app.post('/api/zrl/results-import', { week: 0, csv: table }, A)).body.preview;
  assert.deepEqual(pre.rows.map(r => [r.name, r.pos, r.points]), [['CRYO-GEN Alpha', 3, 6], ['CRYO-GEN Beta', 5, 4]], 'league points: field minus position plus one');
  assert.deepEqual(pre.skipped, ['Other Club']);
  assert.equal((await app.get('/api/zrl', A)).body.results?.['0:cryo-gen-alpha'], undefined, 'a preview saves nothing');
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'cryo-gen-alpha', pos: 2, pts: 7, note: 'checked by hand' }] }, A);
  const done = (await app.post('/api/zrl/results-import', { week: 0, csv: 'Team,Position\nAlpha,3', apply: true }, A)).body;
  assert.equal(done.applied, 1); assert.deepEqual(done.missing, ['CRYO-GEN Beta']);
  const stored = JSON.parse(app.world.db['cg:zrl:results']['0:cryo-gen-alpha']);
  assert.deepEqual([stored.pos, stored.note], [3, 'checked by hand']);
  const entry = (await app.get('/api/auto', A)).body.entries.find(e => /results read from a table/.test(e.summary));
  await app.post('/api/auto/undo', { id: entry.id }, A);
  assert.equal(JSON.parse(app.world.db['cg:zrl:results']['0:cryo-gen-alpha']).pos, 2, 'undo restores what was there');
  assert.equal((await app.post('/api/zrl/results-import', { week: 0, csv: 'Nothing,Here\n1,2' }, A)).status, 400);
  assert.equal((await app.post('/api/zrl/results-import', { week: 0, csv: 'Team,Position\nNobody,1' }, A)).status, 409);
  assert.equal((await app.post('/api/zrl/results-import', { week: 0, csv: table })).status, 401);
});

test('DIRT: points are matched by Zwift ID or name, merged with the places already read, and the team score follows; captains may do it', async () => {
  await app.post('/api/drs/season', { name: 'A', division: 'P', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  for (let i = 0; i < 4; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  const st = (await app.post('/api/drs/stage', { type: 'scratch', date: '2026-11-03' }, A)).body.stages[0];
  await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 4 }, [ID(1)]: { pos: 9 } } }, A);
  const table = `Rider,Zwift ID,Total points\nLad 0,,102\n,${ID(1)},75\n[CRYO-GEN] Lad 2,,50\nSomeone Else,,40\n`;
  const pre = (await app.post('/api/drs/points-import', { stage: st.id, csv: table }, A)).body.preview;
  assert.deepEqual(pre.riders.map(r => [r.name, r.pts]), [['Lad 0', 102], ['Lad 1', 75], ['Lad 2', 50]]);
  assert.deepEqual(pre.skipped, ['Someone Else']); assert.equal(pre.teamPoints, 102 + 75);
  assert.equal((await app.post('/api/drs/points-import', { stage: st.id, csv: table, apply: true }, A)).status, 200);
  const v = (await app.get('/api/drs', A)).body.stages[0];
  assert.deepEqual([v.result.riders[ID(0)].pos, v.result.riders[ID(0)].pts, v.result.teamPoints], [4, 102, 177], 'the place stays, the points arrive');
  await app.post('/api/drs/captains', { zwids: [ID(3)] }, A);
  assert.equal((await app.post('/api/drs/points-import', { stage: st.id, csv: table }, { token: await app.memberSession(ID(3), { name: 'Lad 3' }) })).status, 200);
  assert.equal((await app.post('/api/drs/points-import', { stage: st.id, csv: table }, { token: await app.memberSession(ID(2), { name: 'Lad 2' }) })).status, 403);
});

test('ZRL: a table copied straight off a web page is understood without a heading row, with spaces, one cell per line, "1st", "T2" and arrows; teams match by name words', async () => {
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Hawks', region: 'eu' }, { name: 'CRYO-GEN Magpies', region: 'eu' }] }, A);
  const prev = async csvText => (await app.post('/api/zrl/results-import', { week: 0, csv: csvText }, A));
  const want = [['CRYO-GEN Hawks', 3], ['CRYO-GEN Magpies', 6]];
  // tab separated, no heading, places as 1st/2nd, a club tag after the name, movement arrows
  let r = await prev('1st\tSome Team\t120\n2nd\tOther Squad\t110\n▲2 3rd\tHawks [GB]\t100\n4th\tFoo\t90\n5th\tBar\t80\n6th\tCRYO-GEN Magpies\t70\n');
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.preview.rows.map(x => [x.name, x.pos]), want);
  // two or more spaces between cells
  r = await prev('1   Alpha   9\n2   Beta   8\n3   Hawks   7\n4   Gamma   6\n5   Delta   5\nT6   Magpies   4');
  assert.deepEqual(r.body.preview.rows.map(x => [x.name, x.pos]), want);
  // one cell per line: place, team, points
  r = await prev('1\nAlpha\n90\n2\nBeta\n80\n3\nCRYO-GEN Hawks\n70\n4\nGamma\n60\n5\nDelta\n50\n6\nMagpies\n40\n');
  assert.deepEqual(r.body.preview.rows.map(x => [x.name, x.pos]), want);
  // the number of teams (the largest place) gives the league points: field minus place plus one
  assert.deepEqual(r.body.preview.rows.map(x => x.points), [4, 1]);
  // nothing of ours in it
  assert.equal((await prev('1 Alpha 9\n2 Beta 8\n3 Gamma 7')).status, 400);
  // a table WITH headings still works exactly as before
  r = await prev('Team,Position\nHawks,2\nOther,1\n'); assert.deepEqual(r.body.preview.rows.map(x => [x.name, x.pos]), [['CRYO-GEN Hawks', 2]]);
});

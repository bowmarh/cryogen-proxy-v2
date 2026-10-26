'use strict';
// ZRL staff tools: the riders workbook (.xlsx), regular/dev teams, dev-eligible riders, over-category detection, and a change log that names people.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const h = require('./helpers');
const xlsx = require('../lib/xlsx');

h.setEnv();
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(async () => {
  app.world.db = {};
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10) }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', grade: 'Open B' }, { name: 'CRYO-GEN Beta', region: 'am', grade: 'C' }] }, { token: admin });
});
const A = { get token() { return admin; } };   // admin is set once the app has started
const view = () => app.get('/api/zrl', A).then(r => r.body);
// reads the entries of a zip made by lib/xlsx
function entries(buf) {
  const out = {}; let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18), nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
    const name = buf.toString('utf8', o + 30, o + 30 + nameLen), start = o + 30 + nameLen + extra;
    out[name] = zlib.inflateRawSync(buf.subarray(start, start + size)).toString(); o = start + size;
  }
  return out;
}

test('the xlsx writer makes a valid zip with escaped text and numbers', () => {
  const buf = xlsx.build([{ name: 'A/B?', columns: [{ header: 'Name' }, { header: 'N' }], rows: [['a & <b>', 3], ['=1+1', '']] }]);
  const e = entries(buf);
  assert.deepEqual(Object.keys(e), ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(e['xl/worksheets/sheet1.xml'], /a &amp; &lt;b&gt;/);
  assert.match(e['xl/worksheets/sheet1.xml'], /<v>3<\/v>/);
  assert.match(e['xl/workbook.xml'], /name="A B "/, 'sheet names drop forbidden characters');
  assert.equal(xlsx.crc32(Buffer.from('123456789')), 0xcbf43926, 'the standard CRC-32 check value');
});

test('the riders workbook lists everyone with their team names, dev flags and what needs attention; staff only', async () => {
  for (const [name, zwid, regions, cat] of [['Rider Zero', '1000', ['eu'], 'A'], ['Rider Two', '1002', ['eu'], 'C'], ['No Team', '1003', ['am'], 'D']]) await app.post('/api/zrl/signup', { name, zwid, regions, cat });
  await app.post('/api/zrl/assign', { key: '1000', team: 'cryo-gen-alpha' }, A);   // a ZwiftPower A rider on a B team: over category
  await app.post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' }, A);
  await app.post('/api/zrl/team-kind', { teams: ['cryo-gen-beta'], dev: true }, A);
  assert.equal((await app.get('/api/zrl/riders-xlsx')).status, 401);
  assert.equal((await app.get('/api/zrl/riders-xlsx', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  const r = await app.get('/api/zrl/riders-xlsx', A);
  assert.equal(r.status, 200);
  assert.match(r.body.filename, /round-2-riders\.xlsx$/);
  const e = entries(Buffer.from(r.body.base64, 'base64'));
  const riders = e['xl/worksheets/sheet1.xml'], teams = e['xl/worksheets/sheet2.xml'];
  assert.match(riders, /Rider Zero/); assert.match(riders, /CRYO-GEN Alpha/); assert.match(riders, /Over category \(A on a B team\)/);
  assert.match(riders, /No team/); assert.match(riders, /<v>250<\/v>/, 'FTP from the club roster');
  assert.match(teams, /CRYO-GEN Beta/); assert.match(teams, />Dev</);
  assert.match(e['xl/workbook.xml'], /name="Riders"[\s\S]*name="Teams"/);
});

test('teams are Regular or Dev by a switch and keep it when edited; riders can be marked dev eligible', async () => {
  assert.equal((await app.post('/api/zrl/team-kind', { teams: ['nope'], dev: true }, A)).status, 400);
  assert.equal((await app.post('/api/zrl/team-kind', { teams: [], dev: true }, A)).status, 400);
  assert.equal((await app.post('/api/zrl/team-kind', { teams: ['cryo-gen-beta'], dev: true })).status, 401);
  await app.post('/api/zrl/team-kind', { teams: ['cryo-gen-beta'], dev: true }, A);
  assert.deepEqual((await view()).round.teams.map(t => !!t.dev), [false, true]);
  await app.post('/api/zrl/team-slot', { teams: ['cryo-gen-beta'], slot: 'Tue 18:00 UTC' }, A);
  assert.equal((await view()).round.teams[1].dev, true, 'a slot change keeps it');
  await app.post('/api/zrl/team-kind', { teams: ['cryo-gen-beta'], dev: false }, A);
  assert.equal((await view()).round.teams[1].dev, undefined);
  await app.post('/api/zrl/signup', { name: 'Dev Dan', zwid: '1004', regions: ['eu'], cat: 'D' });
  await app.post('/api/zrl/signup-edit', { key: '1004', devOk: true }, A);
  assert.equal((await view()).signups.find(x => x.key === '1004').devOk, true);
  await app.post('/api/zrl/signup-edit', { key: '1004', devOk: false }, A);
  assert.equal((await view()).signups.find(x => x.key === '1004').devOk, false);
});

test('the change log names the rider and team, and the name the staff member gave', async () => {
  await app.post('/api/zrl/signup', { name: 'Log Lena', zwid: '1001', regions: ['eu'], cat: 'B' });
  await app.call('POST', '/api/zrl/assign', { token: admin, body: { key: '1001', team: 'cryo-gen-alpha' }, headers: { 'X-Staff-Name': encodeURIComponent('Hanna K') } });
  const log = (await app.get('/api/zrl/log', A)).body.entries;
  const e = log.find(x => x.route === 'zrl/assign');
  assert.equal(e.who, 'Hanna K');
  assert.match(e.what, /rider: Log Lena · team: CRYO-GEN Alpha/);
  await app.call('POST', '/api/zrl/team-kind', { token: admin, body: { teams: ['cryo-gen-beta'], dev: true }, headers: { 'X-Staff-Name': '<script>x</script>' } });
  assert.doesNotMatch((await app.get('/api/zrl/log', A)).body.entries.find(x => x.route === 'zrl/team-kind').who, /[<>]/, 'the name is cleaned');
});

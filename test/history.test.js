'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
const A = { get token() { return admin; } };

// Reads the text parts of an .xlsx (a zip) without a library: walks the local file headers and inflates each part.
function parts(buf) {
  const out = {}; let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8), csize = buf.readUInt32LE(o + 18), n = buf.readUInt16LE(o + 26), m = buf.readUInt16LE(o + 28);
    const name = buf.toString('utf8', o + 30, o + 30 + n), data = buf.subarray(o + 30 + n + m, o + 30 + n + m + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'); o += 30 + n + m + csize;
  }
  return out;
}

test('club history: finished rounds go into one workbook; staff only; nothing is changed', async () => {
  assert.equal((await app.get('/api/history/export')).status, 401);
  await app.post('/api/zrl/round', { name: 'Round One', start: h.ymd(-20), closes: h.ymd(-30), weeks: 2 }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'History Alpha', region: 'eu', grade: 'Open B' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Hist Rider', zwid: '7001', regions: ['eu'], cat: 'B' });
  await app.post('/api/zrl/assign', { key: '7001', team: 'history-alpha' }, A);
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'history-alpha', pos: 2, pts: 15 }] }, A);
  await app.post('/api/zrl/round', { name: 'Round Two', start: h.ymd(7), closes: h.ymd(3) }, A);   // archives round one
  const before = JSON.stringify(app.world.db);
  const r = (await app.get('/api/history/export', A)).body;
  assert.match(r.filename, /^cryogen-history-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const x = parts(Buffer.from(r.base64, 'base64'));
  const wb = x['xl/workbook.xml'];
  for (const name of ['ZRL rounds', 'ZRL results', 'ZRL riders', 'Ladder seasons', 'DIRT seasons']) assert.ok(wb.includes(name), name);
  const all = Object.keys(x).filter(k => k.startsWith('xl/worksheets/')).map(k => x[k]).join(' ');
  assert.ok(all.includes('Round One') && all.includes('History Alpha') && all.includes('Hist Rider'));
  assert.ok(!all.includes('Round Two'), 'only finished rounds');
  assert.equal(JSON.stringify(app.world.db), before, 'read only');
});

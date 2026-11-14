'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createTableViews = require('../lib/tableviews');

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const mk = (role = 'admin') => {
  let store = null;
  const redis = async cmds => cmds.map(([c, k, v]) => { if (c === 'GET') return store; if (c === 'SET') { store = v; return 'OK'; } return null; });
  const requireRole = (req, roles) => { if (!roles.includes(req.role)) throw new HttpError(403, 'no'); return req.role; };
  return { tv: createTableViews({ redis, HttpError, requireRole }), req: { role } };
};

test('staff save views for a list and read them back; names are cleaned and capped', async () => {
  const { tv, req } = mk('mod');
  const big = Array.from({ length: 20 }, (_, i) => ({ name: 'v' + i, q: 'x', sort: null }));
  const r = await tv.routes['POST /api/tableviews'](req, { sig: 'members', views: [{ name: '  <b>Late</b> ', q: 'abc', sort: { col: 2, dir: -1 } }, { name: '', q: 'x' }, { name: 'bad', sort: { col: 'x', dir: 9 } }, ...big] });
  assert.equal(r.views.members.length, 12, 'twelve at most, empty names dropped');
  assert.ok(r.views.members.every(v => !/[<>]/.test(v.name)));
  assert.deepEqual((await tv.routes['GET /api/tableviews'](req)).views.members.at(-1).name, 'v19');
});

test('saving an empty list removes that list; one list does not disturb another', async () => {
  const { tv, req } = mk();
  await tv.routes['POST /api/tableviews'](req, { sig: 'a', views: [{ name: 'one', q: '1' }] });
  await tv.routes['POST /api/tableviews'](req, { sig: 'b', views: [{ name: 'two', q: '2' }] });
  const r = await tv.routes['POST /api/tableviews'](req, { sig: 'a', views: [] });
  assert.deepEqual(Object.keys(r.views), ['b']);
});

test('riders can neither read nor write staff views, and a save needs a list name', async () => {
  const { tv } = mk('member');
  await assert.rejects(tv.routes['GET /api/tableviews']({ role: 'member' }), { status: 403 });
  await assert.rejects(tv.routes['POST /api/tableviews']({ role: 'member' }, { sig: 'a', views: [] }), { status: 403 });
  const { tv: t2, req } = mk();
  await assert.rejects(t2.routes['POST /api/tableviews'](req, { views: [] }), { status: 400 });
});

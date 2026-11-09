'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createZrlHelper = require('../lib/zrlhelper');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const kit = ({ reg = {}, deadline = '2026-11-11T09:00:00Z', unreachable = ['4'] } = {}) => {
  const sent = [];
  const data = { round: { name: 'Round 2', open: false, published: true, rosterSize: 2, wtrlDeadline: deadline,
    teams: [{ id: 'a', name: 'Alpha', region: 'EU', captain: '1' }, { id: 'b', name: 'Beta', region: 'AM', captain: '' }, { id: 'c', name: 'Gamma', region: 'EU', captain: '3' }] },
  signups: [{ key: '1', name: 'Ann', in: true, regions: ['EU'], cat: 'B' }, { key: '2', name: 'Bo', in: true, regions: ['EU'], cat: 'B' }, { key: '3', name: 'Cy', in: true, regions: ['EU'], cat: 'C' },
    { key: '4', name: 'Di', in: true, regions: ['EU'], cat: 'B' }, { key: '5', name: 'Ed', in: true, regions: ['AS'], cat: 'A' }, { key: '6', name: 'Flo', in: false, regions: ['EU'] }],
  assign: { 1: ['a'], 2: ['a'], 3: ['c'] }, weekly: { reg } };
  const h = createZrlHelper({ HttpError: Error, requireRole() {}, zrl: { load: async () => data }, reach: { unreachable: async ids => ids.filter(z => unreachable.includes(String(z))) },
    notify: async (z, text, o) => { sent.push({ z, text, key: o.key }); return z !== '9'; }, siteUrl: 'https://club.test' });
  return { h, sent };
};

test('riders who are racing without a team are listed with the teams in their region that still have room, those who cannot be messaged first', async () => {
  const d = await kit().h.build(NOW);
  assert.deepEqual(d.unplaced.map(r => [r.name, r.reachable]), [['Di', false], ['Ed', true]]);
  assert.deepEqual(d.unplaced[0].options.map(o => o.name), ['Gamma'], 'Alpha is full (2 of 2); Beta is another region');
  assert.deepEqual(d.unplaced[1].options, [], 'nobody is in the Asia region with room: say so rather than guess');
  assert.equal(d.unreachable, 1); assert.ok(!d.unplaced.some(r => r.name === 'Flo'), 'a rider who is not racing is not listed');
});

test('teams that have riders but are not registered on WTRL are listed with the deadline; only those', async () => {
  const w = (await kit({ reg: { a: true } }).h.build(NOW)).wtrl;
  assert.deepEqual(w.unregistered.map(t => t.name), ['Gamma']); assert.equal(w.hoursLeft, 21); assert.equal(w.passed, false);
  assert.deepEqual((await kit({ reg: { a: true, c: true } }).h.build(NOW)).wtrl.unregistered, []);
});

test('reminding captains asks each unregistered team captain once per 12 hours and names the teams with nobody to ask', async () => {
  const { h, sent } = kit(), r = await h.remind(NOW);
  assert.deepEqual(sent.map(s => s.z).sort(), ['1', '3']); assert.equal(r.sent, 2);
  assert.match(sent[0].text, /deadline is within a day/);
  assert.match(sent[0].key, /^wtrl-remind:[ac]:\d+$/);
  const none = await kit({ reg: { a: true, c: true } }).h.remind(NOW); assert.equal(none.sent, 0); assert.match(none.note, /registered/);
});

test('the routes are for staff only', async () => {
  const hh = require('./helpers'); hh.setEnv(); const app = await hh.startApp(hh.createWorld());
  try {
    assert.equal((await app.get('/api/staff/zrl-helper')).status, 401);
    assert.equal((await app.get('/api/staff/zrl-helper', { token: await app.memberSession('1002') })).status, 401);
    assert.equal((await app.get('/api/staff/zrl-helper', { token: await app.login('mod') })).status, 200);
    assert.equal((await app.post('/api/staff/zrl-helper/remind', {}, { token: await app.login('admin') })).status, 200);
  } finally { await app.close(); }
});

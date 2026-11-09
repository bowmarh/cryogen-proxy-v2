'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createCockpit = require('../lib/cockpit');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const riders = (st) => [['1', 'Ann Lee', st['1']], ['2', 'Bo Dunn', st['2']], ['3', 'Cy Ray', st['3']], ['4', 'Di Fox', st['4']]].map(([zwid, name, status]) => ({ zwid, name, status: status || '' }));
function kit({ captain = true, status = { 1: 'yes', 2: 'maybe', 3: 'no' } } = {}) {
  const sent = [];
  const weeks = [{ i: 0, date: '2026-11-03', lineup: [], riders: riders(status) }, { i: 1, date: '2026-11-17', lineup: [], riders: riders(status) }];
  const zrl = { load: async () => ({ round: { name: 'Round 2', racing: 3 } }), loadWeekly: async () => ({}), loadResults: async () => ({}),
    myZrl: () => ({ captainOf: captain ? [{ id: 't1', name: 'CRYO-GEN Beta', weeks }] : [] }) };
  const live = { events: async () => [{ kind: 'zrl', id: '1:t1', at: NOW + 3600000, riders: [{ zwid: '1', inPen: '2026-11-17T18:00:00Z' }] }] };
  const fetchRoster = async () => ({ riders: [{ riderId: 1, race: { current: { rating: 1500 } } }, { riderId: 2, race: { current: { rating: 1800 } } }, { riderId: 4, race: { current: { rating: 900 } } }] });
  const notify = async (zwid, text, o) => { if (zwid === '4') return false; sent.push({ zwid, text, key: o.key }); return true; };
  const c = createCockpit({ redis: async () => [], HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, memberFromRequest: () => ({ zwid: '9', name: 'Cap Tain' }), zrl, live, adminReq: () => ({}), fetchRoster, notify, siteUrl: 'https://club.test' });
  return { c, sent };
}

test('a captain sees the next race: who said what, who is in the pen and a suggested line-up', async () => {
  const { c } = kit();
  const d = await c.mine({ zwid: '9', name: 'Cap Tain' }, NOW), n = d.teams[0].next;
  assert.equal(d.captain, true); assert.equal(n.week, 2, 'the race that has already happened is skipped');
  assert.deepEqual(n.yes, ['Ann Lee']); assert.deepEqual(n.maybe, ['Bo Dunn']); assert.deepEqual(n.no, ['Cy Ray']); assert.deepEqual(n.pending, ['Di Fox']);
  assert.deepEqual(n.inPen, ['Ann Lee']);
  assert.deepEqual(n.suggestion, ['Ann Lee', 'Bo Dunn'], 'yes first, then maybe; only as many as answered');
  assert.equal(n.short, 2, 'three race and only one has said yes');
});

test('a rider who does not captain a team gets no cockpit', async () => {
  assert.deepEqual(await kit({ captain: false }).c.mine({ zwid: '9' }, NOW), { captain: false });
});

test('the ask goes only to riders who have not answered, once per 12 hours, and says how many it reached', async () => {
  const { c, sent } = kit({ status: { 1: 'yes', 2: '', 3: '', 4: '' } });
  const r = await c.nudge({ zwid: '9', name: 'Cap Tain' }, { team: 't1', week: 1 }, NOW);
  assert.deepEqual(sent.map(s => s.zwid), ['2', '3']); assert.equal(r.sent, 2); assert.equal(r.pending, 3);
  assert.match(r.note, /Asked 2 of 3/);
  assert.match(sent[0].text, /Hi Bo, Cap here \(captain of CRYO-GEN Beta\): can you race 2026-11-17\?/);
  assert.match(sent[0].key, /^cockpit:t1:1:2:\d+$/, 'the key makes a repeat inside 12 hours a no-op');
});

test('the ask is refused for a team the rider does not captain and for races already run', async () => {
  const { c } = kit();
  await assert.rejects(() => c.nudge({ zwid: '9' }, { team: 'someone-elses', week: 1 }, NOW), /only ask riders on a team you captain/);
  await assert.rejects(() => c.nudge({ zwid: '9' }, { team: 't1', week: 0 }, NOW), /already happened/);
});

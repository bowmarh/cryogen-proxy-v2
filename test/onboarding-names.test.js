'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createOnboarding = require('../lib/onboarding');

test('the New members list shows names: the club roster first, then the cryogen.team member record, and the Zwift ID only when neither knows them', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const NOW = Date.parse('2026-11-04T10:00:00Z'), at = d => new Date(NOW - d * 86400000).toISOString();
  db['cg:onboard:seen'] = { 1: JSON.stringify({ at: at(30), seed: true }), 100: JSON.stringify({ at: at(1) }), 200: JSON.stringify({ at: at(2) }), 300: JSON.stringify({ at: at(3) }) };
  const o = createOnboarding({ redis, HttpError: Error, requireRole() {}, memberFromRequest() {}, activeMembers: async () => ['1', '100', '200', '300'], siteUrl: 'https://club.test',
    notify: async () => false, verifiedLinks: async () => new Set(), teamSets: async () => new Set(),
    fetchRoster: async () => ({ riders: [{ riderId: 100, name: 'Ann [CRYO-GEN]' }], members: [{ zwift_id: '100', name: 'Ann Lee' }, { zwift_id: '200', name: ' Bo Dunn ' }, { zwift_id: 'TBD', name: 'No Id' }] }) });
  const list = await o.scan(NOW);
  const by = Object.fromEntries(list.map(x => [x.zwid, x.name]));
  assert.deepEqual(by, { 100: 'Ann [CRYO-GEN]', 200: 'Bo Dunn', 300: '300' });
});

test('when the member records are unavailable the list still works and shows the ID', async () => {
  const db = {}, redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const NOW = Date.parse('2026-11-04T10:00:00Z');
  db['cg:onboard:seen'] = { 1: JSON.stringify({ at: new Date(NOW - 9e9).toISOString(), seed: true }), 200: JSON.stringify({ at: new Date(NOW - 86400000).toISOString() }) };
  const o = createOnboarding({ redis, HttpError: Error, requireRole() {}, memberFromRequest() {}, activeMembers: async () => ['1', '200'], siteUrl: '', notify: async () => false, verifiedLinks: async () => new Set(), teamSets: async () => new Set(),
    fetchRoster: async () => ({ riders: [], members: null }) });
  assert.deepEqual((await o.scan(NOW)).map(x => [x.zwid, x.name]), [['200', '200']]);
});

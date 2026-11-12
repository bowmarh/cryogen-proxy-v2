'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const createRaceWeek = require('../lib/raceweek'), createEngagement = require('../lib/engagement'), createLiveCheck = require('../lib/livecheck'), createInteractions = require('../lib/discord-interactions');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };
const DAY = 86400000, iso = ms => new Date(ms).toISOString().slice(0, 10);

test('race week: ask 6-5 days out, remind 4-3 days out, propose 2-1 days out; each step once per team, only when on; the captain approves with a tap and only the captain can', async () => {
  const { db, redis } = mem(), asked = [], mails = [], dms = [], applied = [], posts = [], race = Date.parse('2026-11-10T00:00:00Z');
  const round = { name: 'R2', start: '2026-11-10', weeks: 2, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1', captainName: 'Ann Lee' }] }, lineup = {};
  const zrl = { load: async () => ({ round, signups: [], assign: {} }), loadWeekly: async () => ({ avail: {}, lineup }) };
  const aiops = { discordAsk: async b => { asked.push(b.step); return { unreachableZwids: ['3'] }; }, lineupSuggest: async () => ({ picks: [{ zwid: '2', name: 'Bo Dunn', why: 'Said yes' }, { zwid: '3', name: 'Cy Ray', why: 'Maybe' }], short: 0 }) };
  const rw = createRaceWeek({ redis, HttpError, requireRole: () => {}, zrl, aiops, mail: { autoSend: async b => { mails.push(b); return { sent: true }; } }, notify: async (z, t, o) => { dms.push([z, t, o]); return z !== '9'; }, lineupButtons: (w, t) => `buttons:${w}:${t}`, applyLineup: async (...a) => applied.push(a), discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test' });
  assert.deepEqual(await rw.tick(race - 6 * DAY), [], 'off by default'); await rw.routes['POST /api/raceweek/settings']({}, { on: true });
  assert.deepEqual(await rw.tick(race - 8 * DAY), [], 'too early'); assert.deepEqual(await rw.tick(race - 6 * DAY), ['raceweek-ask-t1']); assert.deepEqual(await rw.tick(race - 5 * DAY), [], 'once');
  assert.deepEqual(asked, ['ask']); assert.equal(mails[0].zwids[0], '3'); assert.match(mails[0].body, /\(\{rsvp\}&w=0\)/); assert.equal(mails[0].category, 'service');
  assert.deepEqual(await rw.tick(race - 4 * DAY), ['raceweek-remind-t1']); assert.deepEqual(asked, ['ask', 'remind']); assert.match(mails[1].body, /A quick reminder/);
  assert.deepEqual(await rw.tick(race - 2 * DAY), ['raceweek-propose-t1']); assert.equal(dms[0][0], '1'); assert.match(dms[0][1], /Hi Ann, here is a proposed Alpha line-up for race 1[\s\S]*- Bo Dunn \(Said yes\)/); assert.equal(dms[0][2].components, 'buttons:0:t1');
  await assert.rejects(() => rw.lineupAction('2', 0, 't1', 'approve'), /Only the team captain/); assert.match((await rw.lineupAction('1', 0, 't1', 'skip')).text, /pick the line-up yourself/); assert.deepEqual(applied, []);
  assert.match((await rw.lineupAction('1', 0, 't1', 'approve')).text, /Line-up approved and set \(Bo Dunn, Cy Ray\)/); assert.deepEqual(applied, [['1', 't1', 0, ['2', '3']]]);
  const st = await rw.routes['GET /api/raceweek']({}); assert.equal(st.settings.on, true); assert.equal(st.doneSteps.length, 3);
  const full = createRaceWeek({ redis: mem().redis, HttpError, requireRole: () => {}, zrl: { ...zrl, loadWeekly: async () => ({ avail: {}, lineup: { '0:t1': ['1', '2'] } }) }, aiops, mail: null, notify: async () => true, lineupButtons: () => [], applyLineup: async () => {}, discord: async () => true });
  await full.routes['POST /api/raceweek/settings']({}, { on: true }); await full.tick(race - 2 * DAY); assert.equal(dms.length, 1, 'a team with a full line-up is not chased');
  const orphan = createRaceWeek({ redis: mem().redis, HttpError, requireRole: () => {}, zrl, aiops, mail: null, notify: async () => false, lineupButtons: () => [], applyLineup: async () => {}, discord: async (c, b) => { posts.push(b.content); return true; } });
  await orphan.routes['POST /api/raceweek/settings']({}, { on: true }); await orphan.tick(race - 1 * DAY); assert.ok(posts.some(p => /captain could not be reached/.test(p)), 'staff are told when the captain cannot be reached');
});

test('a captain\'s Approve tap in Discord applies the proposal; a stranger\'s tap and a bad signature do nothing', async () => {
  const kp = crypto.generateKeyPairSync('ed25519'), pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), got = [];
  const di = createInteractions({ publicKey: () => pub, zwidOfDiscord: async d => ({ D1: '1', D2: '2' })[d] || null, answer: async () => {}, lineupAction: async (z, w, t, a) => { got.push([z, w, t, a]); if (z !== '1') throw new Error('Only the team captain can answer this.'); return { text: 'Line-up approved and set.' }; } });
  const send = (body, key = kp.privateKey) => { const raw = JSON.stringify(body), ts = String(Date.now()), sig = crypto.sign(null, Buffer.from(ts + raw), key).toString('hex'); return di.handle(raw, { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }); };
  const tap = (user, id) => send({ type: 3, user: { id: user }, data: { custom_id: id }, message: { content: 'Proposed line-up', components: [] } });
  const ok = await tap('D1', 'lu|0|t1|approve'); assert.equal(ok.status, 200); assert.match(ok.body.data.content, /✔ Line-up approved and set\./); assert.deepEqual(got, [['1', 0, 't1', 'approve']]);
  assert.match((await tap('D2', 'lu|0|t1|approve')).body.data.content, /could not do that: Only the team captain/); assert.match((await tap('D9', 'lu|0|t1|approve')).body.data.content, /could not tell who you are/);
  assert.equal((await send({ type: 3, user: { id: 'D1' }, data: { custom_id: 'lu|0|t1|approve' } }, crypto.generateKeyPairSync('ed25519').privateKey)).status, 401);
  const b = di.lineupButtons(2, 't1')[0].components; assert.deepEqual(b.map(x => x.custom_id), ['lu|2|t1|approve', 'lu|2|t1|skip']);
});

test('engagement: bands from the member list, a monthly snapshot saved once, ZRL line-ups filled race by race, and the most at risk', async () => {
  const { redis } = mem(), round = { start: '2026-11-03', weeks: 2, racing: 2, teams: [{ id: 't1' }, { id: 't2' }] };
  const people = [{ inClub: true, tier: 'full', daysSinceRace: 40 }, { inClub: true, tier: 'full', daysSinceRace: 100 }, { inClub: true, tier: 'full', daysSinceRace: 300 }, { inClub: true, tier: 'full', daysSinceRace: null }, { inClub: true, tier: 'associate', daysSinceRace: 100 }];
  const e = createEngagement({ redis, requireRole: () => {}, tidy: { analyse: async () => ({ total: 20, inactive: people, counts: { notInClub: 3 } }) }, zrl: { load: async () => ({ round }), loadWeekly: async () => ({ lineup: { '0:t1': ['1', '2'], '0:t2': ['3'] } }), loadResults: async () => ({ '0:t1': { pos: 1 } }) }, aiops: { churn: async () => ({ members: [{ name: 'Bo', days: 100, level: 'high' }] }) } });
  const o = await e.routes['GET /api/engagement']({}, {}, {}); assert.deepEqual(Object.fromEntries(o.bands.map(b => [b.key, b.count])), { active: 13, cooling: 1, quiet: 1, gone: 2 }); assert.equal(o.total, 20);
  assert.deepEqual([o.zrl[0].filled, o.zrl[0].teamsScored, o.zrl[1].filled], [75, 1, 0]); assert.equal(o.atRisk[0].name, 'Bo');
  const now = Date.parse('2026-11-05T10:00:00Z'); assert.deepEqual(await e.runSchedule(now), [], 'quiet housekeeping'); await e.runSchedule(now + DAY);
  const o2 = await e.routes['GET /api/engagement']({}, {}, {}); assert.equal(o2.history.length, 1); assert.equal(o2.history[0].month, '2026-11'); assert.equal(o2.history[0].active, 13);
});

test('the go-live check runs real tests, keeps what happened, and link checks wait for a person to confirm', async () => {
  const { redis } = mem(), sent = [], pdf = Buffer.from('%PDF-1.4 x');
  const lc = createLiveCheck({ redis, HttpError, requireRole: () => {}, mail: { routes: { 'POST /api/mail/test': async (r, b) => sent.push(b.to) }, tokenFor: (z, e) => `${z}.tok` }, discord: async () => false, notify: async z => z === '24650', aiops: { monthlyPdf: async () => pdf }, controlRoom: { systems: async () => [{ name: 'Email service', level: 'bad', detail: 'paused' }] }, ai: { enabled: () => true, available: async () => true }, siteUrl: 'https://club.test' });
  const run = async b => (await lc.routes['POST /api/livecheck/run']({}, b)).result;
  assert.equal((await run({ id: 'storage' })).ok, true); assert.equal((await run({ id: 'pdf' })).ok, true); assert.equal((await run({ id: 'ai' })).ok, true);
  assert.equal((await run({ id: 'discord-admin' })).ok, false, 'a refused Discord post is a failure'); assert.equal((await run({ id: 'discord-dm', zwid: '24650' })).ok, true); assert.equal((await run({ id: 'discord-dm', zwid: '1' })).ok, false);
  const w = await run({ id: 'watchdog' }); assert.equal(w.ok, false); assert.match(w.note, /Email service: paused/);
  const e = await run({ id: 'email', to: 'me@x.test' }); assert.deepEqual(sent, ['me@x.test']); assert.equal(e.ok, true);
  await assert.rejects(() => run({ id: 'email' }), /Enter your email/); await assert.rejects(() => run({ id: 'nope' }), /does not exist/); await assert.rejects(() => run({ id: 'radio' }), /confirmed by hand/);
  const r = await run({ id: 'rsvp', zwid: '24650', to: 'Me@X.test' }); assert.equal(r.ok, null); assert.equal(r.link, 'https://club.test/api/rsvp?t=24650.tok');
  const m = (await lc.routes['POST /api/livecheck/mark']({}, { id: 'rsvp', ok: true })).result; assert.equal(m.ok, true); assert.equal(m.confirmed, true);
  const list = (await lc.routes['GET /api/livecheck']({})).items; assert.equal(list.find(i => i.id === 'rsvp').result.ok, true); assert.equal(list.find(i => i.id === 'radio').result, null);
});

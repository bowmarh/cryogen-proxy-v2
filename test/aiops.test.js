'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createAiOps = require('../lib/aiops');

h.setEnv();

const ROUND = { name: 'Round 2', weeks: 4, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1' }, { id: 't2', name: 'Bravo', captain: '' }] };
const SIGN = [['1', 'Ann Lee', 'A'], ['2', 'Bo Dunn', 'B'], ['3', 'Cy Ray', 'B'], ['4', 'Di Fox', 'C']].map(([zwid, name, cat]) => ({ key: 'k' + zwid, zwid, name, cat, in: true }));
function kit({ ai = null, results = {}, lineup = {}, avail = {}, inactive = [], mailOn = true, mailEnabled = true } = {}) {
  const db = {}, posts = [], sent = [], redis = async cmds => cmds.map(c => h.redisRun(db, c)), opt = [];
  const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
  const stubAi = ai || { enabled: () => false, available: async () => false, complete: async () => { throw new Error('off'); }, json: t => { try { return JSON.parse(t); } catch (e) { return null; } }, clip: (v, n) => String(v == null ? '' : v).trim().slice(0, n) };
  const state = { results };
  const zrl = { load: async () => ({ round: ROUND, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t1'], k4: ['t2'] } }), loadResults: async () => state.results, loadWeekly: async () => ({ lineup, avail }),
    availOf: (w, week, z) => avail[`${week}:${z}`] || '', standingsOf: (round, res) => ({ groups: [{ name: 'Div 1', teams: [{ id: 't1', rank: 2, total: 40 }, { id: 't2', rank: 1, total: 60 }] }] }) };
  const tidy = { analyse: async () => ({ inactive }) };
  const mail = mailOn ? { routes: { 'POST /api/mail/send-one': async (req, b) => { sent.push(['one', b]); return { ok: true }; } }, optOutAddress: async (e, s) => opt.push([e, s]),
    autoSend: async b => { if (!mailEnabled) return { sent: false, why: 'off' }; sent.push(['auto', b]); return { sent: true, id: 'c1' }; } } : null;
  const o = createAiOps({ redis, HttpError, requireRole: () => 'admin', staffNameOf: () => 'Ricks', ai: stubAi, zrl, tidy, fetchRoster: async () => ({ riders: [{ riderId: 1, name: 'Ann Lee', zpCategory: 'A', race: { current: { rating: 1800 }, finishes: 20 } }, { riderId: 2, name: 'Bo Dunn', race: { current: { rating: 1500 }, finishes: 3 } }, { riderId: 3, name: 'Cy Ray', race: { current: { rating: 1600 }, finishes: 9 } }] }),
    publicClub: async () => ({ podium: [] }), digest: async () => ({ needsAttention: 0 }), discord: async (ch, b) => { posts.push([ch, b.content]); return true; }, mail, siteUrl: 'https://club.test' });
  return { o, db, posts, sent, opt, state, HttpError };
}
const call = (k, route, body) => k.o.routes[route]({}, body || {});

test('race radio is off until switched on; switching on replays nothing old; each new or changed result is posted once, per team', async () => {
  const k = kit({ results: { '0:t1': { pos: 3, pts: 20 } } });
  assert.deepEqual(await k.o.radioTick(), [], 'off by default'); await call(k, 'POST /api/aiops/settings', { radio: { on: true } });
  assert.deepEqual(await k.o.radioTick(), [], 'the result that was already in is not replayed');
  k.state.results = { '0:t1': { pos: 3, pts: 20 }, '0:t2': { pos: 1, pts: 30, note: 'great' } };
  assert.equal((await k.o.radioTick()).length, 1); assert.match(k.posts[0][1], /Bravo.*finished 1st in race 1, 30 points\. Now 1st of 2 in Div 1/);
  assert.deepEqual(await k.o.radioTick(), [], 'once');
  k.state.results['0:t1'] = { pos: 2, pts: 24 }; assert.equal((await k.o.radioTick()).length, 1); assert.match(k.posts[1][1], /Alpha.*2nd/);
});

test('the radio uses the AI wording when it is on, with no rider names, and falls back to plain wording when it fails', async () => {
  const seen = [], ai = { enabled: () => true, available: async () => true, json: JSON.parse, clip: (v, n) => String(v).slice(0, n), complete: async o => { seen.push(o); return '🏁 **Bravo** smashed it!'; } };
  const k = kit({ ai }); await call(k, 'POST /api/aiops/settings', { radio: { on: true } }); k.state.results = { '1:t2': { pos: 1, pts: 30 } };
  await k.o.radioTick(); assert.equal(k.posts[0][1], '🏁 **Bravo** smashed it!'); assert.ok(!/Ann|Bo Dunn/.test(JSON.stringify(seen)));
  const bad = kit({ ai: { ...ai, complete: async () => { throw new Error('down'); } } }); await call(bad, 'POST /api/aiops/settings', { radio: { on: true } }); bad.state.results = { '1:t2': { pos: 4 } };
  await bad.o.radioTick(); assert.match(bad.posts[0][1], /finished 4th in race 2/);
});

test('the smart line-up picks those who said yes first, then maybes, then by rating, leaves out anyone who said no, and changes nothing', async () => {
  const k = kit({ avail: { '0:1': 'maybe', '0:2': 'yes', '0:3': 'yes' } }), r = await call(k, 'POST /api/aiops/lineup', { team: 't1', week: 0 });
  assert.deepEqual(r.picks.map(p => p.name), ['Cy Ray', 'Bo Dunn'], 'two yes answers, highest rating first'); assert.deepEqual(r.bench.map(p => p.name), ['Ann Lee']); assert.match(r.picks[0].why, /Said yes, vELO 1600/);
  const no = kit({ avail: { '0:2': 'no', '0:3': 'no' } }), r2 = await call(no, 'POST /api/aiops/lineup', { team: 't1', week: 0 });
  assert.equal(r2.picks.length, 1); assert.equal(r2.short, 1); assert.equal(r2.declined, 2);
  await assert.rejects(() => call(k, 'POST /api/aiops/lineup', { team: 'nope' }), /does not exist/);
});

test('ask the club: the AI sees rider names as Rider 1 and the answer has them put back; it needs the AI to be on', async () => {
  const seen = [], ai = { enabled: () => true, available: async () => true, json: JSON.parse, clip: (v, n) => String(v).trim().slice(0, n), complete: async o => { seen.push(o.user); return 'Rider 1 has 20 finishes and is a strong climber.'; } };
  const k = kit({ ai }), r = await call(k, 'POST /api/aiops/ask', { question: 'How is Ann Lee doing?' });
  assert.match(seen[0], /How is Rider 1 doing/); assert.ok(!seen[0].includes('Ann Lee')); assert.match(r.answer, /^Ann Lee has 20 finishes/);
  await assert.rejects(() => call(kit(), 'POST /api/aiops/ask', { question: 'Anything?' }), /AI switched on/); await assert.rejects(() => call(k, 'POST /api/aiops/ask', { question: '  ' }), /Type a question/);
});

test('the churn radar ranks drifting members, drafts a note with {first}, and only an admin approval emails it', async () => {
  const k = kit({ inactive: [{ zwid: '2', name: 'Bo Dunn', inClub: true, tier: 'full', daysSinceRace: 120, finishes: 3 }, { zwid: '3', name: 'Cy Ray', inClub: true, tier: 'full', daysSinceRace: 30, finishes: 30 }, { zwid: '9', name: 'Gone', inClub: false, tier: 'full', daysSinceRace: 100, finishes: 1 }, { zwid: '8', name: 'Assoc', inClub: true, tier: 'associate', daysSinceRace: 90, finishes: 1 }] });
  const r = await call(k, 'GET /api/aiops/churn'); assert.deepEqual(r.members.map(m => [m.name, m.level]), [['Bo Dunn', 'high'], ['Cy Ray', 'low']]);
  const d = await call(k, 'POST /api/aiops/churn-draft', { zwid: '2' }); assert.match(d.body, /Hi \{first\}/); assert.equal(d.subject, 'We would love to see you back');
  await assert.rejects(() => call(k, 'POST /api/aiops/churn-draft', { zwid: '1' }), /not on the radar/);
  await call(k, 'POST /api/aiops/churn-send', { zwid: '2', subject: d.subject, body: d.body }); assert.deepEqual([k.sent[0][0], k.sent[0][1].zwid, k.sent[0][1].category], ['one', '2', 'service']);
});

test('a team report goes to that team\'s lineup and captain through the Email feature, once, and only when there is a result', async () => {
  const k = kit({ results: { '0:t1': { pos: 2, pts: 24 } }, lineup: { '0:t1': ['2', '3'] } });
  const pre = await call(k, 'POST /api/aiops/team-report', { team: 't1', week: 0 }); assert.equal(pre.recipients, 3, 'two in the line-up plus the captain'); assert.match(pre.body, /Alpha finished 2nd in race 1 and scored 24 points\. The team is now 2nd of 2/); assert.equal(k.sent.length, 0, 'a preview sends nothing');
  const out = await call(k, 'POST /api/aiops/team-report', { team: 't1', week: 0, send: true }); assert.equal(out.sent, true);
  assert.deepEqual(k.sent[0][1].zwids.sort(), ['1', '2', '3']); assert.equal(k.sent[0][1].category, 'service');
  await assert.rejects(() => call(k, 'POST /api/aiops/team-report', { team: 't2', week: 0 }), /no result/);
});

test('automatic team reports follow the radio: only when switched on, one per result, and a refused send can be tried again', async () => {
  const k = kit({ results: {}, mailEnabled: false }); await call(k, 'POST /api/aiops/settings', { radio: { on: true }, reports: { auto: true } });
  k.state.results = { '0:t2': { pos: 1, pts: 30 } }; await k.o.radioTick(); assert.equal(k.sent.length, 0, 'email is off, nothing goes');
  const on = kit({ results: {} }); await call(on, 'POST /api/aiops/settings', { radio: { on: true }, reports: { auto: true } }); on.state.results = { '0:t2': { pos: 1, pts: 30 } }; await on.o.radioTick(); await on.o.radioTick();
  assert.equal(on.sent.length, 1); assert.equal(on.sent[0][1].who, 'automatic'); const off = kit({ results: {} }); await call(off, 'POST /api/aiops/settings', { radio: { on: true } }); off.state.results = { '0:t2': { pos: 1 } }; await off.o.radioTick(); assert.equal(off.sent.length, 0);
});

test('reply triage: opt-outs are honoured at once, complaints alert the admins, questions get a suggested reply, and the inbound hook needs its secret', async () => {
  const ai = { enabled: () => true, available: async () => true, json: JSON.parse, clip: (v, n) => String(v == null ? '' : v).slice(0, n), complete: async () => '{"kind":"question","summary":"Asks when the next race is.","reply":"The next race is on Tuesday."}' };
  const k = kit({ ai });
  const o = (await call(k, 'POST /api/aiops/triage', { from: 'Bo <bo@x.test>', subject: 'Re: news', text: 'Please unsubscribe me from these.' })).item; assert.equal(o.kind, 'optout'); assert.deepEqual(k.opt, [['bo@x.test', 'all']]); assert.equal(o.status, 'done');
  const c = (await call(k, 'POST /api/aiops/triage', { from: 'cy@x.test', subject: 'Re', text: 'This is spam and I want to complain.' })).item; assert.equal(c.kind, 'complaint'); assert.ok(k.posts.some(p => p[0] === 'admin' && /Complaint/.test(p[1])));
  const q = (await call(k, 'POST /api/aiops/triage', { from: 'di@x.test', subject: 'Re', text: 'When is the next race?' })).item; assert.equal(q.kind, 'question'); assert.match(q.suggested, /Tuesday/); assert.equal(q.status, 'open');
  assert.equal((await call(k, 'GET /api/aiops')).triage, 2); await call(k, 'POST /api/aiops/triage-done', { id: q.id }); assert.equal((await call(k, 'GET /api/aiops')).triage, 1);
  assert.equal((await call(k, 'GET /api/aiops/triage')).items.length, 3);
  process.env.MAIL_INBOUND_SECRET = 's3'; await assert.rejects(() => k.o.inbound('wrong', { from: 'a@x.test', text: 'hi?' }), /Not allowed/);
  assert.equal((await k.o.inbound('s3', { from: 'a@x.test', text: 'Is it free?' })).item.kind, 'question'); delete process.env.MAIL_INBOUND_SECRET;
  await assert.rejects(() => k.o.inbound('x', {}), /Not allowed/, 'no secret configured means no inbound');
});

test('triage works with the AI off (fixed rules) and a reply with no text is refused', async () => {
  const k = kit(), r = (await call(k, 'POST /api/aiops/triage', { from: 'a@x.test', subject: 's', text: 'Can I bring a friend?' })).item; assert.deepEqual([r.kind, r.by], ['question', 'rules']);
  await assert.rejects(() => call(k, 'POST /api/aiops/triage', { from: 'a@x.test', text: '' }), /sender and some text/);
});

test('the whole-round plan shares races out fairly, leaves out anyone who said no, flags short weeks, and changes nothing', async () => {
  const k = kit({ avail: { '0:1': 'yes', '0:2': 'yes', '0:3': 'yes', '1:1': 'yes', '1:2': 'yes', '1:3': 'yes', '2:2': 'no', '2:3': 'no', '2:1': 'yes' } }), r = await call(k, 'POST /api/aiops/season-lineups', { team: 't1' });
  assert.equal(r.weeks.length, 4); assert.deepEqual(r.weeks[0].picks.map(p => p.name), ['Ann Lee', 'Cy Ray'], 'highest rated first when nobody has raced yet');
  assert.ok(r.weeks[1].picks.some(p => p.name === 'Bo Dunn'), 'week 2: the rider who has not raced yet comes in before someone who has');
  assert.equal(r.weeks[2].short, 1, 'only one rider can ride in week 3'); assert.ok(r.weeks.every(w => w.picks.length <= 2)); assert.equal(r.races.reduce((n, x) => n + x.races, 0), r.weeks.reduce((n, w) => n + w.picks.length, 0));
  await assert.rejects(() => call(k, 'POST /api/aiops/season-lineups', { team: 'nope' }), /does not exist/);
});

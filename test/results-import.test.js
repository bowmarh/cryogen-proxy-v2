'use strict';
// Results read from ZwiftRacing.app for the Ladder and the DIRT Series: a preview, then apply; and the scheduled import after a race.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald', 'Emerald'];
const RAT = [2300, 2250, 2100, 2050, 2000, 1900, 1850];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: RAT[i], mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.ZWIFTRACING_API_KEY; app.close(); });
const ID = i => String(2000 + i);
const post = (path, body) => app.post(`/api/${path}`, body, { token: admin });
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const when = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const results = ids => ({ eventId: 77, title: 'Ladder', time: 1, results: ids.map((z, i) => ({ riderId: Number(z), position: i + 1, name: z })) });
beforeEach(() => { process.env.ZWIFTRACING_API_KEY = 'zr-key'; app.world.db = {}; app.world.discord.length = 0; world.zr = { status: 200, body: {}, seen: [] }; });

async function ladderMatch(hrs, link = 'https://www.zwift.com/events/view/77?eventSecret=x') {
  for (let i = 0; i < 6; i++) await post('ladder/roster', { zwid: ID(i) });
  return (await post('ladder/match', { opponent: 'Team Rocket', challenger: 'us', ...when(hrs), eventLink: link })).body.matches[0];
}

test('Ladder: the roster riders found in the event are the five who raced; preview, then apply, with the score', async () => {
  const m = await ladderMatch(-3);
  world.zr.body = results([ID(0), '9001', ID(2), '9002', ID(3), '9003', ID(4), '9004', ID(5), '9005']);
  const pre = (await post('ladder/result-import', { match: m.id })).body.preview;
  assert.deepEqual(pre.positions, { [ID(0)]: 1, [ID(2)]: 3, [ID(3)]: 5, [ID(4)]: 7, [ID(5)]: 9 });
  assert.equal(pre.ourPoints, 10 + 8 + 6 + 4 + 2); assert.equal(pre.won, true);
  assert.equal(pre.lineupChanged, true, 'no line-up was set');
  assert.equal(world.zr.seen[0].path, '/api/public/results/77', 'the id came from the private link');
  assert.equal((await app.get('/api/ladder', { token: admin })).body.matches[0].status, 'scheduled', 'a preview saves nothing');
  const v = (await post('ladder/result-import', { match: m.id, apply: true })).body.matches[0];
  assert.equal(v.status, 'played'); assert.equal(v.result.source, 'zwiftracing'); assert.equal(v.result.ourPoints, 30);
  assert.deepEqual(v.lineup.slice().sort(), [ID(0), ID(2), ID(3), ID(4), ID(5)]);
});

test('Ladder: not five of ours, no link, or no results yet are clear errors; the schedule imports hourly after the race and tells the admin channel', async () => {
  const m = await ladderMatch(-3);
  world.zr.body = results([ID(0), ID(1), '9001', '9002']);
  assert.equal((await post('ladder/result-import', { match: m.id })).status, 409);
  world.zr.status = 404; world.zr.body = {};
  assert.equal((await post('ladder/result-import', { match: m.id })).status, 404);
  assert.equal((await post('ladder/result-import', { match: m.id, event: 'x' })).status, 400);
  assert.ok(!(await tick()).includes('ladder-result-imported'), 'not published yet');
  world.zr.status = 200; world.zr.body = results([ID(0), ID(1), ID(2), '9001', ID(3), ID(4), '9002', '9003', '9004', '9005']);
  app.world.db['cg:ladder:sent'] = {};
  const ran = await tick();
  assert.ok(ran.includes('ladder-result-imported'), JSON.stringify(ran));
  assert.match(adminPosts().join('\n'), /result imported from ZwiftRacing\.app: .* \d+–\d+/);
  const noLink = await post('ladder/match', { id: m.id, opponent: 'Team Rocket', eventLink: '' });
  void noLink;
});

test('DIRT: the squad riders found in the event get their places; points already entered are kept; the schedule reads it after the stage', async () => {
  await post('drs/season', { name: 'A', division: 'Platinum', threshold: 5000, time: new Date(Date.now() - 4 * 3600000).toISOString().slice(11, 16), tz: 'UTC' });
  for (let i = 0; i < 6; i++) await post('drs/squad', { zwid: ID(i), force: true });
  const st = (await post('drs/stage', { type: 'scratch', route: 'Loop', date: new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10), eventLink: 'https://www.zwift.com/events/view/77?eventSecret=y' })).body.stages[0];
  world.zr.body = results(['9001', ID(2), '9002', ID(0), ID(1), '9003', '9004', ID(3)]);
  const pre = (await post('drs/result-import', { stage: st.id })).body.preview;
  assert.deepEqual(pre.riders.map(r => [r.zwid, r.pos]), [[ID(2), 2], [ID(0), 4], [ID(1), 5], [ID(3), 8]]);
  assert.equal(pre.pointsPending, true);
  const v = (await post('drs/result-import', { stage: st.id, apply: true })).body.stages[0];
  assert.equal(v.status, 'played'); assert.deepEqual(v.result.scorers.slice().sort(), [ID(0), ID(1), ID(2), ID(3)]);
  await post('drs/result', { stage: st.id, results: { [ID(2)]: { pos: 2, pts: 114 }, [ID(0)]: { pos: 4, pts: 102 } } });
  const again = (await post('drs/result-import', { stage: st.id })).body.preview;
  assert.equal(again.riders.find(r => r.zwid === ID(2)).pts, 114, 'points entered by hand are kept');
  assert.equal((await post('drs/result-import', { stage: st.id, event: '' })).status, 200);

  app.world.db['cg:drs:stages'][st.id] = JSON.stringify({ ...JSON.parse(app.world.db['cg:drs:stages'][st.id]), status: 'upcoming', result: undefined });
  const ran = await tick();
  assert.ok(ran.includes('drs-result-imported'), JSON.stringify(ran));
  assert.match(adminPosts().join('\n'), /finishing places were read from ZwiftRacing\.app/);
});

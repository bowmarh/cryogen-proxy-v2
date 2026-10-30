'use strict';
// End-of-season recognition for the Ladder, the DIRT Series and the TTT.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
const publicPosts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('Ladder: the recognition names the record, best points a race, ever-presents and firsts; works for an archived season; staff only', async () => {
  assert.equal((await app.get('/api/ladder/recognition', A)).status, 409, 'nothing played yet');
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  for (const pos of [[1, 2, 3, 5, 7], [2, 1, 4, 6, 8]]) {
    const m = (await app.post('/api/ladder/match', { opponent: `T${pos[0]}`, challenger: 'us' }, A)).body.matches[0];
    await app.post('/api/ladder/lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) }, A);
    await app.post('/api/ladder/result', { match: m.id, positions: Object.fromEntries(pos.map((p, i) => [ID(i), p])) }, A);
  }
  const r = (await app.get('/api/ladder/recognition', A)).body;
  const text = r.messages.join('\n');
  assert.match(text, /Record: 2 won, 0 lost/); assert.match(text, /Best points a race/); assert.match(text, /Raced every match \(2 of 2\)/); assert.match(text, /First across the line/);
  assert.equal((await app.post('/api/ladder/post-recognition', {}, A)).body.posted, 1);
  assert.match(publicPosts().join('\n'), /Ladder season recognition: CRYO-GEN/);
  assert.equal((await app.post('/api/ladder/post-recognition', {}, A)).status, 429, 'not twice in five minutes');
  await app.post('/api/ladder/season-close', { name: 'Autumn', clear: true }, A);
  const arc = (await app.get('/api/ladder/archive', A)).body.seasons[0];
  assert.match((await app.get(`/api/ladder/recognition?id=${encodeURIComponent(arc.id)}`, A)).body.messages[0], /Record: 2 won/);
  assert.equal((await app.get('/api/ladder/recognition')).status, 401);
});

test('DIRT: the recognition names team points, top scorers, best finishes and ever-presents', async () => {
  assert.equal((await app.get('/api/drs/recognition', A)).status, 409);
  await app.post('/api/drs/season', { name: 'DRS Autumn', division: 'Platinum', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  for (let i = 0; i < 4; i++) await app.post('/api/drs/squad', { zwid: ID(i), force: true }, A);
  for (const d of ['2026-11-03', '2026-11-10']) {
    const st = (await app.post('/api/drs/stage', { type: 'scratch', date: d }, A)).body.stages.slice(-1)[0];
    await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 1, pts: 120 }, [ID(1)]: { pos: 3, pts: 108 }, [ID(2)]: { pos: 9, pts: 75 } } }, A);
  }
  const text = (await app.get('/api/drs/recognition', A)).body.messages.join('\n');
  assert.match(text, /606 team points\*\* from 2 stages/); assert.match(text, /Lad 0: 240 points/); assert.match(text, /Best finishes[\s\S]*Lad 0: P1/); assert.match(text, /Raced every stage \(2 of 2\)/);
  assert.equal((await app.post('/api/drs/post-recognition', {}, A)).body.posted, 1);
  assert.match(publicPosts().join('\n'), /DIRT Series recognition: DRS Autumn, Platinum/);
  assert.equal((await app.post('/api/drs/post-recognition', {})).status, 401);
});

test('TTT: the recognition counts team wins, podiums and weeks ridden', async () => {
  assert.equal((await app.get('/api/ttt/recognition', A)).status, 409);
  await app.post('/api/ttt/new-week', { date: h.ymd(3) }, A);
  const week = (await app.get('/api/ttt', A)).body.week, team = week.teams[0];
  for (const n of ['Ann Lee', 'Bo Chen', 'Cy Dunn', 'Di Evans']) { await app.post('/api/ttt/signup', { name: n }); await app.post('/api/ttt/assign', { name: n, teams: [team.id] }, A); }
  await app.post('/api/ttt/status', { published: true }, A);
  await app.post('/api/ttt/results', { weekId: week.id, results: { [team.id]: { time: '23:50', position: 1, of: 8 } } }, A);
  const text = (await app.get('/api/ttt/recognition', A)).body.messages.join('\n');
  assert.match(text, /1 week of team time trials/); assert.match(text, new RegExp(`Team wins[\\s\\S]*${team.name}: 1`)); assert.match(text, /On the podium with their team[\s\S]*Ann Lee: 1 time/);
  assert.equal((await app.post('/api/ttt/post-recognition', {}, A)).body.posted, 1);
  assert.match(publicPosts().join('\n'), /TTT recognition/);
  assert.equal((await app.get('/api/ttt/recognition')).status, 401);
});

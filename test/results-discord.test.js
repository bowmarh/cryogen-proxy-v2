'use strict';
// When staff enter results, the club channel gets one message for the teams whose result is new.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());

const WEEK = h.ymd(10);
let ids;
beforeEach(async () => {
  app.world.db = {};
  app.world.discord.length = 0;
  await app.post('/api/ttt/new-week', { date: WEEK }, { token: admin });
  ids = Object.fromEntries((await app.get('/api/ttt', { token: admin })).body.week.teams.map(t => [t.name, t.id]));
  app.world.discord.length = 0; // ignore the "sign-ups open" post
});

const place = async (team, names, captain) => {
  for (const n of names) { await app.post('/api/ttt/signup', { name: n }); await app.post('/api/ttt/assign', { name: n, teams: [ids[team]] }, { token: admin }); }
  if (captain) await app.post('/api/ttt/captain', { team: ids[team], name: captain }, { token: admin });
  app.world.discord.length = 0;
};
const save = (results, weekId = WEEK, token = admin) =>
  app.post('/api/ttt/results', { weekId, results: Object.fromEntries(Object.entries(results).map(([t, r]) => [ids[t], r])) }, { token });
const posts = () => app.world.discord.filter(p => p.channel === 'public');

test('first results make one club post, best first, with medals, riders and the captain', async () => {
  await place('Hawks', ['Ann Lee', 'Bo Chen'], 'Ann Lee');
  await place('Owls', ['Di Evans']);
  await place('Kites', ['Flo Gray']);
  assert.equal((await save({
    Owls: { time: '26:10', position: 5, of: 8 },
    Hawks: { time: '23:50', position: 1, of: 8 },
    Kites: { dnf: true },
  })).status, 200);
  assert.equal(app.world.discord.length, 1, 'a single message');
  const [p] = posts();
  const c = p.body.content;
  assert.match(c, /Results — Weekly TTT/);
  assert.ok(c.indexOf('Hawks') < c.indexOf('Owls') && c.indexOf('Owls') < c.indexOf('Kites'), 'sorted: 1st, 5th, then DNF last');
  assert.match(c, /🥇 \*\*Hawks\*\* — 1st of 8 · 23:50/);
  assert.match(c, /🏁 \*\*Owls\*\* — 5th of 8 · 26:10/);
  assert.match(c, /🏁 \*\*Kites\*\* — DNF/);
  assert.match(c, /⭐ Ann Lee, Bo Chen/, 'captain starred, riders listed');
  assert.deepEqual(p.body.allowed_mentions, { parse: [] });
});

test('saving the same results again, or correcting one, stays quiet; a new team posts only itself', async () => {
  await place('Hawks', ['Ann Lee']); await place('Owls', ['Di Evans']);
  await save({ Hawks: { time: '23:50', position: 1, of: 8 } });
  assert.equal(posts().length, 1);
  await save({ Hawks: { time: '23:50', position: 1, of: 8 } });
  assert.equal(posts().length, 1, 'nothing new');
  await save({ Hawks: { time: '23:51', position: 2, of: 8 } });
  assert.equal(posts().length, 1, 'a correction is silent');
  await save({ Hawks: { time: '23:51', position: 2, of: 8 }, Owls: { time: '26:10', position: 5, of: 8 } });
  assert.equal(posts().length, 2);
  assert.match(posts()[1].body.content, /Owls/);
  assert.ok(!/Hawks/.test(posts()[1].body.content), 'Hawks are not announced twice');
});

test('entries with no result yet, or invalid ones, post nothing', async () => {
  await place('Hawks', ['Ann Lee']);
  await save({ Hawks: { link: 'https://example.com/results' } });
  assert.equal(posts().length, 0, 'a link on its own is not a result');
  assert.equal((await save({ Hawks: { time: 'fast' } })).status, 400);
  assert.equal((await save({ Hawks: { position: 9, of: 3 } })).status, 400);
  assert.equal(posts().length, 0);
  assert.equal((await save({ Hawks: { time: '23:50' } }, WEEK, null)).status, 401, 'staff only');
  assert.equal(posts().length, 0);
});

test('a results link is included without an embed, and unsafe links are left out', async () => {
  await place('Hawks', ['Ann Lee']); await place('Owls', ['Di Evans']);
  await save({ Hawks: { position: 1, of: 8, link: 'https://example.com/r?x=1' }, Owls: { position: 2, of: 8, link: 'https://example.com/a>b' } });
  const c = posts()[0].body.content;
  assert.match(c, /\[results\]\(<https:\/\/example\.com\/r\?x=1>\)/);
  assert.ok(!c.includes('a>b'), 'a link that could break the message is dropped');
});

test('results entered after the rollover are posted with that week\'s title and line-up', async () => {
  await place('Hawks', ['Ann Lee', 'Bo Chen'], 'Bo Chen');
  const title = (await app.get('/api/ttt', { token: admin })).body.week.title;
  await app.post('/api/ttt/new-week', { date: h.ymd(17) }, { token: admin });
  app.world.discord.length = 0;
  assert.equal((await save({ Hawks: { time: '24:02', position: 4, of: 9 } }, WEEK)).status, 200);
  const c = posts()[0].body.content;
  assert.ok(c.includes(title.replace(/([*_~`|>[\]\\])/g, '\\$1')), 'the finished week is named');
  assert.match(c, /Ann Lee, ⭐ Bo Chen|⭐ Bo Chen, Ann Lee/);
});

test('names with markdown or mentions cannot break or ping, and long line-ups stay under the Discord limit', async () => {
  await place('Hawks', ['@everyone **bold**', 'a'.repeat(55)]);
  await save({ Hawks: { time: '23:50', position: 1, of: 8 } });
  const c = posts()[0].body.content;
  assert.ok(!/\*\*bold\*\*/.test(c), 'markdown in a name is escaped');
  assert.deepEqual(posts()[0].body.allowed_mentions, { parse: [] });

  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/ttt/new-week', { date: h.ymd(30) }, { token: admin });
  const t = (await app.get('/api/ttt', { token: admin })).body.week.teams;
  const results = {};
  for (const team of t) {
    for (let i = 0; i < 6; i++) {
      const n = `${team.name} rider ${i} ${'x'.repeat(40)}`;
      await app.post('/api/ttt/signup', { name: n });
      await app.post('/api/ttt/assign', { name: n, teams: [team.id] }, { token: admin });
    }
    results[team.id] = { time: '24:00', position: 1 + t.indexOf(team), of: 9 };
  }
  app.world.discord.length = 0;
  await app.post('/api/ttt/results', { weekId: h.ymd(30), results }, { token: admin });
  assert.equal(posts().length, 1);
  assert.ok(posts()[0].body.content.length <= 2000, `message is ${posts()[0].body.content.length} characters`);
  assert.match(posts()[0].body.content, /🥇 \*\*Hawks\*\*/);
  assert.ok(posts()[0].body.content.includes(`**${t[t.length - 1].name}**`), 'even the last-placed team is still in the message (rider lists were dropped, not results)');
});

test('with no Discord webhook the results still save', async () => {
  await place('Hawks', ['Ann Lee']);
  const saved = process.env.DISCORD_WEBHOOK_PUBLIC;
  delete process.env.DISCORD_WEBHOOK_PUBLIC;
  try {
    assert.equal((await save({ Hawks: { time: '23:50', position: 1, of: 8 } })).status, 200);
    assert.equal(app.world.discord.length, 0);
    assert.equal((await app.get('/api/ttt')).body.week.results[ids.Hawks].position, 1);
  } finally { process.env.DISCORD_WEBHOOK_PUBLIC = saved; }
});

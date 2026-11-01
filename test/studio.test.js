'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
const DRAFT = { discord: 'Great race! {R1} was brilliant. https://club.test/club.html', telegram: 'Telegram: race done. {R1}', bluesky: 'Race done {R1} https://club.test/club.html', facebook: 'FB post', instagram: 'IG caption #CRYOGEN', whatsapp: 'WA text', strava: 'Strava text', website: { title: 'Race report', body: 'Para one.\n\nPara two {R1}.' }, email: { subject: 'Race report', body: 'Email body' } };
const CH = ['DISCORD_WEBHOOK_PUBLIC', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'STUDIO_HOOK_FACEBOOK', 'STUDIO_HOOK_INSTAGRAM', 'STUDIO_HOOK_OTHER', 'STUDIO_HOOK_EMAIL'];
before(async () => {
  world = h.createWorld({ riders: [0, 1, 2, 3, 4].map(i => ({ riderId: 4000 + i, name: `Club Rider ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 1200, mixed: { category: 'Ruby' } } } })) });
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = { token: await app.login('admin') }; mod = { token: await app.login('mod') };
});
after(() => { for (const k of [...CH, 'ANTHROPIC_API_KEY']) delete process.env[k]; return app.close(); });
beforeEach(async () => {
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'tg-token', TELEGRAM_CHAT_ID: '-100', BLUESKY_HANDLE: 'cryogen.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass', STUDIO_HOOK_FACEBOOK: 'http://hooks.test/fb', STUDIO_HOOK_INSTAGRAM: 'http://hooks.test/ig', STUDIO_HOOK_OTHER: 'http://hooks.test/all', ANTHROPIC_API_KEY: 'sk-test' });
  delete process.env.STUDIO_HOOK_EMAIL; process.env.DISCORD_WEBHOOK_PUBLIC = process.env.DISCORD_WEBHOOK_PUBLIC || 'http://discord.test/public';
  Object.assign(world, { telegram: [], bsky: [], wpPosts: [], hooks: [], telegramFail: false, bskyFail: false, wpFail: false, hookFail: false, anthropic: { reply: JSON.stringify(DRAFT), status: 200, seen: [] } });
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/studio/settings', { enabled: true }, admin);
});
const draft = async (b = 'Our riders raced well') => (await app.post('/api/studio/draft', { brief: b }, mod)).body.post;
const png = () => { const b = Buffer.alloc(300); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); return b.toString('base64'); };

test('automatic drafting is off until an administrator switches it on; writing by hand always works', async () => {
  await app.post('/api/studio/settings', { enabled: false }, admin);
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal((await app.get('/api/studio', admin)).body.posts.length, 0); assert.equal(world.anthropic.seen.length, 0, 'no AI used');
  assert.equal((await app.get('/api/studio', admin)).body.settings.enabled, false);
  assert.equal((await app.post('/api/studio/draft', { brief: 'By hand' }, mod)).status, 200);
});

test('only staff see the studio; a brief becomes a draft for every platform, nothing goes out, and no names reach the model', async () => {
  assert.equal((await app.get('/api/studio')).status, 401);
  assert.equal((await app.post('/api/studio/draft', { brief: 'x' }, { token: await app.memberSession('1002', { name: 'R' }) })).status, 401);
  const p = await draft('Weekly ride on Sunday with Club Rider 1');
  assert.deepEqual([p.status, p.via, Object.keys(p.results).length], ['pending', 'ai', 0]);
  assert.equal(p.variants.bluesky.length <= 290, true); assert.deepEqual(Object.keys(p.variants).sort(), ['bluesky', 'discord', 'email', 'facebook', 'hook', 'instagram', 'strava', 'telegram', 'website', 'whatsapp']);
  assert.equal(world.telegram.length + world.bsky.length + world.wpPosts.length + world.hooks.length, 0, 'nothing posted yet');
  assert.equal(app.world.discord.filter(d => /Race report|Great race/.test(d.body.content || '')).length, 0);
  assert.match(world.anthropic.seen[0].body.system, /Use ONLY the facts/);
  const ch = (await app.get('/api/studio', mod)).body.channels, by = Object.fromEntries(ch.map(c => [c.id, c]));
  assert.deepEqual([by.telegram.configured, by.website.configured, by.whatsapp.type, by.strava.type, by.email.type], [true, true, 'manual', 'manual', 'manual']);
});

test('riders are named only if they opted in, and the club (not the AI) puts the names in', async () => {
  const f = await app.post('/api/studio/feature', { on: true }, { token: await app.memberSession('4001', { name: 'Club Rider 1' }) });
  assert.equal(f.body.on, true);
  assert.equal((await app.get('/api/studio/feature', { token: await app.memberSession('4001', { name: 'x' }) })).body.on, true);
  // A result for a line-up of three, one of whom opted in: that rider is {R1}, the others are not mentioned.
  await app.post('/api/ladder/roster', { zwid: '4000' }, admin);
  for (const z of ['4001', '4002', '4003', '4004']) await app.post('/api/ladder/roster', { zwid: z }, admin);
  const t = new Date(Date.now() - 86400000);
  const m = (await app.post('/api/ladder/match', { opponent: 'Team Rocket', challenger: 'us', date: t.toISOString().slice(0, 10), time: '19:30' }, admin)).body.matches[0];
  await app.post('/api/ladder/lineup', { match: m.id, zwids: ['4000', '4001', '4002', '4003', '4004'] }, admin);
  await app.post('/api/ladder/result', { match: m.id, positions: { 4000: 1, 4001: 2, 4002: 3, 4003: 4, 4004: 5 } }, admin);
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const list = (await app.get('/api/studio', admin)).body.posts, p = list.find(x => x.kind === 'ladder_result');
  assert.ok(p, JSON.stringify(list.map(x => x.kind)));
  assert.deepEqual(p.named, ['Club Rider 1']); assert.match(p.variants.discord, /Club Rider 1 was brilliant/); assert.ok(!/Club Rider [02-4]/.test(JSON.stringify(p.variants)));
  const body = world.anthropic.seen.find(x => /Ladder result/.test(x.body.messages[0].content)).body, sent = JSON.stringify(body), facts = JSON.parse(body.messages[0].content); assert.ok(!/Club Rider/.test(sent), 'no names to the model'); assert.deepEqual(facts.riders, ['R1']); assert.equal(facts.facts.opponent, 'Team Rocket');
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal((await app.get('/api/studio', admin)).body.posts.filter(x => x.kind === 'ladder_result').length, 1, 'the same result is not posted twice');
});

test('approving posts to the chosen platforms: website as a draft, Telegram, Bluesky with a link, Zapier hooks; manual ones are left to a person; one failure does not stop the rest', async () => {
  const p = await draft();
  await app.post('/api/studio/image', { id: p.id, png: png() }, mod);
  const r = (await app.post('/api/studio/approve', { id: p.id, channels: ['discord', 'website', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook', 'whatsapp'] }, mod)).body.post;
  assert.equal(r.status, 'posted');
  assert.ok(['discord', 'website', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook'].every(c => r.results[c].ok), JSON.stringify(r.results));
  assert.equal(r.results.whatsapp, undefined, 'a person posts that one');
  assert.deepEqual([world.wpPosts[0].body.status, world.wpPosts[0].body.title, /^Basic /.test(world.wpPosts[0].auth)], ['draft', 'Race report', true]);
  assert.match(world.wpPosts[0].body.content, /<p>Para one\.<\/p><p>Para two/); assert.match(world.wpPosts[0].body.content, /\/api\/studio\/img\/[0-9a-f]{24}\.png/);
  assert.deepEqual([world.telegram[0].path, world.telegram[0].body.chat_id], ['/bottg-token/sendPhoto', '-100']);
  const rec = world.bsky.find(x => x.path.endsWith('createRecord'));
  assert.equal(rec.auth, 'Bearer jwt'); assert.equal(rec.body.record.facets[0].features[0].uri, 'https://club.test/club.html'); assert.ok(rec.body.record.text.length <= 300);
  assert.deepEqual(world.hooks.map(x => [x.path, x.body.platform]), [['/fb', 'facebook'], ['/ig', 'instagram'], ['/all', 'all']]);
  assert.match(world.hooks[1].body.imageUrl, /\/api\/studio\/img\//); assert.ok(world.hooks[2].body.variants.whatsapp);
  const p2 = await draft('Another'); world.telegramFail = true; world.wpFail = true;
  const r2 = (await app.post('/api/studio/approve', { id: p2.id, channels: ['telegram', 'website', 'bluesky'] }, mod)).body.post;
  assert.deepEqual([r2.results.telegram.ok, r2.results.website.ok, r2.results.bluesky.ok, r2.status], [false, false, true, 'posted']);
  assert.match(r2.results.telegram.error, /chat not found/); assert.match(r2.results.website.error, /not allowed/);
  world.telegramFail = false; const again = (await app.post('/api/studio/approve', { id: p2.id, channels: ['telegram', 'bluesky'] }, mod)).body.post;
  assert.equal(again.results.telegram.ok, true); assert.equal(world.bsky.filter(x => x.path.endsWith('createRecord')).length, 2, 'Bluesky is not posted twice');
});

test('Instagram needs a picture, the picture is public only at its own address and must be a PNG, and the daily limit and the pause are kept', async () => {
  const p = await draft();
  const noPic = (await app.post('/api/studio/approve', { id: p.id, channels: ['instagram'] }, mod)).body.post;
  assert.match(noPic.results.instagram.error, /needs a picture/); assert.equal(noPic.status, 'failed');
  assert.equal((await app.post('/api/studio/image', { id: p.id, png: Buffer.from('not a picture at all, sorry').toString('base64') }, mod)).status, 400);
  const id = (await app.post('/api/studio/image', { id: p.id, png: png() }, mod)).body.imageId;
  const img = await app.call('GET', `/api/studio/img/${id}.png`);
  assert.equal(img.status, 200); assert.equal((await app.call('GET', '/api/studio/img/ffffffffffffffffffffffff.png')).status, 404);
  assert.equal((await app.post('/api/studio/settings', { dailyLimit: 1 }, mod)).status, 403, 'only an admin changes the settings');
  await app.post('/api/studio/settings', { dailyLimit: 1, paused: false }, admin);
  await app.post('/api/studio/approve', { id: p.id, channels: ['telegram'] }, mod);
  const q = await draft('Second'), lim = (await app.post('/api/studio/approve', { id: q.id, channels: ['telegram'] }, mod)).body.post;
  assert.match(lim.results.telegram.error, /Daily limit of 1/);
  await app.post('/api/studio/settings', { paused: true }, admin);
  assert.equal((await app.post('/api/studio/approve', { id: q.id, channels: ['bluesky'] }, mod)).status, 409);
});

test('with the AI off the studio still drafts a plain post, a kind set to automatic posts without approval, and reject / mark-done work', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const p = await draft('Sunday social ride at 9');
  assert.equal(p.via, 'template'); assert.match(p.variants.discord, /Club news/); assert.ok(p.variants.bluesky.length <= 290);
  const done = (await app.post('/api/studio/done', { id: p.id, channel: 'whatsapp' }, mod)).body.post;
  assert.deepEqual([done.results.whatsapp.manual, done.status], [true, 'posted']);
  assert.equal((await app.post('/api/studio/done', { id: p.id, channel: 'telegram' }, mod)).status, 400);
  const rej = (await app.post('/api/studio/reject', { id: (await draft('x')).id }, mod)).body.post; assert.equal(rej.status, 'rejected');
  assert.equal((await app.post('/api/studio/approve', { id: 'nope', channels: [] }, mod)).status, 404);
  await app.post('/api/studio/settings', { autoKinds: ['week_ahead', 'bogus'], disabled: ['bluesky'] }, admin);
  const st = (await app.get('/api/studio', admin)).body.settings; assert.deepEqual([st.autoKinds, st.disabled], [['week_ahead'], ['bluesky']]);
  assert.equal((await app.get('/api/studio', admin)).body.channels.find(c => c.id === 'bluesky').enabled, false);
});

test('on Monday morning the studio finds "this week" and "last week" posts, once per week, with counts and no names', async () => {
  const create = require('../lib/studio');
  const store = {}, redis = async cmds => cmds.map(([c, k, ...a]) => { const hh = store[k] = store[k] || {}; if (c === 'GET') return null; if (c === 'HGETALL') return Object.entries(hh).flat(); if (c === 'HSETNX') { if (a[0] in hh) return 0; hh[a[0]] = a[1]; return 1; } if (c === 'HSET') { hh[a[0]] = a[1]; return 1; } if (c === 'SET') return 'OK'; if (c === 'HDEL') { delete hh[a[0]]; return 1; } return null; });
  const mk = () => create({ redis, HttpError: Error, requireRole() {}, memberFromRequest: () => null, ai: { available: async () => false, enabled: () => false, json: () => null }, fetchRoster: async () => ({ riders: [] }),
    zrl: { load: async () => ({ round: null }) }, ladder: { allMatches: async () => [] }, drs: { allStages: async () => [] }, adminReq: () => ({}), discord: async () => true, siteUrl: 'https://club.test',
    publicClub: async now => ({ next: [{ series: 'ZRL', title: 'Round 2 · race 1', date: '2026-11-03', at: Date.parse('2026-11-03T19:00:00Z') }], ladder: [{ team: 'CRYO-GEN', recent: [{ opponent: 'Rocket', date: '2026-11-06', won: true, score: '40-15' }] }], podium: [{ division: 'Division 1', top: [{ rank: 1, team: 'Alpha', points: 30 }] }] }), weekInfo: async () => ({ newMembers: 2 }) });
  const studio = mk();
  assert.deepEqual((await studio.findEvents(Date.parse('2026-11-08T09:00:00Z'))).map(e => e.kind), [], 'not on a Sunday');
  assert.deepEqual((await studio.findEvents(Date.parse('2026-11-09T06:00:00Z'))).map(e => e.kind), [], 'not before 8');
  const ev = await studio.findEvents(Date.parse('2026-11-09T09:00:00Z'));
  assert.deepEqual(ev.map(e => [e.kind, e.key]), [['week_ahead', 'ahead:2026-11-09'], ['week_recap', 'recap:2026-11-09']]);
  assert.equal(ev[1].facts.newMembersJoined, 2); assert.ok(ev[1].facts.lines.some(l => /Ladder: won 40-15 v Rocket/.test(l)) && ev[1].facts.lines.some(l => /ZRL Division 1: 1\. Alpha/.test(l)));
  const p = await studio.create(ev[0], 'automatic');
  assert.equal(p.via, 'template'); assert.match(p.variants.discord, /Round 2 · race 1/);
});

test('"Test the connection": says exactly what is missing or wrong in plain words, and what to do', async () => {
  assert.equal((await app.post('/api/studio/test', { channel: 'telegram' }, mod)).status, 403, 'admin only');
  assert.equal((await app.post('/api/studio/test', { channel: 'nope' }, admin)).status, 400);
  const g = (await app.get('/api/studio', admin)).body.guide; assert.deepEqual(g.map(x => x.id), ['telegram', 'bluesky', 'website', 'facebook', 'instagram', 'hook', 'email', 'whatsapp', 'strava', 'discord']);
  assert.ok(g.every(x => x.steps.length >= 1 && x.minutes >= 0 && x.summary)); assert.ok(g.find(x => x.id === 'telegram').steps.some(s => /BotFather/.test(s)));
  delete process.env.TELEGRAM_BOT_TOKEN;
  let r = (await app.post('/api/studio/test', { channel: 'telegram' }, admin)).body;
  assert.deepEqual([r.ok, r.detail], [false, 'TELEGRAM_BOT_TOKEN is not set yet.']); assert.match(r.hint, /Redeploy/);
  assert.deepEqual((await app.get('/api/studio', admin)).body.guide.find(x => x.id === 'telegram').missing, ['TELEGRAM_BOT_TOKEN']);
  process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
  r = (await app.post('/api/studio/test', { channel: 'telegram' }, admin)).body; assert.equal(r.ok, true); assert.equal(world.telegram.length, 1);
  world.telegramFail = true; r = (await app.post('/api/studio/test', { channel: 'telegram' }, admin)).body;
  assert.equal(r.ok, false); assert.match(r.hint, /chat ID is wrong, or the bot is not an admin/);
  r = (await app.post('/api/studio/test', { channel: 'bluesky' }, admin)).body; assert.equal(r.ok, true); assert.equal(world.bsky.length, 0, 'nothing is posted by the test');
  world.bskyFail = true; r = (await app.post('/api/studio/test', { channel: 'bluesky' }, admin)).body; assert.equal(r.ok, false); assert.match(r.hint, /Copy it again/);
  r = (await app.post('/api/studio/test', { channel: 'website' }, admin)).body; assert.equal(r.ok, true); assert.match(r.detail, /allowed to write posts/);
  world.wpNoPosts = true; r = (await app.post('/api/studio/test', { channel: 'website' }, admin)).body; world.wpNoPosts = false;
  assert.equal(r.ok, false); assert.match(r.hint, /Role to Author, Editor or Administrator/);
  r = (await app.post('/api/studio/test', { channel: 'facebook' }, admin)).body; assert.equal(r.ok, true); assert.match(r.detail, /Test trigger/);
  assert.deepEqual([world.hooks.at(-1).body.test, world.hooks.at(-1).body.platform], [true, 'facebook']);
  delete process.env.STUDIO_HOOK_INSTAGRAM; r = (await app.post('/api/studio/test', { channel: 'instagram' }, admin)).body; assert.match(r.detail, /STUDIO_HOOK_INSTAGRAM is not set/);
  assert.equal((await app.post('/api/studio/test', { channel: 'whatsapp' }, admin)).body.ok, true);
  assert.equal((await app.post('/api/studio/test', { channel: 'discord' }, admin)).body.ok, true); assert.ok(app.world.discord.some(d => /Studio test/.test(d.body.content)));
});

test('rider milestones for riders who opted in, a tip of the week (only with the AI) and a month in review', async () => {
  const create = require('../lib/studio');
  const store = {}, redis = async cmds => cmds.map(([c, k, ...a]) => { const hh = store[k] = store[k] || {}; if (c === 'GET') return null; if (c === 'HGETALL') return Object.entries(hh).flat(); if (c === 'HSETNX') { if (a[0] in hh) return 0; hh[a[0]] = a[1]; return 1; } if (c === 'HSET') { hh[a[0]] = a[1]; return 1; } if (c === 'HDEL') { delete hh[a[0]]; return 1; } return null; });
  let riders = [{ riderId: 9, name: 'Ann Able', race: { finishes: 9, wins: 0, podiums: 0 } }, { riderId: 8, name: 'Not Featured', race: { finishes: 9, wins: 0, podiums: 0 } }], aiOn = true;
  await redis([['HSET', 'cg:studio:feature', '9', '{}']]);
  const studio = create({ redis, HttpError: Error, requireRole() {}, memberFromRequest: () => null, ai: { available: async () => aiOn, enabled: () => aiOn, json: () => null }, fetchRoster: async () => ({ riders }), zrl: { load: async () => ({ round: null }) }, ladder: { allMatches: async () => [] }, drs: { allStages: async () => [] }, adminReq: () => ({}), discord: async () => true, siteUrl: 'https://club.test',
    publicClub: async () => ({ ladder: [{ team: 'CRYO-GEN', won: 5, lost: 2 }], podium: [{ division: 'Division 1', top: [{ rank: 1, team: 'Alpha', points: 30 }] }], drs: [{ team: 'CRYO-GEN', teamPoints: 120 }] }), weekInfo: async () => ({}) });
  const sat = Date.parse('2026-11-07T09:00:00Z');
  assert.deepEqual((await studio.findEvents(sat)).map(e => e.kind), [], 'the first sight of a rider is only the starting point');
  riders = [{ riderId: 9, name: 'Ann Able', race: { finishes: 10, wins: 1, podiums: 1 } }, { riderId: 8, name: 'Not Featured', race: { finishes: 10, wins: 1, podiums: 1 } }];
  const ms = (await studio.findEvents(sat)).filter(e => e.kind === 'milestone');
  assert.deepEqual(ms.map(e => e.key).sort(), ['milestone:9:podium:1', 'milestone:9:races:10', 'milestone:9:win:1'], 'only the rider who opted in');
  assert.ok(ms.every(e => e.zwids[0] === '9' && /\{R1\}/.test(e.facts.milestone)) && !JSON.stringify(ms).includes('Ann Able'), 'the name is not in the facts');
  assert.deepEqual((await studio.findEvents(sat)).filter(e => e.kind === 'milestone'), [], 'the same milestone is not found twice');
  const thu = Date.parse('2026-11-05T09:00:00Z'), tip = (await studio.findEvents(thu)).find(e => e.kind === 'weekly_tip');
  assert.ok(tip && tip.needsAi && tip.key === 'tip:2026-11-02' && tip.facts.theme);
  const first = new Date('2026-12-01T09:00:00Z').getTime(), rec = (await studio.findEvents(first)).find(e => e.kind === 'month_recap');
  assert.equal(rec.key, 'month:2026-12'); assert.equal(rec.headline, 'December at CRYO-GEN'); assert.ok(rec.facts.lines.some(l => /Ladder, CRYO-GEN: 5 won, 2 lost/.test(l)) && rec.facts.lines.some(l => /ZRL Division 1: 1\. Alpha \(30\)/.test(l)) && rec.facts.lines.some(l => /120 points/.test(l)));
  await studio.runSchedule(thu); aiOn = false; const posts = Object.values(store['cg:studio:posts'] || {}).length;
  await studio.runSchedule(Date.parse('2026-11-12T09:00:00Z')); assert.equal(Object.values(store['cg:studio:posts'] || {}).length, posts, 'no tip is posted without the AI');
});

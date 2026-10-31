'use strict';
// Members who have gone quiet: listed for staff, and a friendly message at most every two months when automatic messages are on.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const ago = days => Math.floor((Date.now() - days * 86400000) / 1000);
const rider = (id, name, days, finishes = 5) => ({ riderId: id, name, country: 'gb', zpCategory: 'B', race: { current: { rating: 1500, mixed: { category: 'Ruby' } }, finishes, last: days === null ? undefined : { date: ago(days) } } });
before(async () => {
  world = h.createWorld({ riders: [rider(7001, 'Quiet Quentin', 60), rider(7002, 'Busy Bella', 3), rider(7003, 'Gone Gary', 400), rider(7004, 'Fresh Fran', null, 0)] });
  world.members = [7001, 7002, 7003, 7004].map((z, i) => ({ id: 9500 + i, zwift_id: String(z), name: ['Quiet Quentin', 'Busy Bella', 'Gone Gary', 'Fresh Fran'][i], status: 'active', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' }));
  process.env.DISCORD_BOT_TOKEN = 'bot';
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const A = { get token() { return admin; } };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
beforeEach(() => { app.world.db = {}; world.dms = []; world.dmFail = new Set(); });

test('staff see members 45 to 180 days since a race; recent racers, long-gone members and people who never raced are not in the list', async () => {
  assert.equal((await app.get('/api/lifecycle')).status, 401);
  assert.equal((await app.get('/api/lifecycle', { token: await app.memberSession('7002', { name: 'Busy Bella' }) })).status, 401);
  const q = (await app.get('/api/lifecycle', A)).body;
  assert.deepEqual(q.quiet.map(m => [m.name, m.days]), [['Quiet Quentin', 60]]);
});

test('a quiet member with a verified Discord gets one message, only with automatic messages on, and not again for two months; nothing about their record changes', async () => {
  await app.post('/api/comms/link', { zwid: '7001', discordId: '123456789012345678' }, A);
  await tick();
  assert.equal(world.dms.filter(d => /missed you/.test(d.body.content)).length, 0, 'automatic messages are off');
  app.world.db['cg:lifecycle:sent'] = {};   // a new day
  await app.post('/api/comms/auto', { nudge: true }, A);
  await tick();
  const msgs = world.dms.filter(d => /missed you/.test(d.body.content));
  assert.equal(msgs.length, 1); assert.match(msgs[0].body.content, /Hi Quiet, we've missed you/); assert.match(msgs[0].body.content, /about 9 weeks/);
  app.world.db['cg:lifecycle:sent'] = { ...app.world.db['cg:lifecycle:sent'] }; delete app.world.db['cg:lifecycle:sent'][`run:${new Date().toISOString().slice(0, 10)}`];
  await tick();
  assert.equal(world.dms.filter(d => /missed you/.test(d.body.content)).length, 1, 'not again within two months');
  assert.equal(world.members.find(m => m.zwift_id === '7001').status, 'active');
});

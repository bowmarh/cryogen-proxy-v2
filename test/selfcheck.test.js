'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());

test('only admins can run the self-check', async () => {
  assert.equal((await app.post('/api/selfcheck', {})).status, 401);
});

test('the self-check runs each service for real, posts one line to the admin channel, and says what is not switched on', async () => {
  app.world.discord.length = 0;
  const r = (await app.post('/api/selfcheck', {}, { token: admin })).body;
  const by = Object.fromEntries(r.steps.map(s => [s.id, s]));
  assert.equal(by.db.status, 'ok'); assert.equal(by.admin.status, 'ok');
  assert.equal(app.world.discord.filter(d => /Self-check/.test(d.body.content)).length, 1, 'one line, nothing public');
  assert.equal(by.push.status, 'skip'); assert.equal(by.sheets.status, 'skip');
  assert.ok(r.steps.every(s => ['ok', 'fail', 'skip'].includes(s.status)));
  assert.equal(JSON.stringify(r).includes(process.env.DISCORD_BOT_TOKEN || 'no-token-set'), false, 'no secrets in the answer');
});

test('a broken bot token and a bad Discord key are reported, not hidden', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-test'; app.world.botBad = true; process.env.DISCORD_PUBLIC_KEY = 'not-a-key';
  const r = (await app.post('/api/selfcheck', {}, { token: admin })).body;
  const good = (await app.post('/api/selfcheck', {}, { token: admin })).body.steps.find(x => x.id === 'bot').status;
  delete process.env.DISCORD_PUBLIC_KEY; delete process.env.DISCORD_BOT_TOKEN; app.world.botBad = false;
  assert.equal(good, 'fail', 'still failing while the bot token is refused');
  const by = Object.fromEntries(r.steps.map(s => [s.id, s]));
  assert.equal(by.buttons.status, 'fail');
  assert.equal(by.bot.status, 'fail');
  assert.equal(r.ok, false);
});

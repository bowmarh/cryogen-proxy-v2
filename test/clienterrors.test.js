'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.discord.length = 0; app.world.db = {}; });
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const report = (b, ua = UA) => app.call('POST', '/api/client-error', { body: b, headers: { 'User-Agent': ua } });

test('a page can report an error without signing in; repeats count under one signature, and the admin channel hears about a new one once', async () => {
  const a = await report({ message: 'Cannot read properties of undefined (reading \'x\')', source: 'https://club.test/js/app.js?v=1', line: 123, page: 'week' });
  assert.equal(a.status, 200);
  await report({ message: 'Cannot read properties of undefined (reading \'x\')', source: 'https://club.test/js/app.js?v=2', line: 123, page: 'week' }, 'Mozilla/5.0 Chrome/120.0 Safari/537.36');
  const list = (await app.get('/api/staff/client-errors', { token: admin })).body.errors;
  assert.equal(list.length, 1); assert.equal(list[0].count, 2); assert.equal(list[0].file, 'app.js', 'the query string is dropped');
  assert.deepEqual(Object.keys(list[0].browsers).sort(), ['Chrome 120', 'Safari 17 (phone)']);
  assert.equal(app.world.discord.filter(p => p.channel === 'admin').length, 1);
  assert.match(app.world.discord[0].body.content, /New browser error/);
});

test('numbers and addresses in a message do not split one error into many; different errors stay apart', async () => {
  await report({ message: 'Item 12 failed at https://a.test/x', source: 'app.js', line: 5 });
  await report({ message: 'Item 99 failed at https://b.test/y', source: 'app.js', line: 5 });
  await report({ message: 'Something else', source: 'app.js', line: 9 });
  const list = (await app.get('/api/staff/client-errors', { token: admin })).body.errors;
  assert.deepEqual(list.map(e => e.count).sort(), [1, 2]);
});

test('nothing that identifies a rider is kept, bad reports are refused, and floods are limited', async () => {
  await report({ message: 'x', source: 'app.js', line: 1, page: 'week', name: 'Ann Lee', zwid: '2000' });
  const text = JSON.stringify(app.world.db);
  assert.equal(/Ann Lee|2000|127\.0\.0\.1|::1/.test(text), false);
  assert.equal((await report({})).status, 400);
  let last = 0; for (let i = 0; i < 25; i++) last = (await report({ message: 'flood ' + i + 'a'.repeat(i), source: 'app.js', line: i })).status;
  assert.equal(last, 429, 'more than 20 a minute from one place is refused');
});

test('only staff see the list and only an administrator clears it', async () => {
  await report({ message: 'boom', source: 'app.js', line: 1 });
  assert.equal((await app.get('/api/staff/client-errors')).status, 401);
  assert.equal((await app.get('/api/staff/client-errors', { token: await app.memberSession('1002') })).status, 401);
  assert.equal((await app.get('/api/staff/client-errors', { token: await app.login('mod') })).status, 200);
  assert.equal((await app.post('/api/staff/client-errors/clear', {}, { token: await app.login('mod') })).status, 403);
  await app.post('/api/staff/client-errors/clear', {}, { token: admin });
  assert.equal((await app.get('/api/staff/client-errors', { token: admin })).body.errors.length, 0);
});

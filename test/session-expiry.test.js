'use strict';
// The page signs staff out when the server says their login has run out, so the wording of that answer is a contract.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.setEnv();
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('an expired or forged staff token is refused with an answer the page recognises', async () => {
  const expired = h.signedToken({ role: 'admin', exp: Date.now() - 1000 }, h.defaultSessionSecret());
  for (const token of [expired, 'not-a-token', undefined]) {
    const r = await app.get('/api/health', { token });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /log in again/i);
  }
  const pageHandles = /log in again/i;
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('/log in again/i'), 'the page looks for that wording');
  assert.ok(pageHandles.test('Please log in again.'));
});

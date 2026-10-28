'use strict';
// Guards for vercel.json: a bad cron entry makes the whole deployment fail on Vercel's side.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

h.setEnv();
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('every Vercel cron points at a real route and fits the free plan (once a day at most)', async () => {
  assert.ok(Array.isArray(config.crons) && config.crons.length >= 1, 'a backup cron is configured');
  assert.ok(config.crons.length <= 2, 'the Hobby plan allows 2 cron jobs');
  for (const c of config.crons) {
    assert.match(c.schedule, /^\d{1,2} \d{1,2} \* \* \*$/, `"${c.schedule}": Hobby crons need a fixed minute and hour, once a day`);
    const r = await app.call('GET', c.path);
    assert.ok(!(r.status === 404 && r.body && r.body.error === 'Not found'), `${c.path} has no route`);
  }
});

test('the cron route accepts exactly what Vercel sends: a GET with the CRON_SECRET as a ******', async () => {
  const ok = await app.call('GET', '/api/cron/tick', { headers: { Authorization: `****** } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body), ['ran']);
  assert.equal((await app.call('GET', '/api/cron/tick')).status, 401, 'strangers are refused');
});

test('the daily Vercel run happens after the 09:00 UK rollover in both summer and winter time', () => {
  const [, hour] = config.crons[0].schedule.split(' ').map(Number);
  assert.ok(hour >= 9, `${hour}:00 UTC is 10:00 BST / 09:00 GMT at the earliest, so after 09:00 UK`);
});

test('the function limits and the /api rewrite are still in place', () => {
  assert.equal(config.functions['api/server.js'].maxDuration, 60);
  assert.deepEqual(config.rewrites, [{ source: '/api/(.*)', destination: '/api/server' }]);
});

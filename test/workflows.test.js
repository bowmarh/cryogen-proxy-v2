'use strict';
// The scheduled workflow is what makes every timed job happen, so its shape is guarded: the call comes first, nothing in front of it can stop it,
// a missing secret or a failing app makes the run fail loudly, and an independent job watches for a gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const wf = f => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8');

test('the TTT schedule workflow makes the tick call as its first and only step, and fails loudly', () => {
  const y = wf('ttt-schedule.yml');
  assert.match(y, /cron: '\*\/15 \* \* \* \*'/);
  assert.equal((y.match(/^\s+- name:/gm) || []).length, 1, 'one step: nothing in front of the call can stop it');
  assert.ok(!/gemini/i.test(y.replace(/^#.*$/gm, '')), 'no Gemini steps in the workflow itself (only a note in the comments)');
  assert.match(y, /-X POST[\s\S]*api\/cron\/tick\?speed=auto/);
  assert.match(y, /CRON_SECRET repository secret is not set[\s\S]*exit 1/, 'a missing secret fails the run instead of skipping it');
  assert.match(y, /"\$code" != "200"[\s\S]*exit 1/); assert.match(y, /-ge 3[\s\S]*exit 1/, 'three or more failed jobs fail the run');
});

test('an independent job in the uptime workflow fails when the schedule has not succeeded for 90 minutes', () => {
  const y = wf('uptime.yml');
  assert.match(y, /ticks:/); assert.match(y, /actions: read/); assert.match(y, /workflows\/ttt-schedule\.yml\/runs\?status=success/); assert.match(y, /-gt 90/);
});

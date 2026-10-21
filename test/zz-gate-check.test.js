'use strict';
// THROWAWAY: fails on purpose to prove GitHub blocks merging when the `test` check fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('deliberate failure for the merge-gate check (this branch must never be merged)', () => {
  assert.equal(1, 2);
});

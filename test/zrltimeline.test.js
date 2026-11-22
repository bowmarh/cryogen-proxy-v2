'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'public/js/app.js'), 'utf8');
const body = src.slice(src.indexOf('function zrlTimeline('), src.indexOf('function renderZrl('));
const make = stand => new Function('esc', 'zrlStand', body + '; return zrlTimeline;')(s => String(s), stand);
const timeline = make(null);

test('the season timeline ticks past races, highlights the next one and copes with no round dates', () => {
  const ymd = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const html = timeline({ start: ymd(-9), weeks: 4 });
  assert.match(html, /✓ Race 1/);
  assert.match(html, /✓ Race 2/);
  assert.doesNotMatch(html, /✓ Race 3/);
  assert.match(html, /Race 3 of 4 is next/);
  assert.match(timeline({ start: ymd(-60), weeks: 4 }), /Season complete/);
  assert.match(timeline({ start: ymd(5), weeks: 3 }), /First race \d+ days away/);
  assert.equal(timeline({ start: '', weeks: 3 }), '');
  const withRes = make({ groups: [{ teams: [{ weeks: [{ pos: 3, pts: 10 }, null] }, { weeks: [{ pos: 2, pts: 12 }, null] }] }] });
  assert.match(withRes({ start: ymd(-9), weeks: 3 }), /best 2nd/);
  assert.doesNotMatch(timeline({ start: ymd(-9), weeks: 3 }), /best/);
});

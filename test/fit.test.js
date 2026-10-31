'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, rng } = require('./fitwriter');
const FitParse = require('../public/js/fit.js');
const { analyse } = require('../lib/fitanalysis');

const G = 9.81;
// A made-up ride: `sec` seconds; power and heart rate come from the functions, with a little noise.
function ride(sec, { p = i => 220, hr = i => 140, cad = i => 90, rows = false } = {}, seed = 7) {
  const R = rng(seed), s = { t: [], p: [], hr: [], cad: [], spd: [], dist: [], alt: [] };
  for (let i = 0; i < sec; i++) { const pv = p(i), hv = hr(i); s.t.push(i); s.p.push(pv === null ? null : pv === 'raw' ? 0 : Math.round(pv + (R() - 0.5) * 24)); s.hr.push(hv === null ? null : Math.round(hv + (R() - 0.5) * 4)); s.cad.push(cad(i)); s.spd.push(9); s.dist.push(i * 9); s.alt.push(0); }
  return s;
}
const flat = (s, from, to, watts) => { for (let i = from; i < to; i++) s.p[i] = watts; return s; };
const ids = r => r.findings.map(f => f.id);

test('a FIT file is read back: seconds, power, heart rate (a missing one stays missing), the devices and the maker', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ p: 200 + (i % 7), hr: i < 100 ? null : 150, cad: 88, spd: 8.5, dist: i * 8.5, alt: 120.4 + i * 0.1 }));
  const buf = build({ rows, devices: [{ type: 11, maker: 260, product: 1, name: 'Zwift Power' }, { type: 120, maker: 32, product: 5, name: '' }] });
  const f = FitParse.parse(buf);
  assert.equal(f.samples.t.length, 300); assert.deepEqual([f.samples.t[0], f.samples.t[299]], [0, 299]);
  assert.deepEqual([f.samples.p[0], f.samples.p[8]], [200, 201]);
  assert.equal(f.samples.hr[50], null); assert.equal(f.samples.hr[150], 150);
  assert.ok(Math.abs(f.samples.alt[10] - 121.4) < 0.3 && Math.abs(f.samples.spd[0] - 8.5) < 0.001 && Math.abs(f.samples.dist[10] - 85) < 0.01);
  assert.deepEqual(f.devices.map(d => [d.type, d.manufacturer]), [['Power meter', 'Zwift'], ['Heart rate strap', 'Wahoo']]);
  assert.equal(f.devices[0].name, 'Zwift Power'); assert.equal(f.session.avgPower, 200);
  assert.equal(new Date(f.start).getUTCFullYear(), 2026);
});

test('files that are not FIT files, or are cut short, are refused with a plain message', () => {
  assert.throws(() => FitParse.parse(Buffer.from('hello world, this is not a fit file at all')), /not a FIT file/);
  const good = build({ rows: Array.from({ length: 50 }, () => ({ p: 100, hr: 120, cad: 80 })) });
  assert.throws(() => FitParse.parse(good.subarray(0, 60)), /cut short|damaged/);
});

test('a normal ride has nothing that stands out', () => {
  const s = ride(3600, { p: i => 200 + 60 * Math.sin(i / 120) + (i % 600 > 540 ? 120 : 0), hr: i => 125 + 0.1 * (200 + 60 * Math.sin(i / 120) + (i % 600 > 540 ? 120 : 0)) - 10 });
  const r = analyse(s, { weightKg: 75 });
  assert.equal(r.ok, true); assert.deepEqual(ids(r), [], JSON.stringify(r.findings));
  assert.ok(r.metrics.best[1200].w > 200 && r.metrics.hr.coverage > 0.99 && r.metrics.np > r.metrics.avgPower);
  assert.equal(r.series.step, 10); assert.equal(r.series.p.length, 360);
});

test('too little data is said plainly', () => {
  assert.match(analyse(ride(60)).error, /less than two minutes/);
  assert.equal(analyse({}).ok, false);
});

test('the same power for a long stretch is flagged, by length, with the ordinary reasons beside it', () => {
  const s = flat(ride(1800), 600, 720, 260);
  const f = analyse(s).findings.find(x => x.id === 'sticky_run');
  assert.equal(f.severity, 2); assert.match(f.detail, /120 seconds in a row at exactly 260 W/);
  assert.ok(f.innocent.some(x => /ERG/.test(x)));
  assert.equal(analyse(flat(ride(1800), 600, 615, 260)).findings.some(x => x.id === 'sticky_run'), false, '15 seconds is nothing');
  assert.equal(analyse(flat(ride(1800), 100, 400, 260)).findings.find(x => x.id === 'sticky_run').severity, 3);
  assert.equal(analyse(flat(ride(1800), 100, 460, 260)).findings.some(x => x.id === 'smooth_minutes'), true);
});

test('heart rate: missing in the hardest effort, flat while power moves, and absent altogether are told apart', () => {
  const hard = ride(3000, { p: i => (i >= 900 && i < 2100 ? 330 : 180), hr: i => (i >= 900 && i < 2100 ? null : 135) });
  assert.ok(ids(analyse(hard)).includes('hr_missing_1200'));
  const flatHr = ride(2400, { p: i => 150 + 100 * Math.sin(i / 60), hr: () => 150 });
  assert.equal(analyse(flatHr).findings.find(x => x.id === 'hr_flat').severity, 3);
  const none = ride(1800, { hr: () => null }), n = analyse(none);
  assert.deepEqual(ids(n), ['hr_absent']); assert.equal(n.findings[0].severity, 1);
});

test('power dropping to zero while still pedalling is counted', () => {
  const s = ride(1800); for (let k = 0; k < 8; k++) for (let i = 200 + k * 100; i < 206 + k * 100; i++) s.p[i] = 0;
  const f = analyse(s).findings.find(x => x.id === 'dropouts');
  assert.equal(f.severity, 1); assert.match(f.detail, /8 times \(48 seconds/);
});

test('the climbs say how heavy the rider is: a rider much lighter than registered is flagged, an honest one is not', () => {
  // A steady 6% climb at 4 m/s for 15 minutes, with the power a 70 kg rider on a 9.5 kg bike would need.
  const climb = riderKg => { const m = riderKg + 9.5, v = 4, grade = 0.06, P = v * (m * G * (grade + 0.004) + 0.5 * 1.225 * 0.32 * v * v); const s = ride(900, { p: () => P, hr: () => 160 }, 3); for (let i = 0; i < 900; i++) { s.dist[i] = i * v; s.alt[i] = i * v * grade; s.spd[i] = v; } return s; };
  const lighter = analyse(climb(70), { weightKg: 80 });
  const f = lighter.findings.find(x => x.id === 'weight_implied');
  assert.ok(f && f.severity >= 2, JSON.stringify(lighter.metrics.mass)); assert.ok(Math.abs(lighter.metrics.mass.impliedRiderKg - 70) < 3);
  assert.equal(analyse(climb(70), { weightKg: 71 }).findings.some(x => x.id === 'weight_implied'), false);
  assert.equal(analyse(climb(70)).metrics.mass.windows >= 3, true, 'the estimate is still made without a registered weight, but nothing is flagged');
});

test('the best efforts are compared with the roster, kindly: an extra 10% is information, not an accusation', () => {
  const s = ride(2400, { p: i => 280, hr: () => 160 });
  const f = analyse(s, { weightKg: 75, roster: { wkg1200: 3.3 } }).findings.find(x => x.id === 'above_roster_1200');
  assert.equal(f.severity, 1); assert.match(f.detail, /3\.7\d? W\/kg in this file against 3\.3 W\/kg/);
});

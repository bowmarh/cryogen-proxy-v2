'use strict';
// Looks at one ride's recorded data (power, heart rate, cadence, speed, distance, altitude, once a second) and says what stands out and what could
// innocently explain it. It describes; it does not judge. Every finding carries the numbers behind it and the ordinary reasons it can happen.
const MAX_SECONDS = 6 * 3600;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

// Puts the samples on a one-second grid (null where nothing was recorded) and drops anything that is not a number.
function resample(s) {
  const t = Array.isArray(s && s.t) ? s.t : [];
  const n = Math.min(t.length ? Math.floor(Math.max(...t.filter(x => Number.isFinite(x)))) + 1 : 0, MAX_SECONDS);
  const g = { p: [], hr: [], cad: [], spd: [], dist: [], alt: [] };
  for (const k of Object.keys(g)) g[k] = new Array(n).fill(null);
  for (let i = 0; i < t.length; i++) {
    const at = Math.floor(t[i]); if (!(at >= 0 && at < n)) continue;
    for (const k of Object.keys(g)) { const v = num(s[k] && s[k][i]); if (v !== null) g[k][at] = v; }
  }
  g.p = g.p.map(v => (v !== null && v >= 0 && v <= 4000 ? v : v === null ? null : null));
  return { n, ...g };
}

const prefix = a => { const p = [0]; for (const v of a) p.push(p[p.length - 1] + (v || 0)); return p; };
function bestMean(P, win) {
  if (P.length < win) return null;
  const pre = prefix(P); let best = -1, at = 0;
  for (let i = 0; i + win <= P.length; i++) { const m = (pre[i + win] - pre[i]) / win; if (m > best) { best = m; at = i; } }
  return { w: best, start: at };
}
function np(P) {
  if (P.length < 60) return null;
  const pre = prefix(P), roll = [];
  for (let i = 30; i <= P.length; i++) roll.push((pre[i] - pre[i - 30]) / 30);
  return Math.pow(mean(roll.map(x => x ** 4)), 0.25);
}
function pearson(a, b) {
  const x = [], y = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null) { x.push(a[i]); y.push(b[i]); }
  if (x.length < 300) return null;
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
// Moving average over `w` seconds, ignoring gaps.
function smooth(a, w) {
  const out = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) { const seg = a.slice(Math.max(0, i - w + 1), i + 1).filter(v => v !== null); if (seg.length >= w / 2) out[i] = mean(seg); }
  return out;
}

// What the climbs say the rider weighs: on a steady climb at low speed nearly all the power lifts the rider and the bike, so mass is power / (speed x gravity x (grade + rolling resistance)).
function impliedMass(R) {
  const est = [], g = 9.81, crr = 0.004, rho = 1.225, cda = 0.32, win = 120;
  for (let s = 0; s + win < R.n; s += 60) {
    const e = s + win, d0 = R.dist[s], d1 = R.dist[e], a0 = R.alt[s], a1 = R.alt[e];
    if (d0 === null || d1 === null || a0 === null || a1 === null || d1 - d0 < 100) continue;
    const grade = (a1 - a0) / (d1 - d0), v = (d1 - d0) / win;
    if (grade < 0.03 || grade > 0.15 || v < 1.5 || v > 6.5) continue;
    const seg = R.p.slice(s, e + 1);
    if (seg.filter(x => x !== null).length < win * 0.9) continue;
    const pm = mean(seg.map(x => x || 0)); if (pm < 80 || sd(seg.map(x => x || 0)) / pm > 0.3) continue;
    const m = (pm / v - 0.5 * rho * cda * v * v) / (g * (grade + crr));
    if (m > 40 && m < 160) est.push(m);
  }
  return est.length >= 3 ? { windows: est.length, mass: r1(median(est)), spread: r1(sd(est)) } : null;
}

const sev = (v, lo, mid, hi) => (v >= hi ? 3 : v >= mid ? 2 : v >= lo ? 1 : 0);

// The findings that depend on the rider's registered weight: how heavy the climbs say they are, and the best efforts against the roster.
// It also fills in W/kg on the best efforts. Pure, so it can be run again from the stored numbers when the weight is corrected.
function weightFindings(m, kg, roster) {
  const out = [], add = (id, severity, label, detail, innocent) => severity > 0 && out.push({ id, severity, label, detail, innocent });
  for (const b of Object.values(m.best || {})) b.wkg = kg ? r2(b.w / kg) : null;
  if (m.mass) { delete m.mass.impliedRiderKg; delete m.mass.declaredKg; }
  if (m.mass && kg) {
    const bike = 9.5, rider = r1(m.mass.mass - bike), diff = r1(kg - rider);
    m.mass.impliedRiderKg = rider; m.mass.declaredKg = kg;
    add('weight_implied', diff >= 9 ? 3 : diff >= 6 ? 2 : diff >= 4 ? 1 : 0, 'The climbs fit a lighter rider than the registered weight', `Across ${m.mass.windows} steady climbs the speed for the power fits about ${rider} kg (assuming a ${bike} kg bike); the registered weight is ${kg} kg. This is an estimate: expect it to be within about 4 kg either way.`, ['A heavier or lighter bike than assumed', 'Clothing, bottles or a different weight entered in the game profile than in the registry', 'Draft effects and route noise']);
  }
  if (kg && roster) {
    for (const [k, win, label] of [['wkg300', 300, '5 minute'], ['wkg1200', 1200, '20 minute']]) {
      const rw = num(roster[k]), b = (m.best || {})[win];
      if (rw && b && b.wkg > rw * 1.05) add('above_roster_' + win, b.wkg > rw * 1.15 ? 2 : 1, `Best ${label} is above the roster figure`, `${b.wkg} W/kg in this file against ${rw} W/kg best on the roster (${Math.round((b.wkg / rw - 1) * 100)}% above, using ${kg} kg).`, ['The roster figure can lag behind a new personal best', 'A different weight is entered in the game than the one used here', 'This is genuinely a better day']);
    }
  }
  return out;
}
// Re-runs only the weight-dependent part of a finished analysis.
function reweigh(a, kg, roster) {
  const keep = a.findings.filter(f => f.id !== 'weight_implied' && !f.id.startsWith('above_roster_'));
  const findings = [...keep, ...weightFindings(a.metrics, num(kg) > 30 ? Number(kg) : null, roster)].sort((x, y) => y.severity - x.severity);
  return { ...a, findings, top: findings.length ? findings[0].severity : 0 };
}

function analyse(samples, opts = {}) {
  const R = resample(samples || {});
  if (R.n < 120) return { ok: false, error: 'The file has less than two minutes of data, which is too little to look at.' };
  const kg = num(opts.weightKg) > 30 ? Number(opts.weightKg) : null;
  const has = a => a.filter(v => v !== null).length;
  const m = { seconds: R.n, powerSeconds: has(R.p), hrSeconds: has(R.hr), cadSeconds: has(R.cad) };
  const pw = R.p.filter(v => v !== null);
  m.avgPower = r1(mean(pw)); m.maxPower = Math.max(...pw, 0); m.np = np(R.p.map(v => v || 0)) ? r1(np(R.p.map(v => v || 0))) : null;
  m.vi = m.np && m.avgPower ? r2(m.np / m.avgPower) : null;
  m.best = {};
  for (const [k, win] of [[5, 5], [60, 60], [300, 300], [1200, 1200]]) { const b = bestMean(R.p, win); if (b) m.best[k] = { w: Math.round(b.w), start: b.start, wkg: null }; }

  const findings = [], add = (id, severity, label, detail, innocent) => severity > 0 && findings.push({ id, severity, label, detail, innocent });

  // ── Heart rate ──
  const hrCov = m.powerSeconds ? has(R.hr) / R.n : 0;
  m.hr = { coverage: r2(hrCov), avg: has(R.hr) ? Math.round(mean(R.hr.filter(v => v !== null && v > 30))) : null, max: has(R.hr) ? Math.max(...R.hr.filter(v => v !== null)) : null };
  const hardest = [300, 1200].filter(w => m.best[w]);
  for (const w of hardest) {
    const b = m.best[w], seg = R.hr.slice(b.start, b.start + w), cov = seg.filter(v => v !== null && v > 30).length / w;
    m.hr['cov' + w] = r2(cov); m.hr['avg' + w] = cov > 0.3 ? Math.round(mean(seg.filter(v => v !== null && v > 30))) : null;
    if (cov < 0.5 && b.w > (m.avgPower || 0) * 1.1) add('hr_missing_' + w, w === 1200 ? 2 : 1, `No heart rate in the hardest ${w / 60} minutes`, `Only ${Math.round(cov * 100)}% of the hardest ${w / 60}-minute effort (${b.w} W) has a heart rate.`, ['The strap lost contact or its battery died', 'No strap was worn for this ride', 'The strap was paired to another device']);
  }
  if (has(R.hr) >= 600) {
    const r = pearson(smooth(R.p, 30), smooth(R.hr, 30));
    m.hr.powerCorrelation = r === null ? null : r2(r);
    const hv = R.hr.filter(v => v !== null && v > 30), pv = smooth(R.p, 30).filter(v => v !== null);
    if (sd(hv) < 3 && sd(pv) > 60) add('hr_flat', 3, 'Heart rate is almost flat while power moves a lot', `Heart rate varied by only ${r1(sd(hv))} bpm while power varied by ${Math.round(sd(pv))} W.`, ['A strap stuck on a fixed reading', 'An optical sensor locked onto cadence', 'Heart rate simulated by another app']);
    else if (r !== null && r < 0.25 && sd(pv) > 50) add('hr_decoupled', r < 0 ? 3 : 2, 'Heart rate does not follow power', `Smoothed heart rate and power correlate at ${r2(r)} (most rides show about 0.5 to 0.9).`, ['Interval work with long recoveries and strap lag', 'Caffeine, illness, heat or poor sleep', 'An optical wrist sensor']);
    // Heart rate low for the hardest 20 minutes compared with the rest of the ride.
    if (m.hr.avg1200 && m.hr.max && m.hr.avg1200 / m.hr.max < 0.72 && m.best[1200].w > (m.avgPower || 0) * 1.15) add('hr_low_hard', 2, 'Heart rate was low for the hardest effort', `Average ${m.hr.avg1200} bpm in the best 20 minutes (${m.best[1200].w} W) against a ride maximum of ${m.hr.max} bpm.`, ['A well-rested, very fit rider', 'Heat or fatigue lowering heart rate', 'A lower peak than usual in this file']);
  } else if (has(R.p) >= 900 && hrCov < 0.1) {
    m.hr.none = true;
    add('hr_absent', 1, 'No heart rate recorded', 'The ride has power for over 15 minutes and no heart rate.', ['No strap was worn', 'The strap was paired to another device', 'Some platforms do not save it']);
  }
  // Decoupling: first half against the second half (information, not a flag).
  if (R.n >= 2400 && has(R.hr) > R.n * 0.6) {
    const half = R.n >> 1, ef = (a, b) => { let ps = [], hs = []; for (let i = a; i < b; i++) if (R.p[i] > 50 && R.hr[i] > 30) { ps.push(R.p[i]); hs.push(R.hr[i]); } return ps.length > 300 ? mean(ps) / mean(hs) : null; };
    const e1 = ef(0, half), e2 = ef(half, R.n); if (e1 && e2) m.hr.decouplingPct = r1((e1 - e2) / e1 * 100);
  }

  // ── Flat ("sticky") power ──
  let run = 1, longest = 0, runAt = 0, stuckSeconds = 0;
  for (let i = 1; i <= R.n; i++) {
    if (i < R.n && R.p[i] !== null && R.p[i] === R.p[i - 1] && R.p[i] > 120) { run++; continue; }
    if (run >= 20 && R.p[i - 1] > 120) { stuckSeconds += run; if (run > longest) { longest = run; runAt = i - run; } }
    run = 1;
  }
  m.flat = { longestSeconds: longest, at: runAt, totalSeconds: stuckSeconds, watts: longest ? R.p[runAt] : null };
  add('sticky_run', sev(longest, 30, 60, 180), 'The same power for a long stretch', `${longest} seconds in a row at exactly ${m.flat.watts} W (from ${Math.floor(runAt / 60)} min). A real power meter moves by a few watts every second.`, ['A structured workout in ERG mode holds an exact target', 'A trainer or power meter dropped out and repeated its last value', 'A Bluetooth connection stalled']);
  let smooth60 = 0, windows60 = 0;
  for (let s = 0; s + 60 <= R.n; s += 60) { const seg = R.p.slice(s, s + 60); if (seg.every(v => v !== null)) { windows60++; const mu = mean(seg); if (mu > 150 && sd(seg) / mu < 0.01) smooth60++; } }
  m.flat.smoothMinutes = smooth60;
  add('smooth_minutes', sev(smooth60, 5, 10, 20), 'Unusually smooth power', `${smooth60} of ${windows60} one-minute stretches varied by less than 1% (a real effort varies by 5 to 15%).`, ['ERG mode or a workout with fixed targets', 'A very steady rider on a flat course with a smart trainer']);

  // ── Dropouts and spikes ──
  let drop = 0, dropSeconds = 0, z = 0;
  for (let i = 0; i <= R.n; i++) {
    const moving = i < R.n && R.p[i] === 0 && ((R.cad[i] || 0) > 40 || (R.spd[i] || 0) > 5);
    if (moving) z++; else { if (z >= 3) { drop++; dropSeconds += z; } z = 0; }
  }
  m.dropouts = { count: drop, seconds: dropSeconds };
  add('dropouts', sev(drop, 5, 15, 40), 'Power dropped to zero while still moving', `${drop} times (${dropSeconds} seconds in all) power read 0 while the rider was pedalling or moving.`, ['A wireless connection to the trainer or power meter faltered', 'A battery was low', 'Interference from other devices']);
  let jumps = 0; for (let i = 1; i < R.n; i++) if (R.p[i] !== null && R.p[i - 1] !== null && R.p[i] - R.p[i - 1] >= 1000) jumps++;
  add('spikes', m.maxPower > 2500 ? 3 : sev(jumps, 3, 8, 20), m.maxPower > 2500 ? 'An impossible power value' : 'Sudden jumps in power', m.maxPower > 2500 ? `The highest reading is ${m.maxPower} W.` : `${jumps} times power rose by 1000 W or more from one second to the next.`, ['A sprint from a standstill on a smart trainer', 'A faulty reading from the meter']);
  const padSeconds = R.p.filter((v, i) => v > 50 && R.cad[i] === 0).length;
  m.cadenceZero = padSeconds;
  if (has(R.cad) > R.n * 0.5) add('power_no_cadence', sev(padSeconds / R.n * 100, 3, 8, 20), 'Power with no pedalling', `${padSeconds} seconds with power above 50 W and cadence 0.`, ['A cadence sensor that dropped out', 'A trainer reporting cadence separately']);

  // ── Things that need the registered weight (kept apart so a changed weight can be re-run without the raw file) ──
  m.mass = impliedMass(R);
  findings.push(...weightFindings(m, kg, opts.roster));

  // ── Chart data: a point every 10 seconds ──
  const step = 10, series = { step, p: [], hr: [] };
  for (let s = 0; s < R.n; s += step) {
    const p = R.p.slice(s, s + step).filter(v => v !== null), h = R.hr.slice(s, s + step).filter(v => v !== null && v > 30);
    series.p.push(p.length ? Math.round(mean(p)) : null); series.hr.push(h.length ? Math.round(mean(h)) : null);
  }
  findings.sort((a, b) => b.severity - a.severity);
  return { ok: true, metrics: m, findings, series, top: findings.length ? findings[0].severity : 0 };
}

module.exports = { analyse, reweigh, weightFindings, resample, bestMean, MAX_SECONDS };

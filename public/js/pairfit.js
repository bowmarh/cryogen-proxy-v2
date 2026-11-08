'use strict';
// FIT pair comparator: pure analysis of a Zwift recording against a second-source recording of the same ride. Works in the browser and in Node.
// It produces INDICATORS for a person to look at, never verdicts. Nothing here reads, stores or sends a file: callers pass in decoded FIT messages.
(function (root) {
  // ── Heuristic thresholds. All are UNTUNED starting points, chosen by judgement, not calibrated on real dual recordings. Expect to adjust them. ──
  const MAX_LAG_S = 15;           // alignment search window: +/- this many seconds
  const MIN_OVERLAP_S = 120;      // fewest overlapping 1 Hz samples we will analyse
  const MIN_POWER_W = 100;        // ratio statistics only use seconds where BOTH files read above this
  const WINDOW_S = 60;            // rolling window length for ratio stability
  const WINDOW_STEP_S = 30;       // how far the window moves each step
  const MIN_WINDOW_VALID_S = 30;  // a window needs this many usable seconds to count
  const MIN_WINDOWS = 5;          // fewest windows needed to quote a coefficient of variation
  const SAME_R = 0.999;           // "same meter likely": correlation at or above this ...
  const SAME_CV = 0.01;           // ... with ratio CV at or below this ...
  const SAME_RATIO_TOL = 0.01;    // ... and mean ratio within this of 1
  const OFFSET_CV = 0.02;         // "constant percentage offset": ratio CV at or below this ...
  const OFFSET_MIN_DEV = 0.03;    // ... and mean ratio at least this far from 1 ...
  const OFFSET_MIN_R = 0.95;      // ... and the two curves still clearly the same ride
  const THRESHOLDS = { MAX_LAG_S, MIN_OVERLAP_S, MIN_POWER_W, WINDOW_S, WINDOW_STEP_S, MIN_WINDOW_VALID_S, MIN_WINDOWS, SAME_R, SAME_CV, SAME_RATIO_TOL, OFFSET_CV, OFFSET_MIN_DEV, OFFSET_MIN_R };

  const POWER_TYPES = ['bikePower', 11];
  const toSec = t => (t instanceof Date ? t.getTime() / 1000 : Number.isFinite(Number(t)) ? Number(t) : null);
  const clean = v => (v === undefined || v === null || v === '' ? null : v);
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const isPowerDev = d => POWER_TYPES.includes(d.type) || POWER_TYPES.includes(d.antplusType);

  // Turn a fitsdk Decoder result's `messages` into the plain shape the analysis uses. Values are kept raw (as the file states them).
  function extract(messages) {
    const m = messages || {};
    const id = (m.fileIdMesgs || [])[0] || {}, cr = (m.fileCreatorMesgs || [])[0] || {};
    const devices = (m.deviceInfoMesgs || []).map(d => ({
      index: clean(d.deviceIndex), type: clean(d.deviceType), antplusType: clean(d.antplusDeviceType), manufacturer: clean(d.manufacturer), product: clean(d.product),
      productName: clean(d.productName), serial: clean(d.serialNumber), antNumber: clean(d.antDeviceNumber), softwareVersion: clean(d.softwareVersion), hardwareVersion: clean(d.hardwareVersion),
      timestamp: toSec(d.timestamp),
    }));
    const t = [], w = [];
    for (const r of m.recordMesgs || []) { const s = toSec(r.timestamp); if (s == null) continue; t.push(s); w.push(r.power == null ? null : num(r.power)); }
    return {
      fileId: { type: clean(id.type), manufacturer: clean(id.manufacturer), product: clean(id.product), productName: clean(id.productName), serial: clean(id.serialNumber), timeCreated: toSec(id.timeCreated) },
      creator: { softwareVersion: clean(cr.softwareVersion), hardwareVersion: clean(cr.hardwareVersion) },
      devices, power: { t, w },
    };
  }

  // Resample to a 1 Hz series: { start, w[] } where w[i] is the power at second start+i (null when nothing was recorded that second).
  function toSeries(p) {
    const sums = new Map();
    for (let i = 0; i < p.t.length; i++) {
      if (p.w[i] == null) continue;
      const k = Math.floor(p.t[i]), c = sums.get(k) || [0, 0]; c[0] += p.w[i]; c[1]++; sums.set(k, c);
    }
    if (!sums.size) return { start: 0, w: [] };
    const keys = [...sums.keys()], start = Math.min(...keys), end = Math.max(...keys), w = new Array(end - start + 1).fill(null);
    for (const [k, c] of sums) w[k - start] = c[0] / c[1];
    return { start, w };
  }

  function pearson(xs, ys) {
    const n = xs.length; if (n < 2) return null;
    let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    const mx = sx / n, my = sy / n; let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // Pairs (zwift, second) at a lag: second[t + lag] is matched with zwift[t], on absolute seconds.
  function pairsAt(a, b, lag) {
    const xs = [], ys = [], at = [];
    for (let i = 0; i < a.w.length; i++) {
      const j = a.start + i + lag - b.start;
      if (j < 0 || j >= b.w.length) continue;
      if (a.w[i] == null || b.w[j] == null) continue;
      xs.push(a.w[i]); ys.push(b.w[j]); at.push(i);
    }
    return { xs, ys, at };
  }

  // Ratio stability: the second file's power divided by Zwift's, summed over rolling 60 s windows; the CV of those window ratios.
  function ratioStats(xs, ys, at) {
    const both = [];
    let ratioSum = 0;
    for (let i = 0; i < xs.length; i++) if (xs[i] > MIN_POWER_W && ys[i] > MIN_POWER_W) { both.push(i); ratioSum += ys[i] / xs[i]; }
    const meanRatio = both.length ? ratioSum / both.length : null;
    const first = at.length ? at[0] : 0, last = at.length ? at[at.length - 1] : 0, ratios = [];
    for (let s = first; s + WINDOW_S <= last + 1; s += WINDOW_STEP_S) {
      let a = 0, b = 0, n = 0;
      for (let k = 0; k < xs.length; k++) { if (at[k] < s) continue; if (at[k] >= s + WINDOW_S) break; if (xs[k] > MIN_POWER_W && ys[k] > MIN_POWER_W) { a += xs[k]; b += ys[k]; n++; } }
      if (n >= MIN_WINDOW_VALID_S && a > 0) ratios.push(b / a);
    }
    let cv = null;
    if (ratios.length >= MIN_WINDOWS) {
      const m = ratios.reduce((x, y) => x + y, 0) / ratios.length, sd = Math.sqrt(ratios.reduce((x, y) => x + (y - m) * (y - m), 0) / ratios.length);
      cv = m ? sd / m : null;
    }
    return { meanRatio, cv, windows: ratios.length, usableSeconds: both.length };
  }

  const same = (x, y) => x != null && y != null && String(x) === String(y);
  const powerDevs = f => f.devices.filter(isPowerDev);

  const EXPLAIN = {
    same_meter: 'The two files carry the same power-meter identity, or their power lines are almost identical second by second. That usually means one power meter was paired to both devices, which is normally an honest setup mistake (for example a trainer or meter connected to the bike computer and to Zwift together). It means the second file may not be an independent check.',
    constant_offset: 'The two files follow the same shape, but one reads a steady percentage higher or lower than the other the whole way through. Two separate meters drift and wobble a little relative to each other; a flat percentage gap is more unusual. There are innocent causes too (different calibration, a trainer versus crank meter, a scale or weight setting), so this is a prompt to ask, not a conclusion.',
    creator_identity: "The second file doesn't look like it came from a separate device: its creator is the same as the Zwift file's, or it carries no serial number to tell it apart. Some apps and converters strip or reuse identity details, so this alone proves nothing.",
    none: 'None of the checks stood out. That is not proof either way: it only means these particular checks found nothing to look at.',
  };
  const LABEL = {
    same_meter: 'Same meter likely paired to both devices', constant_offset: 'Constant percentage offset',
    creator_identity: "Second file creator identity doesn't match a separate device", none: 'No indicators found',
  };
  const NOTE = 'These are prompts for a person to look closer, not proof of anything. Files are read in your browser and are not uploaded or stored.';

  // zwift, second: outputs of extract(). Returns the alignment, the numbers, the raw identities side by side and the indicators.
  function compare(zwift, second) {
    const a = toSeries(zwift.power), b = toSeries(second.power);
    const identity = { zwift: describe(zwift), second: describe(second) };
    const indicators = [];
    const add = (code, why) => indicators.push({ code, label: LABEL[code], explanation: EXPLAIN[code], evidence: why });

    // (b) shared power-sensor serial or device number
    const za = powerDevs(zwift), zb = powerDevs(second), sharedSerial = [], sharedAnt = [];
    for (const x of za) for (const y of zb) {
      if (same(x.serial, y.serial) && Number(x.serial) !== 0) sharedSerial.push(x.serial);
      if (same(x.antNumber, y.antNumber) && Number(x.antNumber) !== 0) sharedAnt.push(x.antNumber);
    }
    // (c) creator identity: same manufacturer + product + serial as the Zwift file, or no serial at all
    const zi = zwift.fileId, si = second.fileId, creatorWhy = [];
    if (si.serial == null) creatorWhy.push('The second file has no creator serial number.');
    if (same(zi.manufacturer, si.manufacturer) && same(zi.product, si.product) && (zi.serial == null ? si.serial == null : same(zi.serial, si.serial))) creatorWhy.push('The second file reports the same manufacturer, product and serial as the Zwift file.');

    // Numbers
    let stats = { aligned: false };
    let best = null;
    for (let lag = -MAX_LAG_S; lag <= MAX_LAG_S; lag++) {
      const p = pairsAt(a, b, lag); if (p.xs.length < MIN_OVERLAP_S) continue;
      const r = pearson(p.xs, p.ys); if (r == null) continue;
      if (!best || r > best.r) best = { lag, r, p };
    }
    if (best) {
      const rs = ratioStats(best.p.xs, best.p.ys, best.p.at);
      stats = { aligned: true, lagSeconds: best.lag, overlapSeconds: best.p.xs.length, r: best.r, meanRatio: rs.meanRatio, ratioCv: rs.cv, windows: rs.windows, usableSeconds: rs.usableSeconds };
    }
    const dev = stats.meanRatio != null ? Math.abs(stats.meanRatio - 1) : null;

    if (sharedSerial.length || sharedAnt.length) add('same_meter', `Both files list the same power sensor (${sharedSerial.length ? 'serial ' + [...new Set(sharedSerial)].join(', ') : 'device number ' + [...new Set(sharedAnt)].join(', ')}).`);
    else if (stats.aligned && stats.r >= SAME_R && stats.ratioCv != null && stats.ratioCv <= SAME_CV && dev != null && dev <= SAME_RATIO_TOL) add('same_meter', `Correlation ${stats.r.toFixed(4)} with a near-constant ratio of about ${stats.meanRatio.toFixed(3)}.`);
    if (stats.aligned && stats.ratioCv != null && stats.ratioCv <= OFFSET_CV && dev != null && dev > OFFSET_MIN_DEV && stats.r >= OFFSET_MIN_R) add('constant_offset', `The second file reads ${((stats.meanRatio - 1) * 100).toFixed(1)}% ${stats.meanRatio > 1 ? 'above' : 'below'} Zwift, with the ratio varying by only ${(stats.ratioCv * 100).toFixed(2)}% between 60 s windows.`);
    if (creatorWhy.length) add('creator_identity', creatorWhy.join(' '));
    if (!indicators.length) add('none', stats.aligned ? '' : 'Not enough overlapping power data to compare the two recordings, so the numeric checks could not run.');
    return { stats, identity, indicators, note: NOTE, thresholds: THRESHOLDS, untuned: true };
  }

  // Raw identity of one file: nothing is looked up or translated, so unknown makers and products show as the numbers the file holds.
  function describe(f) {
    return {
      fileId: f.fileId, creator: f.creator,
      powerSensors: powerDevs(f).map(d => ({ manufacturer: d.manufacturer, product: d.product, serial: d.serial, antNumber: d.antNumber, softwareVersion: d.softwareVersion, hardwareVersion: d.hardwareVersion })),
      devices: f.devices.map(d => ({ type: d.type, antplusType: d.antplusType, manufacturer: d.manufacturer, product: d.product, productName: d.productName, serial: d.serial, antNumber: d.antNumber, softwareVersion: d.softwareVersion })),
      seconds: f.power.w.filter(x => x != null).length,
    };
  }

  const api = { extract, compare, THRESHOLDS, LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PairFit = api;
})(typeof self !== 'undefined' ? self : this);

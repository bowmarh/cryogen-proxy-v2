'use strict';
// A small Garmin FIT file reader: the bike data (time, power, heart rate, cadence, speed, distance, altitude), the devices that recorded it and the
// session summary. It runs in the browser (so a file never has to be uploaded whole) and in Node (for the tests). It reads; it never writes.
(function (root) {
  const EPOCH = 631065600;   // FIT time counts seconds from 1989-12-31; this turns it into Unix seconds
  const MANUFACTURERS = { 1: 'Garmin', 6: 'SRM', 7: 'Quarq', 9: 'Saris', 13: 'Dynastream', 15: 'Dynastream', 23: 'Suunto', 32: 'Wahoo', 38: 'o_synce', 48: 'Pioneer', 51: 'Polar-4iiii', 69: 'Stages', 70: 'Polar', 86: 'Elite', 89: 'Tacx', 95: 'Look', 123: 'Polar', 255: 'Development', 260: 'Zwift', 263: 'Favero', 265: 'Rouvy', 267: 'JetBlack', 294: 'Magene', 331: 'Xert' };
  const DEVICE_TYPES = { 4: 'Bike light', 11: 'Power meter', 12: 'Bike speed/cadence', 17: 'Smart trainer', 120: 'Heart rate strap', 121: 'Speed sensor', 122: 'Cadence sensor' };

  function sizeOf(bt) { return { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8 }[bt & 0x1f] || 1; }
  // Reads one value of a field; null when the file marks it "invalid".
  function readValue(dv, off, size, bt, le) {
    const t = bt & 0x1f;
    switch (t) {
      case 0: case 2: case 13: { const v = dv.getUint8(off); return v === 0xff ? null : v; }
      case 10: { const v = dv.getUint8(off); return v === 0 ? null : v; }
      case 1: { const v = dv.getInt8(off); return v === 0x7f ? null : v; }
      case 3: { const v = dv.getInt16(off, le); return v === 0x7fff ? null : v; }
      case 4: { const v = dv.getUint16(off, le); return v === 0xffff ? null : v; }
      case 11: { const v = dv.getUint16(off, le); return v === 0 ? null : v; }
      case 5: { const v = dv.getInt32(off, le); return v === 0x7fffffff ? null : v; }
      case 6: { const v = dv.getUint32(off, le); return v === 0xffffffff ? null : v; }
      case 12: { const v = dv.getUint32(off, le); return v === 0 ? null : v; }
      case 8: { const v = dv.getFloat32(off, le); return Number.isFinite(v) ? v : null; }
      case 9: { const v = dv.getFloat64(off, le); return Number.isFinite(v) ? v : null; }
      case 7: { let s = ''; for (let i = 0; i < size; i++) { const c = dv.getUint8(off + i); if (!c) break; s += String.fromCharCode(c); } return s || null; }
      default: return null;
    }
  }

  function parse(buffer) {
    const dv = new DataView(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
    if (dv.byteLength < 14) throw new Error('This is not a FIT file (too short).');
    const hsize = dv.getUint8(0);
    const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
    if ((hsize !== 12 && hsize !== 14) || sig !== '.FIT') throw new Error('This is not a FIT file (the header is wrong).');
    const end = Math.min(hsize + dv.getUint32(4, true), dv.byteLength);
    const defs = {}, recs = [], devices = [], out = { session: {}, file: {} };
    let off = hsize, lastTs = 0;
    while (off < end) {
      const h = dv.getUint8(off++);
      let local, compressed = false;
      if (h & 0x80) { local = (h >> 5) & 3; compressed = true; }
      else if (h & 0x40) {   // a definition: how the next messages of this local type are laid out
        local = h & 0x0f; const dev = !!(h & 0x20);
        const le = dv.getUint8(off + 1) === 0, global = dv.getUint16(off + 2, le), n = dv.getUint8(off + 4);
        off += 5; const fields = [];
        for (let i = 0; i < n; i++) { fields.push({ num: dv.getUint8(off), size: dv.getUint8(off + 1), bt: dv.getUint8(off + 2) }); off += 3; }
        let devSize = 0;
        if (dev) { const nd = dv.getUint8(off++); for (let i = 0; i < nd; i++) { devSize += dv.getUint8(off + 1); off += 3; } }
        defs[local] = { le, global, fields, devSize };
        continue;
      } else local = h & 0x0f;
      const d = defs[local];
      if (!d) throw new Error('This FIT file is damaged (a message without a definition).');
      const m = {};
      for (const f of d.fields) {
        if (off + f.size > dv.byteLength) throw new Error('This FIT file is cut short.');
        m[f.num] = f.size >= sizeOf(f.bt) || (f.bt & 0x1f) === 7 ? readValue(dv, off, f.size, f.bt, d.le) : null;
        off += f.size;
      }
      off += d.devSize;
      if (compressed) { const ts = (lastTs & ~0x1f) + (h & 0x1f); m[253] = ts < lastTs ? ts + 32 : ts; }
      if (m[253] != null) lastTs = m[253];
      if (d.global === 20) recs.push(m);
      else if (d.global === 23) devices.push(m);
      else if (d.global === 18) out.session = m;
      else if (d.global === 0) out.file = m;
    }
    // Records to samples: one entry per recorded second, seconds counted from the first record.
    const t0 = recs.length ? recs[0][253] : 0;
    const s = { t: [], p: [], hr: [], cad: [], spd: [], dist: [], alt: [] };
    for (const m of recs) {
      if (m[253] == null) continue;
      s.t.push(m[253] - t0); s.p.push(m[7] == null ? null : m[7]); s.hr.push(m[3] == null ? null : m[3]); s.cad.push(m[4] == null ? null : m[4]);
      const sp = m[73] != null ? m[73] / 1000 : m[6] != null ? m[6] / 1000 : null; s.spd.push(sp);
      s.dist.push(m[5] == null ? null : m[5] / 100);
      const al = m[78] != null ? m[78] / 5 - 500 : m[2] != null ? m[2] / 5 - 500 : null; s.alt.push(al);
    }
    const dev = devices.map(m => ({ type: DEVICE_TYPES[m[1]] || (m[1] != null ? 'Device ' + m[1] : ''), manufacturer: MANUFACTURERS[m[2]] || (m[2] != null ? 'Maker ' + m[2] : ''), product: m[4] != null ? m[4] : null, name: m[27] || '' }))
      .filter((x, i, a) => (x.type || x.manufacturer || x.name) && a.findIndex(y => y.type === x.type && y.manufacturer === x.manufacturer && y.name === x.name && y.product === x.product) === i);
    const ss = out.session;
    return { start: recs.length ? (t0 + EPOCH) * 1000 : null, samples: s, devices: dev,
      file: { maker: MANUFACTURERS[out.file[1]] || (out.file[1] != null ? 'Maker ' + out.file[1] : ''), product: out.file[2] != null ? out.file[2] : null },
      session: { sport: ss[5] != null ? ss[5] : null, subSport: ss[6] != null ? ss[6] : null, timerSec: ss[7] != null ? ss[7] / 1000 : null, avgPower: ss[20] != null ? ss[20] : null, maxPower: ss[21] != null ? ss[21] : null, np: ss[34] != null ? ss[34] : null, avgHr: ss[16] != null ? ss[16] : null, maxHr: ss[17] != null ? ss[17] : null } };
  }
  const api = { parse, MANUFACTURERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FitParse = api;
})(typeof self !== 'undefined' ? self : this);

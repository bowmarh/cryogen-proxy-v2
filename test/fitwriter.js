'use strict';
// A tiny FIT file writer for the tests: record messages (time, power, heart rate, cadence, speed, distance, altitude), a device list and a session.
const EPOCH = 631065600;
function build({ start = 1793400000, rows, devices = [], sport = 2 }) {
  const parts = [];
  const def = (local, global, fields) => { const b = Buffer.alloc(6 + fields.length * 3); b[0] = 0x40 | local; b[2] = 0; b.writeUInt16LE(global, 3); b[5] = fields.length; fields.forEach((f, i) => { b[6 + i * 3] = f[0]; b[7 + i * 3] = f[1]; b[8 + i * 3] = f[2]; }); parts.push(b); };
  const data = (local, fields, vals) => { const size = fields.reduce((n, f) => n + f[1], 0), b = Buffer.alloc(1 + size); b[0] = local; let o = 1; fields.forEach((f, i) => { const v = vals[i], bt = f[2] & 0x1f; if (bt === 7) { b.write(String(v || ''), o, f[1], 'latin1'); } else if (f[1] === 1) b[o] = v == null ? 0xff : v; else if (f[1] === 2) b.writeUInt16LE(v == null ? 0xffff : v, o); else b.writeUInt32LE(v == null ? 0xffffffff : v >>> 0, o); o += f[1]; }); parts.push(b); };
  const REC = [[253, 4, 0x86], [3, 1, 0x02], [7, 2, 0x84], [4, 1, 0x02], [73, 4, 0x86], [5, 4, 0x86], [78, 4, 0x86]];
  def(0, 20, REC);
  rows.forEach((r, i) => data(0, REC, [start - EPOCH + i, r.hr, r.p, r.cad, r.spd == null ? null : Math.round(r.spd * 1000), r.dist == null ? null : Math.round(r.dist * 100), r.alt == null ? null : Math.round((r.alt + 500) * 5)]));
  const DEV = [[1, 1, 0x02], [2, 2, 0x84], [4, 2, 0x84], [27, 16, 0x07]];
  if (devices.length) { def(1, 23, DEV); for (const d of devices) data(1, DEV, [d.type, d.maker, d.product, d.name]); }
  def(2, 18, [[5, 1, 0x00], [20, 2, 0x84]]); data(2, [[5, 1, 0x00], [20, 2, 0x84]], [sport, 200]);
  const body = Buffer.concat(parts), head = Buffer.alloc(14);
  head[0] = 14; head[1] = 0x20; head.writeUInt16LE(2000, 2); head.writeUInt32LE(body.length, 4); head.write('.FIT', 8, 'latin1');
  return Buffer.concat([head, body, Buffer.alloc(2)]);
}
// A repeatable "random" number so the rides are the same every run.
const rng = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
module.exports = { build, rng };

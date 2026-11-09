'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PairFit = require('../public/js/pairfit.js');

// Deterministic noise so the tests do not flake.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

// A 40 minute ride: steady blocks with surges.
function baseRide(n = 2400) {
  const r = rng(7), out = [];
  let p = 220;
  for (let i = 0; i < n; i++) { if (i % 45 === 0) p = 150 + Math.floor(r() * 220); out.push(Math.max(0, p + Math.sin(i / 7) * 25)); }
  return out;
}

async function encode(sdk, { maker, product, serial, powerSerial, antNumber, watts, offsetSec = 0 }) {
  const { Encoder, Profile } = sdk, enc = new Encoder(), t0 = new Date(Date.UTC(2026, 5, 1, 18, 0, 0));
  enc.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: maker, product, serialNumber: serial, timeCreated: t0 });
  enc.onMesg(Profile.MesgNum.DEVICE_INFO, { deviceIndex: 0, manufacturer: maker, product, serialNumber: serial, softwareVersion: 12.34, timestamp: t0 });
  if (powerSerial != null) enc.onMesg(Profile.MesgNum.DEVICE_INFO, { deviceIndex: 1, deviceType: 11, sourceType: 'antplus', manufacturer: 'stagesCycling', serialNumber: powerSerial, antDeviceNumber: antNumber, softwareVersion: 2.1, timestamp: t0 });
  watts.forEach((w, i) => enc.onMesg(Profile.MesgNum.RECORD, { timestamp: new Date(t0.getTime() + (i + offsetSec) * 1000), power: Math.round(w) }));
  return enc.close();
}
async function analyse(sdk, zwiftSpec, secondSpec) {
  const { Decoder, Stream } = sdk, read = u8 => { const d = new Decoder(Stream.fromByteArray(Array.from(u8))); assert.ok(d.isFIT()); const { messages, errors } = d.read(); assert.deepStrictEqual(errors, []); return PairFit.extract(messages); };
  return PairFit.compare(read(await encode(sdk, zwiftSpec)), read(await encode(sdk, secondSpec)));
}
const codes = r => r.indicators.map(i => i.code);
const zwift = w => ({ maker: 'zwift', product: 1, serial: 1000001, powerSerial: 55501, antNumber: 4001, watts: w });

test('independent noisy recordings of one ride: no indicators', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide(), r1 = rng(11), r2 = rng(22);
  const a = ride.map(w => w * (1 + 0.03 * gauss(r1))), b = ride.map(w => w * (1 + 0.03 * gauss(r2)));
  const res = await analyse(sdk, zwift(a), { maker: 'garmin', product: 3121, serial: 3400001234, powerSerial: 77702, antNumber: 5002, watts: b, offsetSec: 4 });
  console.log('  (a)', JSON.stringify(res.stats), codes(res));
  assert.deepStrictEqual(codes(res), ['none']);
  assert.strictEqual(Math.abs(res.stats.lagSeconds), 4);
});

test('identical stream under a different file_id: same meter likely', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide();
  const res = await analyse(sdk, zwift(ride), { maker: 'garmin', product: 3121, serial: 3400001234, powerSerial: 77702, antNumber: 5002, watts: ride });
  console.log('  (b)', JSON.stringify(res.stats), codes(res));
  assert.ok(codes(res).includes('same_meter'));
  assert.ok(!codes(res).includes('constant_offset'));
});

test('same power-sensor serial in both files: same meter likely, even with noise', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide(), r2 = rng(5);
  const res = await analyse(sdk, zwift(ride), { maker: 'garmin', product: 3121, serial: 3400001234, powerSerial: 55501, antNumber: 4001, watts: ride.map(w => w * (1 + 0.03 * gauss(r2))) });
  assert.ok(codes(res).includes('same_meter'));
});

test('scaled copy at +9%: constant percentage offset', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide();
  const res = await analyse(sdk, zwift(ride), { maker: 'garmin', product: 3121, serial: 3400001234, powerSerial: 77702, antNumber: 5002, watts: ride.map(w => w * 1.09) });
  console.log('  (c)', JSON.stringify(res.stats), codes(res));
  assert.ok(codes(res).includes('constant_offset'));
  assert.ok(!codes(res).includes('same_meter'));
});

test('second file with no serial, or the same creator as Zwift: identity indicator', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide(), r2 = rng(9), noisy = ride.map(w => w * (1 + 0.03 * gauss(r2)));
  const noSerial = await analyse(sdk, zwift(ride), { maker: 'garmin', product: 3121, serial: undefined, powerSerial: 77702, antNumber: 5002, watts: noisy });
  assert.ok(codes(noSerial).includes('creator_identity'));
  const sameMaker = await analyse(sdk, zwift(ride), { maker: 'zwift', product: 1, serial: 1000001, powerSerial: 77702, antNumber: 5002, watts: noisy });
  assert.ok(codes(sameMaker).includes('creator_identity'));
});

test('too little overlap: says so instead of guessing', () => {
  const tiny = { fileId: {}, creator: {}, devices: [], power: { t: [0, 1, 2], w: [200, 200, 200] } };
  const res = PairFit.compare(tiny, tiny);
  assert.strictEqual(res.stats.aligned, false);
});

test('raw identity is shown side by side without translation', async () => {
  const sdk = await import('@garmin/fitsdk'), ride = baseRide();
  const res = await analyse(sdk, zwift(ride), { maker: 'garmin', product: 3121, serial: 3400001234, powerSerial: 77702, antNumber: 5002, watts: ride });
  assert.strictEqual(res.identity.second.fileId.serial, 3400001234);
  assert.strictEqual(res.identity.zwift.powerSensors[0].serial, 55501);
});

test('member Fair play page is static, names no third-party tool, and the staff flags page still exists', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
  const page = html.slice(html.indexOf('id="page-standard"'), html.indexOf('id="page-standard"') + 2500);
  assert.match(page, /second recording running as a backup/);
  assert.match(page, /Discord DM/);
  assert.match(page, /support\.zwift\.com\/en_us\/dual-power-recording-on-zwiftpower-B1fOnbCVyl/);
  assert.doesNotMatch(page.replace(/href="[^"]*"/g, ''), /zwiftpower|<script|fetch\(/i, 'the words on the page never name ZwiftPower or run code; only the link address (Zwift\'s own article) may');
  assert.match(html, /id="page-fair"/);
});

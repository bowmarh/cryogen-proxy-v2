'use strict';
// Web push for riders who have no Discord link: a notification on their phone or computer, even with the dashboard closed. Written against RFC 8030
// (the push request), RFC 8188/8291 (aes128gcm encryption of the message) and RFC 8292 (VAPID, the server's signed identity), using only Node's crypto.
// Needs a VAPID key pair in VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (base64url) and VAPID_SUBJECT (a mailto: address); without them push is simply off.
const crypto = require('crypto');

module.exports = function createWebPush({ redis, HttpError, requireRole, memberFromRequest, siteUrl = '', fetchImpl = (...a) => fetch(...a) }) {
  const KEY = 'cg:push:subs';   // zwid -> JSON [{ endpoint, p256dh, auth, at }] (at most five devices each)
  const b64 = b => Buffer.from(b).toString('base64url');
  const unb64 = s => Buffer.from(String(s || ''), 'base64url');
  const pub = () => process.env.VAPID_PUBLIC_KEY || '', priv = () => process.env.VAPID_PRIVATE_KEY || '';
  const configured = () => unb64(pub()).length === 65 && unb64(priv()).length === 32;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  // Only the browsers' own push services are ever contacted: a rider cannot make the server call an address of their choosing. PUSH_EXTRA_HOSTS adds more (a comma list).
  const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.microsoft\.com$/];
  const pushHostOk = endpoint => { try { const h = new URL(endpoint).hostname.toLowerCase(); return PUSH_HOSTS.some(re => re.test(h)) || String(process.env.PUSH_EXTRA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(h); } catch (e) { return false; } };

  // A fresh key pair for the club, shown once to an administrator to put in Vercel.
  function generateKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }), x = unb64(jwk.x), y = unb64(jwk.y);
    return { publicKey: b64(Buffer.concat([Buffer.from([4]), x, y])), privateKey: jwk.d };
  }
  const vapidJwt = audience => {
    const p = unb64(pub()), jwk = { kty: 'EC', crv: 'P-256', x: b64(p.subarray(1, 33)), y: b64(p.subarray(33, 65)), d: priv() };
    const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), claims = b64(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || `mailto:admin@${new URL(siteUrl || 'https://club.cryo-gen.team').host}` }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    return `${head}.${claims}.${b64(sig)}`;
  };

  // RFC 8291: the message is encrypted to the browser's public key (p256dh) with its own secret (auth).
  function encrypt(payload, p256dh, auth) {
    const ua = unb64(p256dh), authSecret = unb64(auth);
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua), salt = crypto.randomBytes(16);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
  }

  const subsOf = async zwid => { const [raw] = await redis([['HGET', KEY, String(zwid)]]); const l = parse(raw); return Array.isArray(l) ? l : []; };
  const has = async zwid => configured() && (await subsOf(zwid)).length > 0;

  // Sends to every device a rider has registered; a device the push service says is gone (404 or 410) is forgotten. Returns how many received it.
  async function send(zwid, { title, body, url }) {
    if (!configured()) return 0;
    const subs = await subsOf(zwid), keep = [];
    let sent = 0;
    for (const s of subs) {
      if (!pushHostOk(s.endpoint)) continue;   // never contact an address that is not a push service, even if one was stored
      try {
        const res = await fetchImpl(s.endpoint, { method: 'POST', body: encrypt(JSON.stringify({ title: String(title).slice(0, 80), body: String(body).slice(0, 300), url: url || siteUrl || '/' }), s.p256dh, s.auth),
          headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal', Authorization: `vapid t=${vapidJwt(new URL(s.endpoint).origin)}, k=${pub()}` }, signal: AbortSignal.timeout(5000) });
        if (res.status === 404 || res.status === 410) continue;   // the device unsubscribed
        keep.push(s); if (res.ok) sent++;
      } catch (e) { keep.push(s); }
    }
    if (keep.length !== subs.length) await redis([keep.length ? ['HSET', KEY, String(zwid), JSON.stringify(keep)] : ['HDEL', KEY, String(zwid)]]);
    return sent;
  }

  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const routes = {
    // Anyone signed in: is push set up, and the public key the browser needs.
    'GET /api/push/status': async req => { const m = need(req); return { configured: configured(), publicKey: configured() ? pub() : '', devices: (await subsOf(m.zwid)).length }; },
    'POST /api/push/subscribe': async (req, body) => {
      const m = need(req);
      if (!configured()) throw new HttpError(409, 'Notifications are not switched on for the club yet.');
      const endpoint = String(body.endpoint || ''), p256dh = String((body.keys || {}).p256dh || ''), auth = String((body.keys || {}).auth || '');
      if (!/^https:\/\/[^\s]{10,500}$/.test(endpoint) || !pushHostOk(endpoint) || unb64(p256dh).length !== 65 || unb64(auth).length < 8) throw new HttpError(400, 'That is not a valid push subscription.');
      const subs = (await subsOf(m.zwid)).filter(s => s.endpoint !== endpoint);
      subs.unshift({ endpoint, p256dh, auth, at: new Date().toISOString() });
      await redis([['HSET', KEY, m.zwid, JSON.stringify(subs.slice(0, 5))]]);
      return { devices: Math.min(5, subs.length) };
    },
    'POST /api/push/unsubscribe': async (req, body) => {
      const m = need(req), endpoint = String(body.endpoint || ''), subs = (await subsOf(m.zwid)).filter(s => endpoint ? s.endpoint !== endpoint : false);
      await redis([subs.length ? ['HSET', KEY, m.zwid, JSON.stringify(subs)] : ['HDEL', KEY, m.zwid]]);
      return { devices: subs.length };
    },
    // Administrator: a new key pair to copy into Vercel (it is not stored here; changing keys later signs every device out of push).
    'POST /api/push/generate-keys': async req => { requireRole(req, ['admin']); return generateKeys(); },
  };
  return { routes, has, send, encrypt, configured, KEY };
};

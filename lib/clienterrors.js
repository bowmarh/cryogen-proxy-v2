'use strict';
// Browser errors: a tiny reporter in the page (js/errors.js) sends what broke (the message, the script and line, which page, a rough browser name), the
// server counts repeats under one signature and tells the admin channel the first time a new one appears each day. Nothing identifies the rider: no name,
// no ID, no address is kept. Staff see the list (Club health) and can clear it.
const crypto = require('crypto');
module.exports = function createClientErrors({ redis, HttpError, requireRole, discord = async () => false, counter = async () => 0, clientIp = () => '' }) {
  const KEY = 'cg:clienterr', ALERTS = 'cg:alerts:clienterr', MAX = 200, PER_MINUTE = 20;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const day = () => new Date().toISOString().slice(0, 10);
  // A rough browser name from the user agent: enough to see "only Safari on iPhone breaks", nothing that identifies a person.
  const browser = ua => { const u = String(ua || ''); const m = /(Edg|Chrome|CriOS|Firefox|FxiOS|Safari)\/(\d+)/.exec(u), v = /Version\/(\d+)/.exec(u); const name = m ? ({ Edg: 'Edge', CriOS: 'Chrome', FxiOS: 'Firefox' }[m[1]] || m[1]) : 'Other'; return `${name}${m ? ' ' + (m[1] === 'Safari' && v ? v[1] : m[2]) : ''}${/Mobi|iPhone|Android/.test(u) ? ' (phone)' : ''}`; };
  const base = f => text(f, 200).replace(/[?#].*$/, '').split('/').pop();

  async function report(req, b) {
    const message = text(b.message, 200); if (!message) throw new HttpError(400, 'Nothing to report.');
    // The limit is per place, but the address itself is never stored.
    if (await counter(`cg:rl:cerr:${crypto.createHash('sha1').update(String(clientIp(req))).digest('hex').slice(0, 16)}`, 60) > PER_MINUTE) throw new HttpError(429, 'Too many reports.');
    const file = base(b.source), line = Math.max(0, Math.min(1e6, Number(b.line) || 0)), page = text(b.page, 40).replace(/[^\w#/-]/g, '');
    // The same error from different riders (different numbers, addresses) is one signature.
    const norm = message.replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#').toLowerCase();
    const sig = crypto.createHash('sha1').update(`${norm}|${file}|${line}`).digest('hex').slice(0, 12), d = day();
    const [raw] = await redis([['HGET', KEY, sig]]), old = parse(raw), ua = browser(req.headers['user-agent']);
    const next = old ? { ...old, count: old.count + 1, last: new Date().toISOString(), browsers: { ...old.browsers, [ua]: (old.browsers[ua] || 0) + 1 }, pages: { ...old.pages, [page]: (old.pages[page] || 0) + 1 } }
      : { sig, message, file, line, count: 1, first: new Date().toISOString(), last: new Date().toISOString(), browsers: { [ua]: 1 }, pages: { [page]: 1 } };
    for (const k of ['browsers', 'pages']) { const e = Object.entries(next[k]).sort((a, c) => c[1] - a[1]).slice(0, 6); next[k] = Object.fromEntries(e); }
    await redis([['HSET', KEY, sig, JSON.stringify(next)]]);
    if (!old || old.last.slice(0, 10) !== d) {
      const [fresh] = await redis([['HSETNX', ALERTS, `${d}:${sig}`, '1']]);
      if (fresh && !old) await discord('admin', { content: `🧯 **New browser error** in the dashboard: \`${message.slice(0, 160).replace(/`/g, "'")}\` (${file || 'unknown file'}${line ? ':' + line : ''}${page ? ', page ' + page : ''}). Details under Club health → What broke.` }).catch(() => {});
    }
    if (!old && Object.keys(next).length) {   // keep the list bounded: when it is full the oldest signatures go
      const [n] = await redis([['HLEN', KEY]]);
      if (n > MAX) { const [all] = await redis([['HGETALL', KEY]]); const drop = pairs(all).map(([k, v]) => [k, parse(v)]).filter(([, v]) => v).sort((a, c) => a[1].last.localeCompare(c[1].last)).slice(0, n - MAX).map(([k]) => k); if (drop.length) await redis([['HDEL', KEY, ...drop]]); }
    }
    return { ok: true };
  }

  return { report, routes: {
    'POST /api/client-error': async (req, body) => report(req, body || {}),
    'GET /api/staff/client-errors': async req => {
      requireRole(req, ['admin', 'mod']);
      const [raw] = await redis([['HGETALL', KEY]]);
      return { errors: pairs(raw).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 50) };
    },
    'POST /api/staff/client-errors/clear': async (req, body) => {
      requireRole(req, ['admin']);
      if (body && body.sig) await redis([['HDEL', KEY, String(body.sig)]]); else await redis([['DEL', KEY]]);
      return { ok: true };
    },
  } };
};

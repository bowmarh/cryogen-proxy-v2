'use strict';
// Rider privacy tools. A rider can download what the app holds about them and ask for it to be erased; an administrator reviews the request and
// erases it. Everything is found by looking through the stores that hold per-rider data for the rider's Zwift ID (and, where a store is keyed by name,
// their name). Records staff keep about fair-play checks, investigations and the case log are NOT part of a rider's download and are NOT erased
// automatically: they are listed to the administrator, who decides.
module.exports = function createPrivacy({ redis, HttpError, requireRole, memberFromRequest, staffNameOf = () => '', discord = async () => false, siteUrl = '' }) {
  const REQUESTS = 'cg:privacy:requests', LOG = 'cg:privacy:log';
  // Stores a rider's own data is read from (and erased from). `secret` fields are never shown; `countOnly` stores report how many entries, not what they hold.
  const OWN = [
    ['cg:rider:velo', 'Your vELO line'], ['cg:fair:snap', 'Daily numbers snapshots (vELO, W/kg and registered weight)'], ['cg:fair:weights', 'Registered weight'],
    ['cg:me:tz', 'Time zone choice'], ['cg:me:avatar', 'Avatar'], ['cg:onboard:seen', 'When you joined the app'], ['cg:onboard:ack', 'First-race checklist ticks'],
    ['cg:comms:discord', 'Linked Discord account and message choices'], ['cg:push:subs', 'Phone notification devices', { countOnly: true }], ['cg:cal:owners', 'Calendar feed', { countOnly: true }],
    ['cg:studio:feature', '"OK to feature me" choice'], ['cg:plan:optin', 'Weekly plan opt-in'], ['cg:cover:optout', 'Ride cover opt-out'], ['cg:coach:consent', 'AI coach consent'],
    ['cg:zrl:signups', 'ZRL sign-up'], ['cg:zrl:weekly', 'ZRL availability answers'], ['cg:ladder:roster', 'Ladder roster place'], ['cg:ladder:avail', 'Ladder availability answers'],
    ['cg:drs:squad', 'DIRT squad place'], ['cg:drs:avail', 'DIRT availability answers'], ['cg:ttt:signups', 'TTT sign-up'], ['cg:ttt:assign', 'TTT team places'], ['cg:signups', 'Event sign-ups'],
    ['cg:locks', 'Event locks'], ['cg:rsvps', 'Social ride RSVPs'], ['cg:assoc:first', 'Associate member record'], ['cg:assoc:full', 'Associate member record'], ['cg:assoc:requests', 'Associate upgrade request'],
    ['cg:live:checkins', 'Race-day "in the pen" taps'], ['cg:support:list', 'Supporter status'], ['cg:cover:standing', 'Ride cover'], ['cg:cover:approved', 'Ride cover'],
  ];
  // Staff-held records: never in a rider's download, never erased automatically, listed to the administrator.
  const STAFF = [['cg:fair:flags', 'Fair play items'], ['cg:inv:cases', 'Investigations'], ['cg:cases:log', 'Case log'], ['cg:assoc:marks', 'Staff marks on associates']];
  const SECRET = /^(code|token|secret|verify|hash|keys?|endpoint|p256dh|auth|expires?)$/i;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return v; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const scrub = v => { if (Array.isArray(v)) return v.map(scrub); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, scrub(x)])); return v; };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

  const isHers = (z, nameLc) => (field, raw) => {
    const f = String(field), fl = f.toLowerCase();
    if (new RegExp(`(^|[:|])${z}($|[:|])`).test(f)) return true;
    if (nameLc && (fl === nameLc || fl.endsWith('|' + nameLc))) return true;
    const v = parse(raw);
    return !!v && typeof v === 'object' && [v.zwid, v.zwift_id, v.riderId, v.zwiftId].some(x => x != null && String(x) === z);
  };

  // What one hash holds about this rider. A key that is not a hash (or does not exist) is skipped.
  async function scan(key, z, nameLc) {
    const [type] = await redis([['TYPE', key]]);
    if (type !== 'hash') return null;
    const [raw] = await redis([['HGETALL', key]]), mine = isHers(z, nameLc);
    return pairs(raw).filter(([f, v]) => mine(f, v)).map(([field, value]) => ({ field, value }));
  }

  async function collect(zwid, name) {
    const z = String(zwid), nameLc = String(name || '').trim().toLowerCase(), stores = [];
    for (const [key, label, opt = {}] of OWN) {
      const entries = await scan(key, z, nameLc).catch(() => null);
      if (!entries || !entries.length) continue;
      stores.push({ key, label, count: entries.length, ...(opt.countOnly ? {} : { entries: entries.map(e => ({ field: e.field, value: scrub(parse(e.value)) })) }) });
    }
    const staffHeld = [];
    for (const [key, label] of STAFF) { const entries = await scan(key, z, '').catch(() => null); if (entries && entries.length) staffHeld.push({ key, label, count: entries.length }); }
    return { stores, staffHeld };
  }

  async function erase(zwid, name, { preview = false } = {}) {
    const z = String(zwid), nameLc = String(name || '').trim().toLowerCase(), removed = [];
    for (const [key, label] of OWN) {
      const entries = await scan(key, z, nameLc).catch(() => null);
      if (!entries || !entries.length) continue;
      if (!preview) await redis([['HDEL', key, ...entries.map(e => e.field)]]);
      removed.push({ key, label, count: entries.length });
    }
    return removed;
  }

  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const routes = {
    'GET /api/me/data': async req => {
      const m = need(req), { stores } = await collect(m.zwid, m.name);
      return { generatedAt: new Date().toISOString(), zwid: String(m.zwid), name: m.name || '', stores, note: 'This is what the app stores about you. Records staff keep for fair play and safeguarding are not included here: ask an administrator if you want to know about those.' };
    },
    'POST /api/me/data/erase-request': async req => {
      const m = need(req), now = new Date().toISOString();
      const [raw] = await redis([['HGET', REQUESTS, String(m.zwid)]]), old = raw ? parse(raw) : null;
      if (old && old.status === 'open') return { ok: true, already: true, at: old.at };
      await redis([['HSET', REQUESTS, String(m.zwid), JSON.stringify({ zwid: String(m.zwid), name: clean(m.name, 80), at: now, status: 'open' })]]);
      await discord('admin', { content: `🔒 **Data request:** a rider has asked for their data to be erased. Open ${siteUrl}/ → Investigations → Privacy requests.` }).catch(() => {});
      return { ok: true, at: now };
    },
    'GET /api/staff/privacy': async req => {
      requireRole(req, ['admin']);
      const [raw, log] = await redis([['HGETALL', REQUESTS], ['LRANGE', LOG, 0, 49]]);
      return { requests: pairs(raw).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at))), log: (log || []).map(parse) };
    },
    // preview: true shows what would go (and what staff hold) without deleting anything.
    'POST /api/staff/privacy/erase': async (req, body) => {
      requireRole(req, ['admin']);
      const z = String(body.zwid || '').trim(); if (!/^\d{1,10}$/.test(z)) throw new HttpError(400, 'Enter the rider\'s Zwift ID (numbers only).');
      const [raw] = await redis([['HGET', REQUESTS, z]]), reqd = raw ? parse(raw) : null, name = clean(body.name || (reqd && reqd.name), 80);
      const preview = body.preview !== false, held = (await collect(z, name)).staffHeld, removed = await erase(z, name, { preview });
      if (!preview) {
        const entry = { at: new Date().toISOString(), by: staffNameOf(req) || 'admin', zwid: z, stores: removed.length, entries: removed.reduce((n, r) => n + r.count, 0) };
        await redis([['LPUSH', LOG, JSON.stringify(entry)], ['LTRIM', LOG, 0, 199], ...(reqd ? [['HSET', REQUESTS, z, JSON.stringify({ ...reqd, status: 'done', doneAt: entry.at, doneBy: entry.by })]] : [])]);
      }
      return { preview, removed, staffHeld: held, note: 'Race results already published, and anything in fair play, investigations or the case log, are not erased here: decide those separately.' };
    },
  };
  return { routes, collect, erase, OWN, STAFF };
};

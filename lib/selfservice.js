'use strict';
// "My details" for members. What the app itself owns a member can change straight away (how we email them, the first name we use). Anything held in the
// club's WordPress records (their name, email, tier) goes through a request that staff see, because the club's member plugin only lets us change a few
// fields (tier, status, the off-boarding ticks) and a person should check the rest. "I want to leave" is the one request staff can apply in a click.
module.exports = function createSelfService({ redis, HttpError, requireRole, memberFromRequest, mail, access, discord = async () => false, setMemberStatus = null, siteUrl = '' }) {
  const K = { names: 'cg:me:names', requests: 'cg:me:requests' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const all = async () => { const [raw] = await redis([['HGETALL', K.requests]]), out = []; for (let i = 0; i < (raw || []).length; i += 2) { const r = parse(raw[i + 1]); if (r) out.push(r); } return out.sort((a, b) => b.at.localeCompare(a.at)); };
  async function details(req) {
    const m = need(req), [prefName] = await redis([['HGET', K.names, String(m.zwid)]]), [prefs, level, mine] = await Promise.all([mail.prefsOf(m.zwid).catch(() => ({ known: false })), access.me(req).catch(() => ({})), all()]);
    return { zwid: String(m.zwid), name: m.name, preferredName: prefName || '', level: level.level || '', email: prefs, requests: mine.filter(r => String(r.zwid) === String(m.zwid)).slice(0, 10) };
  }
  const routes = {
    'GET /api/me/details': async req => details(req),
    'POST /api/me/prefs': async (req, body) => {
      const m = need(req);
      if (body.emails !== undefined) await mail.setPrefs(m.zwid, String(body.emails));
      if (body.preferredName !== undefined) { const n = clean(body.preferredName, 40); if (n) await redis([['HSET', K.names, String(m.zwid), n]]); else await redis([['HDEL', K.names, String(m.zwid)]]); }
      return details(req);
    },
    'POST /api/me/request': async (req, body) => {
      const m = need(req), type = ['details', 'leave', 'other'].includes(body.type) ? body.type : 'other', text = clean(body.text, 500);
      if (type !== 'leave' && text.length < 5) throw new HttpError(400, 'Please say what you would like changed.');
      const key = `cg:me:rate:${m.zwid}:${new Date().toISOString().slice(0, 10)}`, [n] = await redis([['INCR', key]]); await redis([['EXPIRE', key, 172800]]); if (n > 5) throw new HttpError(429, 'That is plenty for today: thank you.');
      if ((await all()).some(r => String(r.zwid) === String(m.zwid) && r.type === type && r.status === 'open')) throw new HttpError(409, 'You already have one of these waiting: a volunteer will deal with it.');
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5), rec = { id, at: new Date().toISOString(), zwid: String(m.zwid), name: m.name, type, text, status: 'open' };
      await redis([['HSET', K.requests, id, JSON.stringify(rec)]]);
      await discord('admin', { content: `📝 **Member request** from ${m.name}: ${type === 'leave' ? 'wants to leave the club' : type === 'details' ? 'a change to their details' : 'a question'}. Open ${siteUrl}/ → Control room → Member requests.` }).catch(() => {});
      return { ok: true, request: rec };
    },
    'GET /api/requests': async req => { requireRole(req, ['admin', 'mod']); return { requests: (await all()).slice(0, 100) }; },
    'POST /api/requests/decide': async (req, body) => {
      requireRole(req, ['admin']); const id = String(body.id || ''), [raw] = await redis([['HGET', K.requests, id]]), r = parse(raw); if (!r) throw new HttpError(404, 'That request is not there.');
      if (r.status !== 'open') throw new HttpError(409, 'That request has already been dealt with.');
      if (body.action === 'apply-leave') { if (r.type !== 'leave') throw new HttpError(400, 'Only a request to leave can be applied here.'); if (!setMemberStatus) throw new HttpError(409, 'WordPress is not connected.'); await setMemberStatus(r.zwid, 'left'); r.status = 'applied'; }
      else if (body.action === 'done') r.status = 'done'; else if (body.action === 'decline') r.status = 'declined'; else throw new HttpError(400, 'Choose done, decline or apply.');
      r.note = clean(body.note, 200); r.decidedAt = new Date().toISOString(); await redis([['HSET', K.requests, id, JSON.stringify(r)]]); return { request: r };
    },
  };
  return { routes, details };
};

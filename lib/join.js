'use strict';
// The join funnel: a public form puts a request in a queue (no account is made by it), staff see the queue, and an administrator either sends the welcome
// email and marks the request done, or declines. Adding the person to WordPress stays a staff step on purpose: that is where the club's member data lives.
// Spam: a hidden field bots fill in, a few requests an hour per address (a one-way hash of the IP), and a size limit on every field.
module.exports = function createJoin({ redis, HttpError, requireRole, discord = async () => false, mail = null, hashIp = s => s, refCode = null, verifyRef = null, nameOf = async z => z, memberFromRequest = () => null, lookup = async () => null, teamsWithSpace = async () => [], nextEvents = async () => [], ai = null, siteUrl = '' }) {
  const K = { list: 'cg:join', rate: 'cg:join:rate:' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const isEmail = e => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(e) && e.length <= 160;
  async function submit(body, ip) {
    if (clean(body.website, 50)) return { ok: true };   // the hidden field: a bot filled it in; answer as if it worked
    const name = clean(body.name, 80), email = clean(body.email, 160).toLowerCase(), zwid = clean(body.zwid, 12).replace(/\D/g, ''), note = clean(body.note, 400);
    if (name.length < 2) throw new HttpError(400, 'Please tell us your name.');
    if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (body.consent !== true) throw new HttpError(400, 'Please tick the box so we may email you about joining.');
    const key = K.rate + hashIp(ip) + ':' + new Date().toISOString().slice(0, 13), [n] = await redis([['INCR', key]]); await redis([['EXPIRE', key, 7200]]);
    if (n > 3) throw new HttpError(429, 'Too many requests from this connection. Please try again later.');
    const [dups] = await redis([['HGETALL', K.list]]);
    for (let i = 0; i < (dups || []).length; i += 2) { const r = parse(dups[i + 1]); if (r && r.email === email && r.status === 'open') return { ok: true }; }
    const ref = body.ref && verifyRef ? verifyRef(clean(body.ref, 40)) : null, id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), rec = { id, at: new Date().toISOString(), name, email, zwid, note, ref: ref || '', status: 'open' };
    await redis([['HSET', K.list, id, JSON.stringify(rec)]]);
    await discord('admin', { content: `🙋 **New join request:** ${name}${zwid ? ` (Zwift ID ${zwid})` : ''}. Open ${siteUrl}/ → Control room → Join requests.` }).catch(() => {});
    return { ok: true };
  }
  async function raw() { const [r] = await redis([['HGETALL', K.list]]), out = []; for (let i = 0; i < (r || []).length; i += 2) { const x = parse(r[i + 1]); if (x) out.push(x); } return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100); }
  // A first look at an open request that gave a Zwift ID: what the racing data says (category, rating) and which ZRL teams have places. Numbers only go to the AI.
  async function firstLook(r) {
    const info = r.zwid ? await lookup(r.zwid).catch(() => null) : null; if (!info) return null;
    const spaces = await teamsWithSpace().catch(() => []), out = { category: info.category || null, vELO: info.vELO || null, teams: spaces.slice(0, 4), note: '' };
    try { if (ai && info.vELO && await ai.available(true)) out.note = ai.clip(await ai.complete({ kind: 'join-look', cap: 100, maxTokens: 150, system: 'You help volunteers at a friendly Zwift cycling club. In one plain sentence (max 30 words) suggest how to welcome a new rider from these numbers. Do not invent facts.', user: JSON.stringify({ category: info.category, vELO: info.vELO, teamsWithPlaces: out.teams.map(t => t.grade || t.name) }) }), 240); } catch (e) { /* numbers stand */ }
    return out;
  }
  async function list() { const rows = await raw(); return Promise.all(rows.map(async r => { const x = r.ref ? { ...r, referrer: await nameOf(r.ref) } : r; return r.status === 'open' ? { ...x, look: await firstLook(r) } : x; })); }
  // Who has brought the most people (requests that came through their link, and how many of those were welcomed).
  async function referrers() { const rows = (await raw()).filter(r => r.ref), by = new Map(); for (const r of rows) { const e = by.get(r.ref) || { zwid: r.ref, count: 0, welcomed: 0 }; e.count++; if (r.status === 'welcomed') e.welcomed++; by.set(r.ref, e); } return Promise.all([...by.values()].sort((a, b) => b.welcomed - a.welcomed || b.count - a.count).slice(0, 10).map(async e => ({ ...e, name: await nameOf(e.zwid) }))); }
  const WELCOME = async (name, r = {}) => {
    const ev = await nextEvents().catch(() => []), rides = ev.slice(0, 3).map(e => `- ${e.date || ''} ${e.series}: ${e.title}`).join('\n');
    return { subject: 'Welcome to Team CRYO-GEN', body: `Hi {first},\n\nThanks for asking to join Team CRYO-GEN, a friendly Zwift cycling club. We are glad you found us.\n\nA club volunteer will add you to the member area shortly. Once that is done, sign in at [the club app](${siteUrl}) and tick off the first-race checklist.${r.wpUserId ? ' Your cryogen.team account is ready: choose "Lost your password?" on the cryogen.team login page with this email address to set your password.' : ''}${rides ? `\n\nA few things coming up that you are very welcome to join:\n\n${rides}` : ''}\n\nIf you have questions, just reply to this email.\n\nTeam CRYO-GEN` };
  };
  async function decide(req, body) {
    requireRole(req, ['admin']); const id = String(body.id || ''), [raw] = await redis([['HGET', K.list, id]]), r = parse(raw); if (!r) throw new HttpError(404, 'That request is not there.');
    if (r.status !== 'open') throw new HttpError(409, 'That request has already been dealt with.');
    if (body.action === 'welcome') { if (!mail) throw new HttpError(409, 'Email is not available.'); const w = await WELCOME(r.name, r); await mail.sendDirect({ to: r.email, name: r.name, subject: w.subject, body: w.body }); r.status = 'welcomed'; }
    else if (body.action === 'decline') r.status = 'declined'; else throw new HttpError(400, 'Choose welcome or decline.');
    r.decidedAt = new Date().toISOString(); await redis([['HSET', K.list, id, JSON.stringify(r)]]); return { request: r };
  }
  async function update(id, patch) { const [r] = await redis([['HGET', K.list, id]]), x = parse(r); if (!x) throw new HttpError(404, 'That request is not there.'); await redis([['HSET', K.list, id, JSON.stringify({ ...x, ...patch })]]); return { ...x, ...patch }; }
  const routes = {
    'GET /api/join': async req => { requireRole(req, ['admin', 'mod']); return { requests: await list() }; },
    'POST /api/join/decide': async (req, body) => decide(req, body),
    'GET /api/join/referrers': async req => { requireRole(req, ['admin', 'mod']); return { referrers: await referrers() }; },
    // A rider's own invitation link and how many people have asked to join through it.
    'GET /api/me/referral': async req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); if (!refCode) throw new HttpError(409, 'Invitations are not available.'); const all = (await raw()).filter(r => String(r.ref) === String(m.zwid)); return { link: `${siteUrl}/join.html?ref=${encodeURIComponent(refCode(m.zwid))}`, requests: all.length, welcomed: all.filter(r => r.status === 'welcomed').length }; },
  };
  return { routes, submit, list, referrers, update };
};

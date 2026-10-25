'use strict';
// Associate members: someone who signs in with their cryogen.team account but is not (yet) a full member of the club. They get a limited view
// (weekly TTT and ZRL sign-up, other race sign-ups and the social rides) and a clear route to full membership: a checklist of what the club looks
// for, a "request full membership" button, and one-click approval for staff. The aim is to turn visitors into active, committed members.
// Who counts as an associate is decided at sign-in (see `classify`); what an associate may call is enforced in api/server.js (`ASSOCIATE_ALLOWED`).
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createAssoc({ redis, HttpError, text, requireRole, memberFromRequest, discord, discordEscape, siteUrl, activityOf, inClub, setWpTier, discordLinked = async () => false }) {
  const KEYS = {
    first: 'cg:assoc:first',       // zwid -> {at, name}: when we first saw them sign in as an associate
    marks: 'cg:assoc:marks',       // zwid -> {at, by}: staff made them an associate
    full: 'cg:assoc:full',         // zwid -> {at, by}: staff approved them as a full member (wins over everything else)
    requests: 'cg:assoc:requests', // zwid -> {zwid, name, at, status: pending|approved|declined, decidedAt, by, note}
    checks: 'cg:assoc:checks',     // zwid -> {discord: true}: the things only the rider can say
    sent: 'cg:assoc:sent',         // notice keys -> ISO time
  };
  // What the club looks for before it says yes. Staff can still approve anyone at any time.
  const RULES = { rsvps: 3, days: 14, teamEvents: 1 };
  const DAY_MS = 86400000;
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const obj = raw => Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v)]).filter(([, v]) => v));

  // Decided when someone signs in, in this order: a staff approval always wins; a staff mark makes an associate; a member record decides (tier
  // "associate" or a pending membership make an associate, any other tier is a member, so setting the tier in WordPress works too); with no
  // record, someone we have already seen as an associate stays one until staff approve them (joining the club's roster alone does not skip the
  // review), and otherwise being in the club's roster means a member and not being in it means an associate.
  async function classify({ zwid, record, rider }) {
    const [full, mark, first] = await redis([['HGET', KEYS.full, zwid], ['HGET', KEYS.marks, zwid], ['HGET', KEYS.first, zwid]]);
    if (full) return false;
    if (mark) return true;
    if (record) return ['associate', 'half'].includes(String(record.tier || '').toLowerCase()) || record.status === 'pending';   // half and associate are one membership
    return !!first || !rider;
  }
  // An associate session stays limited until staff approve them, even mid-session.
  async function stillAssociate(zwid) { return !(await redis([['HGET', KEYS.full, zwid]]))[0]; }
  const noteFirstSeen = (zwid, name) => redis([['HSETNX', KEYS.first, zwid, JSON.stringify({ at: new Date().toISOString(), name })]]);

  // The checklist for one associate. `self` items are things only they can say.
  async function progress(zwid, name, now = Date.now()) {
    const [firstRaw, checkRaw, reqRaw] = await redis([['HGET', KEYS.first, zwid], ['HGET', KEYS.checks, zwid], ['HGET', KEYS.requests, zwid]]);
    const first = parse(firstRaw), checks = parse(checkRaw) || {}, request = parse(reqRaw);
    const act = await activityOf(zwid, name);
    const days = first ? Math.floor((now - Date.parse(first.at)) / DAY_MS) : 0;
    const club = await inClub(zwid), linked = await discordLinked(zwid);   // a Discord account verified by the bot also counts as having joined
    const items = [
      { id: 'club', label: 'Join the CRYO-GEN club on Zwift', done: club, detail: club ? 'You are in the club.' : 'Join our club in the Zwift Companion app so you appear on the roster.' },
      { id: 'discord', label: 'Join our Discord', done: !!checks.discord || linked, self: true, detail: checks.discord || linked ? 'Done.' : 'Tick this once you have joined. It is where rides and races are organised.' },
      { id: 'rides', label: `Join ${RULES.rsvps} social rides`, done: act.rsvps >= RULES.rsvps, detail: `${Math.min(act.rsvps, RULES.rsvps)} of ${RULES.rsvps}. RSVP on the Social Rides page.` },
      { id: 'team', label: 'Take part in a team event', done: act.teamEvents >= RULES.teamEvents, detail: act.teamEvents >= RULES.teamEvents ? 'You have signed up for a team event.' : 'Sign up for the weekly TTT or a ZRL round.' },
      { id: 'time', label: `Be with us for ${RULES.days} days`, done: days >= RULES.days, detail: `${Math.min(days, RULES.days)} of ${RULES.days} days.` },
    ];
    return { items, complete: items.every(i => i.done), done: items.filter(i => i.done).length, total: items.length, days, rsvps: act.rsvps, teamEvents: act.teamEvents, club, discord: !!checks.discord || linked, request, since: first && first.at };
  }

  const routes = {
    // An associate's own checklist and request status (members with full access get a plain "not an associate").
    'GET /api/assoc/status': async req => {
      const m = memberFromRequest(req);
      if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      if (!m.assoc || !(await stillAssociate(m.zwid))) return { associate: false };
      await noteFirstSeen(m.zwid, m.name);
      return { associate: true, name: m.name, ...(await progress(m.zwid, m.name)) };
    },

    'POST /api/assoc/discord': async (req, body) => {
      const m = memberFromRequest(req);
      if (!m || !m.assoc) throw new HttpError(403, 'This is for associate members.');
      await redis([['HSET', KEYS.checks, m.zwid, JSON.stringify({ discord: body.joined !== false })]]);
      return routes['GET /api/assoc/status'](req);
    },

    'POST /api/assoc/request': async (req) => {
      const m = memberFromRequest(req);
      if (!m || !m.assoc || !(await stillAssociate(m.zwid))) throw new HttpError(403, 'This is for associate members.');
      const p = await progress(m.zwid, m.name);
      if (p.request && p.request.status === 'pending') throw new HttpError(409, 'Your request is already with the club. We will be in touch.');
      if (!p.complete) throw new HttpError(409, `Finish the checklist first: ${p.items.filter(i => !i.done).map(i => i.label.toLowerCase()).join('; ')}.`);
      const request = { zwid: m.zwid, name: m.name, at: new Date().toISOString(), status: 'pending' };
      await redis([['HSET', KEYS.requests, m.zwid, JSON.stringify(request)]]);
      await discord('admin', { content: `🆙 **${discordEscape(m.name)}** has asked to become a full member. They have finished the checklist (${p.rsvps} social rides, ${p.teamEvents} team event${p.teamEvents === 1 ? '' : 's'}, ${p.days} days). Review it at ${siteUrl} → 👥 Members → Associates.` });
      return routes['GET /api/assoc/status'](req);
    },

    // Staff: every associate we know about, how far along they are, and any request.
    'GET /api/assoc/list': async req => {
      requireRole(req, ['admin', 'mod']);
      const [first, marks, full, requests] = await redis(['first', 'marks', 'full', 'requests'].map(k => ['HGETALL', KEYS[k]]));
      const f = obj(first), mk = obj(marks), fu = obj(full), rq = obj(requests);
      const ids = [...new Set([...Object.keys(f), ...Object.keys(mk), ...Object.keys(rq)])].filter(z => !fu[z]);
      const rows = await Promise.all(ids.map(async z => {
        const name = (f[z] && f[z].name) || (rq[z] && rq[z].name) || z;
        const p = await progress(z, name);
        return { zwid: z, name, since: f[z] && f[z].at, days: p.days, rsvps: p.rsvps, teamEvents: p.teamEvents, club: p.club, discord: p.discord, done: p.done, total: p.total, complete: p.complete, request: rq[z] || null, marked: !!mk[z] };
      }));
      rows.sort((a, b) => (b.request && b.request.status === 'pending') - (a.request && a.request.status === 'pending') || b.done - a.done || a.name.localeCompare(b.name));
      const upgraded = Object.values(fu).length;
      return { rows, upgraded, rules: RULES };
    },

    // Staff: make an associate a full member. The tier in WordPress is set too when there is a record; either way they are full from now on.
    'POST /api/assoc/approve': async (req, body) => {
      const role = requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed.');
      const [firstRaw, reqRaw] = await redis([['HGET', KEYS.first, zwid], ['HGET', KEYS.requests, zwid]]);
      const first = parse(firstRaw), request = parse(reqRaw);
      const name = (first && first.name) || (request && request.name) || String(body.name || zwid).slice(0, 60);
      const now = new Date().toISOString();
      await redis([['HSET', KEYS.full, zwid, JSON.stringify({ at: now, by: role })], ['HDEL', KEYS.marks, zwid],
        ['HSET', KEYS.requests, zwid, JSON.stringify({ ...(request || { zwid, name, at: now }), status: 'approved', decidedAt: now, by: role })]]);
      let wp = 'skipped';
      try { wp = (await setWpTier(zwid, 'full')) ? 'saved' : 'no-record'; } catch (e) { wp = 'failed'; }
      await discord('public', { content: `🎉 **Welcome ${discordEscape(name)} as a full member of CRYO-GEN!** You can now join the ZRL teams, the Ladder, DIRT and more. Sign in again at ${siteUrl} to see everything.` });
      return { approved: zwid, wordpress: wp };
    },

    'POST /api/assoc/decline': async (req, body) => {
      const role = requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      const request = parse((await redis([['HGET', KEYS.requests, zwid]]))[0]);
      if (!request) throw new HttpError(404, 'There is no request from that rider.');
      await redis([['HSET', KEYS.requests, zwid, JSON.stringify({ ...request, status: 'declined', decidedAt: new Date().toISOString(), by: role, note: text(body.note, 'note', 200, false) })]]);
      return { declined: zwid };
    },

    // Staff: make someone an associate (limited access) or take the mark off. Someone approved as full needs `force` to be marked again.
    'POST /api/assoc/mark': async (req, body) => {
      const role = requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed.');
      if (body.on === false) { await redis([['HDEL', KEYS.marks, zwid]]); return { marked: false }; }
      await redis([['HDEL', KEYS.full, zwid], ['HSET', KEYS.marks, zwid, JSON.stringify({ at: new Date().toISOString(), by: role })],
        ['HSETNX', KEYS.first, zwid, JSON.stringify({ at: new Date().toISOString(), name: text(body.name, 'name', 60, false) || zwid })]]);
      return { marked: true };
    },
  };

  // Once a week: tell the staff who has finished the checklist but not asked, and requests that have waited more than three days.
  async function runSchedule(now = Date.now()) {
    const done = [];
    const [first, full, requests] = await redis(['first', 'full', 'requests'].map(k => ['HGETALL', KEYS[k]]));
    const f = obj(first), fu = obj(full), rq = obj(requests);
    if (!Object.keys(f).length && !Object.keys(rq).length) return done;
    const week = `${new Date(now).getUTCFullYear()}-${Math.floor(now / (7 * DAY_MS))}`;
    const [claimed] = await redis([['HSETNX', KEYS.sent, `digest:${week}`, new Date(now).toISOString()]]);
    if (!claimed) return done;
    const waiting = Object.values(rq).filter(r => r.status === 'pending' && now - Date.parse(r.at) > 3 * DAY_MS);
    const ready = [];
    for (const [z, v] of Object.entries(f)) {
      if (fu[z] || (rq[z] && ['pending', 'approved'].includes(rq[z].status))) continue;
      if ((await progress(z, v.name, now)).complete) ready.push(v.name);
    }
    if (waiting.length || ready.length) {
      await discord('admin', { content: `🆙 **Associate members**\n${waiting.length ? `• ${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting more than three days: ${waiting.map(r => discordEscape(r.name)).join(', ')}\n` : ''}${ready.length ? `• Ready to ask, but have not: ${ready.slice(0, 10).map(discordEscape).join(', ')}${ready.length > 10 ? ` and ${ready.length - 10} more` : ''}. A friendly nudge could turn them into full members.\n` : ''}${siteUrl} → 👥 Members → Associates.` });
      done.push('assoc-digest');
    }
    return done;
  }

  async function healthRow(now = Date.now()) {
    const [first, requests] = await redis([['HGETALL', KEYS.first], ['HGETALL', KEYS.requests]]);
    const rq = Object.values(obj(requests)).filter(r => r.status === 'pending');
    const n = Object.keys(obj(first)).length;
    if (!n && !rq.length) return ['info', 'No associate members yet. They appear here after they sign in with their cryogen.team account.'];
    const old = rq.filter(r => now - Date.parse(r.at) > 3 * DAY_MS);
    if (old.length) return ['warn', `${old.length} request${old.length === 1 ? '' : 's'} for full membership waiting more than three days.`];
    return ['ok', `${n} associate${n === 1 ? '' : 's'} seen; ${rq.length} request${rq.length === 1 ? '' : 's'} waiting.`];
  }

  return { routes, classify, stillAssociate, noteFirstSeen, runSchedule, healthRow, KEYS, RULES };
};

'use strict';
// A rider asks to move to another ZRL team; the captain of the team they would join (or leave) or a staff member approves, and the move is made for them
// through the same assignment rules staff use (so a full team is refused, not overfilled). Riders never move themselves; nothing changes until someone approves.
module.exports = function createTeamChange({ redis, HttpError, memberFromRequest, isStaff, zrl, assign, notify = async () => false, discord = async () => false, siteUrl = '', now = () => Date.now() }) {
  const K = 'cg:teamchange';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const all = async () => { const [raw] = await redis([['HGETALL', K]]), out = []; for (let i = 0; i < (raw || []).length; i += 2) { const r = parse(raw[i + 1]); if (r) out.push(r); } return out.sort((a, b) => b.at.localeCompare(a.at)); };
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account first.'); return m; };
  const teamsOfRider = (data, zwid) => { const s = data.signups.find(x => x.in && x.zwid === String(zwid)); return s ? { signup: s, teams: data.assign[s.key] || [] } : { signup: null, teams: [] }; };
  const captainsOf = (round, ids) => [...new Set(round.teams.filter(t => ids.includes(t.id) && t.captain).map(t => String(t.captain)))];
  const nameOfTeam = (round, id) => (round.teams.find(t => t.id === id) || {}).name || id || 'no team';

  async function mine(req) {
    const m = need(req), data = await zrl.load(); if (!data.round) return { round: null, requests: [] };
    const { signup, teams } = teamsOfRider(data, m.zwid);
    return { round: data.round.name, signedUp: !!signup, current: teams.map(id => ({ id, name: nameOfTeam(data.round, id) })), teams: data.round.teams.map(t => ({ id: t.id, name: t.name })), requests: (await all()).filter(r => r.zwid === String(m.zwid)).slice(0, 5) };
  }
  async function request(req, body) {
    const m = need(req), data = await zrl.load(); if (!data.round) throw new HttpError(409, 'There is no ZRL round at the moment.');
    const { signup, teams } = teamsOfRider(data, m.zwid); if (!signup) throw new HttpError(409, 'Sign up for the round first, then ask to change team.');
    const to = String(body.to || ''), team = data.round.teams.find(t => t.id === to); if (!team) throw new HttpError(404, 'That team does not exist.');
    if (teams.includes(to)) throw new HttpError(409, 'You are already on that team.');
    const rows = await all(); if (rows.some(r => r.zwid === String(m.zwid) && r.status === 'open')) throw new HttpError(409, 'You already have a request waiting.');
    const key = `cg:tc:rate:${m.zwid}:${new Date(now()).toISOString().slice(0, 10)}`, [n] = await redis([['INCR', key]]); await redis([['EXPIRE', key, 172800]]); if (n > 4) throw new HttpError(429, 'That is plenty for today: thank you.');
    const from = teams.length === 1 ? teams[0] : '', id = now().toString(36) + Math.random().toString(36).slice(2, 5), rec = { id, at: new Date(now()).toISOString(), zwid: String(m.zwid), name: m.name, from, to, note: clean(body.note, 200), status: 'open' };
    await redis([['HSET', K, id, JSON.stringify(rec)]]);
    const text = `${m.name} asks to move ${from ? `from ${nameOfTeam(data.round, from)} ` : ''}to ${team.name}. Open ${siteUrl}/ → ZRL to approve or decline.`;
    const caps = captainsOf(data.round, [to, from].filter(Boolean)); let told = 0;
    for (const z of caps) if (await notify(z, `Team change request: ${text}`).catch(() => false)) told++;
    if (!told) await discord('admin', { content: `🔁 **Team change request:** ${text}` }).catch(() => {});
    return { ok: true, request: rec };
  }
  async function cancel(req, body) {
    const m = need(req), id = String(body.id || ''), [raw] = await redis([['HGET', K, id]]), r = parse(raw);
    if (!r || r.zwid !== String(m.zwid)) throw new HttpError(404, 'That request is not there.'); if (r.status !== 'open') throw new HttpError(409, 'That request has already been dealt with.');
    r.status = 'cancelled'; r.decidedAt = new Date(now()).toISOString(); await redis([['HSET', K, id, JSON.stringify(r)]]); return { ok: true };
  }
  // Open requests a person may decide: staff see all; a captain sees those touching a team they captain.
  async function visible(req) {
    const staff = isStaff(req), m = memberFromRequest(req); if (!staff && !m) throw new HttpError(401, 'Please sign in.');
    const data = await zrl.load(), rows = (await all()).filter(r => r.status === 'open');
    if (staff) return { staff: true, requests: rows.map(r => label(data, r)) };
    if (!data.round) return { staff: false, requests: [] };
    const mine = data.round.teams.filter(t => String(t.captain) === String(m.zwid)).map(t => t.id);
    if (!mine.length) throw new HttpError(403, 'Only captains and staff see these.');
    return { staff: false, requests: rows.filter(r => mine.includes(r.to) || (r.from && mine.includes(r.from))).map(r => label(data, r)) };
  }
  const label = (data, r) => ({ ...r, fromName: r.from ? nameOfTeam(data.round, r.from) : '', toName: nameOfTeam(data.round, r.to) });
  async function decide(req, body) {
    const id = String(body.id || ''), [raw] = await redis([['HGET', K, id]]), r = parse(raw); if (!r) throw new HttpError(404, 'That request is not there.');
    if (r.status !== 'open') throw new HttpError(409, 'That request has already been dealt with.');
    const staff = isStaff(req), m = memberFromRequest(req), data = await zrl.load(); if (!data.round) throw new HttpError(409, 'There is no ZRL round at the moment.');
    const caps = captainsOf(data.round, [r.to, r.from].filter(Boolean));
    if (!staff && !(m && caps.includes(String(m.zwid)))) throw new HttpError(403, 'Only the captain of one of these teams, or staff, can decide this.');
    const action = String(body.action || '');
    if (action === 'approve') {
      const { signup, teams } = teamsOfRider(data, r.zwid); if (!signup) throw new HttpError(409, 'That rider is no longer signed up for the round.');
      if (teams.includes(r.to)) throw new HttpError(409, 'They are already on that team.');
      if (r.from && teams.includes(r.from)) await assign({ key: signup.key, team: r.from, remove: true });
      await assign({ key: signup.key, team: r.to, add: true });
      r.status = 'approved';
    } else if (action === 'decline') r.status = 'declined'; else throw new HttpError(400, 'Choose approve or decline.');
    r.decidedAt = new Date(now()).toISOString(); r.decidedBy = staff ? 'staff' : (m && m.name) || ''; r.reason = clean(body.reason, 160); await redis([['HSET', K, id, JSON.stringify(r)]]);
    await notify(r.zwid, r.status === 'approved' ? `You are now on ${nameOfTeam(data.round, r.to)}. See you on race day!` : `Your request to move to ${nameOfTeam(data.round, r.to)} was not approved${r.reason ? `: ${r.reason}` : '.'}`).catch(() => {});
    return { request: label(data, r) };
  }
  const routes = {
    'GET /api/me/team-change': async req => mine(req),
    'POST /api/me/team-change': async (req, body) => request(req, body),
    'POST /api/me/team-change/cancel': async (req, body) => cancel(req, body),
    'GET /api/team-changes': async req => visible(req),
    'POST /api/team-changes/decide': async (req, body) => decide(req, body),
  };
  return { routes, all };
};

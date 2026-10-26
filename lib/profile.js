'use strict';
// The staff rider profile: what the club holds about one rider besides the stats the page already has. Which teams they are on (ZRL, Ladder,
// DIRT Series), whether Discord is linked, and the staff's own notes and details. The notes are kept here, not in WordPress, so they work for
// riders with no member record. Staff only: nothing here is shown to riders.
module.exports = function createProfile({ redis, HttpError, requireRole, text, zrl, ladder, drs, comms }) {
  const KEYS = { details: 'cg:rider:details' };   // zwid -> JSON {note, tz, trainer, bike, prefTeam, by, at}
  const FIELDS = { note: 800, tz: 40, trainer: 60, bike: 60, prefTeam: 80 };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const needZwid = zwid => { if (!/^\d{1,12}$/.test(String(zwid))) throw new HttpError(400, 'A Zwift ID is numbers only.'); return String(zwid); };

  async function teamsOn(zwid) {
    const [lRoster, lTeams, dSquad, dTeams] = await redis([['HGETALL', ladder.KEYS.roster], ['HGETALL', ladder.KEYS.teams], ['HGETALL', drs.KEYS.squad], ['HGETALL', drs.KEYS.teams]]);
    const names = raw => Object.fromEntries(pairs(raw).map(([id, v]) => [id, (parse(v) || {}).name]).filter(([, n]) => n));
    const ln = { main: 'CRYO-GEN', ...names(lTeams) }, dn = { main: 'CRYO-GEN', ...names(dTeams) };
    const on = (raw, nameOf) => pairs(raw).map(([f]) => (f.includes('|') ? f.split('|') : ['main', f])).filter(([, z]) => z === zwid).map(([t]) => nameOf[t] || t);
    let zrlTeams = [];
    try {
      const { round, signups, assign } = await zrl.load();
      const rider = round && signups.find(x => x.key === zwid);
      if (rider) {
        const ids = assign[rider.key] || [];
        zrlTeams = ids.map(id => (round.teams.find(t => t.id === id) || {}).name).filter(Boolean);
        return { zrl: { signedUp: true, racing: rider.in !== false, cat: rider.cat || '', regions: rider.regions || [], commit: rider.commit || 'full', devOk: rider.devOk === true, teams: zrlTeams }, ladder: on(lRoster, ln), drs: on(dSquad, dn) };
      }
    } catch (e) { /* the other sources still show */ }
    return { zrl: { signedUp: false, teams: zrlTeams }, ladder: on(lRoster, ln), drs: on(dSquad, dn) };
  }

  const routes = {
    'GET /api/profile': async (req, _b, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const zwid = needZwid(query.zwid);
      const [teams, [raw], discord] = await Promise.all([teamsOn(zwid), redis([['HGET', KEYS.details, zwid]]), comms.linkedVerified(zwid).catch(() => false)]);
      return { zwid, teams, discord: { linked: !!discord }, details: parse(raw) || {} };
    },
    'POST /api/profile': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const zwid = needZwid(body.zwid);
      const details = {};
      for (const [k, max] of Object.entries(FIELDS)) if (body[k] !== undefined) details[k] = text(body[k], k, max, false);
      if (!Object.keys(details).length) throw new HttpError(400, 'Nothing to save.');
      const [raw] = await redis([['HGET', KEYS.details, zwid]]);
      const next = { ...(parse(raw) || {}), ...details, by: String(body.by || '').slice(0, 40), at: new Date().toISOString() };
      for (const k of Object.keys(FIELDS)) if (next[k] === '') delete next[k];
      await redis([['HSET', KEYS.details, zwid, JSON.stringify(next)]]);
      return { zwid, details: next };
    },
  };
  return { routes, KEYS };
};

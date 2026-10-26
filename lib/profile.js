'use strict';
// The staff rider profile: what the club holds about one rider besides the stats the page already has. Which teams they are on (ZRL, Ladder,
// DIRT Series), whether Discord is linked, and the staff's own notes and details. The notes are kept here, not in WordPress, so they work for
// riders with no member record. Staff only: nothing here is shown to riders.
module.exports = function createProfile({ redis, HttpError, requireRole, memberFromRequest, text, zrl, ladder, drs, comms }) {
  const REGIONS = zrl.REGIONS || [];
  const KEYS = { details: 'cg:rider:details', tz: 'cg:me:tz' };   // details: zwid -> JSON {note, tz, trainer, bike, prefTeam, by, at}; tz: zwid -> JSON {zone, alsoUtc}
  const FIELDS = { note: 800, tz: 40, trainer: 60, bike: 60, prefTeam: 80 };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const needZwid = zwid => { if (!/^\d{1,12}$/.test(String(zwid))) throw new HttpError(400, 'A Zwift ID is numbers only.'); return String(zwid); };

  // `zwid` may be empty for a ZRL sign-up that has no Zwift ID yet; then `key` finds the sign-up (a name, in lower case).
  async function teamsOn(zwid, key) {
    const [lRoster, lTeams, dSquad, dTeams] = zwid ? await redis([['HGETALL', ladder.KEYS.roster], ['HGETALL', ladder.KEYS.teams], ['HGETALL', drs.KEYS.squad], ['HGETALL', drs.KEYS.teams]]) : [[], [], [], []];
    const names = raw => Object.fromEntries(pairs(raw).map(([id, v]) => [id, (parse(v) || {}).name]).filter(([, n]) => n));
    const ln = { main: 'CRYO-GEN', ...names(lTeams) }, dn = { main: 'CRYO-GEN', ...names(dTeams) };
    const on = (raw, nameOf) => pairs(raw).map(([f]) => (f.includes('|') ? f.split('|') : ['main', f])).filter(([, z]) => z === zwid).map(([t]) => nameOf[t] || t);
    const out = { zrl: { signedUp: false, teams: [] }, ladder: zwid ? on(lRoster, ln) : [], drs: zwid ? on(dSquad, dn) : [] };
    try {
      const { round, signups, assign } = await zrl.load();
      const rider = round && signups.find(x => x.key === (key || zwid));
      if (rider) {
        const ids = assign[rider.key] || [];
        out.zrl = { signedUp: true, racing: rider.in !== false, cat: rider.cat || '', regions: rider.regions || [], commit: rider.commit || 'full', devOk: rider.devOk === true,
          teams: ids.map(id => (round.teams.find(t => t.id === id) || {}).name).filter(Boolean),
          signup: { key: rider.key, name: rider.name, zwid: rider.zwid || '', in: rider.in !== false, cat: rider.cat || '', regions: rider.regions || [], commit: rider.commit === 'reserve' ? 'reserve' : 'full', captain: rider.captain === true, devOk: rider.devOk === true, preferred: rider.preferred || '' },
          regionList: REGIONS.map(r => ({ id: r.id, name: r.name })) };
      }
    } catch (e) { /* the other sources still show */ }
    return out;
  }

  const zoneOk = z => { if (z === 'device') return true; try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return typeof z === 'string' && z.length <= 60; } catch (e) { return false; } };
  const needMember = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };

  const routes = {
    // A rider's own choice of time zone (their device's, or a named one) and whether to show UTC beside it: it follows them to other devices.
    'GET /api/me/tz': async req => {
      const [raw] = await redis([['HGET', KEYS.tz, needMember(req).zwid]]);
      return parse(raw) || { zone: '', alsoUtc: false };
    },
    'POST /api/me/tz': async (req, body) => {
      const m = needMember(req), zone = String(body.zone || '');
      if (!zoneOk(zone)) throw new HttpError(400, 'That is not a time zone name, for example Europe/London or America/New_York.');
      const rec = { zone, alsoUtc: body.alsoUtc === true };
      await redis([['HSET', KEYS.tz, m.zwid, JSON.stringify(rec)]]);
      return rec;
    },
    'GET /api/profile': async (req, _b, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const key = String(query.key || '').slice(0, 80);
      const zwid = query.zwid ? needZwid(query.zwid) : '';
      if (!zwid && !key) throw new HttpError(400, 'Say which rider.');
      const [teams, [raw], discord] = zwid
        ? await Promise.all([teamsOn(zwid, key), redis([['HGET', KEYS.details, zwid]]), comms.linkedVerified(zwid).catch(() => false)])
        : [await teamsOn('', key), [null], false];
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

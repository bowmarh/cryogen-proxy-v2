'use strict';
// New-member onboarding: who joined recently and what they still have to do (a verified Discord link, a rider category, a place in some series), and a
// couple of friendly nudges by direct message for those who can be messaged. The members who were already in the club the first time this ran are
// remembered as existing and never listed or messaged; anyone who appears after that is new from the day the app first sees them.
module.exports = function createOnboarding({ redis, HttpError, requireRole, activeMembers, fetchRoster, verifiedLinks, teamSets, notify, siteUrl }) {
  const KEY = 'cg:onboard:seen', DAY = 86400000, WINDOW_DAYS = 30;
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };

  // Notes who is new (the first run only seeds), then returns the new members with their steps.
  async function scan(now = Date.now()) {
    const ids = await activeMembers();
    const seen = Object.fromEntries(pairs((await redis([['HGETALL', KEY]]))[0]).map(([z, v]) => [z, parse(v)]).filter(([, v]) => v));
    const first = !Object.keys(seen).length;
    const fresh = ids.filter(z => !seen[z]);
    if (fresh.length) {
      await redis(fresh.map(z => ['HSET', KEY, z, JSON.stringify({ at: new Date(now).toISOString(), seed: first })]));
      for (const z of fresh) seen[z] = { at: new Date(now).toISOString(), seed: first };
    }
    const [{ riders }, linked, teams] = await Promise.all([fetchRoster(), verifiedLinks(), teamSets()]);
    const byId = new Map(riders.map(r => [String(r.riderId), r]));
    const out = [];
    for (const z of ids) {
      const s = seen[z]; if (!s || s.seed) continue;
      const days = Math.floor((now - Date.parse(s.at)) / DAY);
      if (days > WINDOW_DAYS) continue;
      const r = byId.get(z), cat = r && ((r.race && r.race.current && r.race.current.mixed && r.race.current.mixed.category) || r.zpCategory);
      const steps = [{ id: 'discord', label: 'Discord linked and verified', done: linked.has(z) }, { id: 'category', label: 'A rider category on file', done: !!cat }, { id: 'series', label: 'On a team in ZRL, TTT, Ladder or DIRT', done: teams.has(z) }];
      out.push({ zwid: z, name: (r && r.name) || z, days, since: s.at, steps, done: steps.filter(x => x.done).length, total: steps.length, complete: steps.every(x => x.done) });
    }
    return out.sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  }

  const routes = {
    'GET /api/onboarding': async req => { requireRole(req, ['admin', 'mod']); const members = await scan(); return { members, stuck: members.filter(m => !m.complete && m.days >= 3).length, window: WINDOW_DAYS }; },
  };

  // Day 3 and day 10: a member with a verified Discord who is not on any team gets one friendly message each time.
  async function runSchedule(now = Date.now()) {
    const done = [];
    for (const m of await scan(now)) {
      if (m.complete || m.steps.find(s => s.id === 'series').done) continue;
      for (const [day, tag] of [[3, 'd3'], [10, 'd10']]) {
        if (m.days < day || m.days > day + 6) continue;
        const sent = await notify(m.zwid, day === 3
          ? `Welcome to CRYO-GEN! Ready for your first race? Sign up for the next TTT or ZRL round in the dashboard (${siteUrl}) and say which time zone and category you ride. The captains will do the rest.`
          : `Hi, it's been a week or so since you joined CRYO-GEN. If you haven't found a team yet, open the dashboard (${siteUrl}) and sign up for TTT, ZRL, the Ladder or the DIRT Series, or ask in Discord and a captain will help.`, { kind: 'club', key: `onboard:${tag}:${m.zwid}` }).catch(() => false);
        if (sent) done.push(`onboard-${tag}`);
      }
    }
    return done;
  }
  return { routes, scan, runSchedule, KEY };
};

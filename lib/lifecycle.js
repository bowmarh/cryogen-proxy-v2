'use strict';
// Members who have gone quiet: in the club and active on the books, but no race for a while (45 to 180 days; beyond that they are the tidy tool's "inactive"
// list). Staff see who, and when the automatic messages are on a member with a verified Discord or a notification device gets one friendly message, at most
// every 60 days, 20 a day. It never changes a member's record: stepping them off is still a staff decision in Members.
module.exports = function createLifecycle({ requireRole, tidy, notify, siteUrl, redis }) {
  const DAY = 86400000, FROM = 45, TO = 180, EVERY = 60, PER_RUN = 20;

  async function quiet(now = Date.now()) {
    const { inactive } = await tidy.analyse(now);
    return inactive.filter(m => m.inClub && m.tier !== 'associate' && m.daysSinceRace !== null && m.daysSinceRace >= FROM && m.daysSinceRace <= TO)
      .map(m => ({ zwid: m.zwid, name: m.name, days: m.daysSinceRace, last: m.lastRaced, tier: m.tier })).sort((a, b) => a.days - b.days);
  }

  const routes = { 'GET /api/lifecycle': async req => { requireRole(req, ['admin', 'mod']); const q = await quiet(); return { quiet: q, from: FROM, to: TO }; } };

  async function runSchedule(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10), [first] = await redis([['HSETNX', 'cg:lifecycle:sent', `run:${day}`, new Date(now).toISOString()]]);
    if (!first) return [];
    const done = [];
    for (const m of await quiet(now)) {
      if (done.length >= PER_RUN) break;
      const sent = await notify(m.zwid, `Hi ${String(m.name).split(/\s+/)[0]}, we've missed you on the road! It's been about ${Math.round(m.days / 7)} weeks since your last race. There's always a TTT, ZRL, Ladder or DIRT place for you: open the dashboard (${siteUrl}) to see what's coming up, or say hello in Discord and a captain will find you a team.`, { kind: 'club', key: `winback:${m.zwid}:${Math.floor(now / (EVERY * DAY))}` }).catch(() => false);
      if (sent) done.push(`winback-${m.zwid}`);
    }
    return done;
  }
  return { routes, quiet, runSchedule };
};

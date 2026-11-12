'use strict';
// Rider progress cards: a short, personal "how your season is going" email built from the rider's own numbers (ZRL, TTT, social rides, highlights).
// Off until an administrator switches it on; then one card per rider on the first days of the month (10 per scheduled run, once each), only to riders
// who have something to report and have not opted out of club news. The AI (if on) writes the encouraging line from numbers only (never names).
module.exports = function createProgress({ redis, HttpError, requireRole, mail, seasonOf, ai, siteUrl = '' }) {
  const K = { settings: 'cg:progress:settings', sent: 'cg:progress:sent:' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const PER_RUN = 10;
  const settings = async () => ({ on: false, ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });
  const london = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { day: Number(p.day), hour: Number(p.hour) }; };
  const month = ms => new Date(ms).toISOString().slice(0, 7);

  function facts(s) {
    const lines = [];
    if (s.zrl && s.zrl.placed) { lines.push(`ZRL ${s.zrl.round}${s.zrl.team ? ` with ${s.zrl.team}` : ''}: raced ${s.zrl.picked} of ${s.zrl.races} races so far${s.zrl.points ? `, ${s.zrl.points} team points` : ''}${s.zrl.podiums ? `, ${s.zrl.podiums} podium${s.zrl.podiums === 1 ? '' : 's'}` : ''}.`); }
    if (s.ttt && s.ttt.weeks) lines.push(`Team time trials: ${s.ttt.weeks} week${s.ttt.weeks === 1 ? '' : 's'} this season${s.ttt.podiums ? `, ${s.ttt.podiums} podium${s.ttt.podiums === 1 ? '' : 's'}` : ''}.`);
    if (s.rides && s.rides.attended) lines.push(`Social rides: ${s.rides.attended} joined.`);
    if (s.cover && s.cover.past) lines.push(`Ride cover: you helped on ${s.cover.past} ride${s.cover.past === 1 ? '' : 's'}.`);
    return lines;
  }
  async function card(zwid, name) {
    const s = await seasonOf({ zwid: String(zwid), name: String(name || zwid) }), lines = facts(s || {}), hi = (s && s.highlights) || [];
    if (!lines.length && !hi.length) return null;
    let nudge = 'Thank you for being part of the club. Whatever your next race is, we will see you on the road.';
    try {
      if (ai && await ai.available(true)) nudge = ai.clip(await ai.complete({ kind: 'progress', cap: 400, maxTokens: 200, system: 'You write one warm, upbeat sentence (at most 30 words, no emojis) of encouragement for a member of a friendly Zwift cycling club, from a few numbers. Plain text. Do not invent facts.', user: JSON.stringify({ zrl: s.zrl && s.zrl.placed ? { races: s.zrl.races, raced: s.zrl.picked, points: s.zrl.points, podiums: s.zrl.podiums } : null, ttt: s.ttt ? { weeks: s.ttt.weeks, podiums: s.ttt.podiums } : null, socialRides: s.rides ? s.rides.attended : 0, highlights: hi.length }) }), 300) || nudge;
    } catch (e) { /* the plain line stands */ }
    const body = `Hi {first},\n\nHere is how your season is going at Team CRYO-GEN:\n\n${lines.map(l => `- ${l}`).join('\n')}${hi.length ? `\n\n${hi.join('\n')}` : ''}\n\n${nudge}\n\n[Open your season in the club app](${siteUrl})\n\nTeam CRYO-GEN`;
    return { subject: 'Your season so far at Team CRYO-GEN', body, lines };
  }
  async function run(now = Date.now()) {
    const s = await settings(); if (!s.on) return [];
    const t = london(now); if (t.day > 7 || t.hour < 9) return [];
    const key = K.sent + month(now), [raw] = await redis([['HKEYS', key]]), done = new Set(raw || []), todo = (await mail.everyone('news')).list.filter(r => !done.has(r.z)), out = [];
    for (const r of todo) {
      if (out.length >= PER_RUN) break;
      let c = null; try { c = await card(r.z, r.n); } catch (e) { /* skip this rider */ }
      await redis([['HSET', key, r.z, c ? 'sent' : 'skipped'], ['EXPIRE', key, 40 * 86400]]);
      if (!c) continue;
      try { await mail.sendTo({ zwid: r.z, subject: c.subject, body: c.body, category: 'news' }); out.push(`progress-${r.z}`); } catch (e) { if (e.status === 429) { await redis([['HDEL', key, r.z]]); break; } }
    }
    return out;
  }
  const routes = {
    'GET /api/aiops/progress': async req => { requireRole(req, ['admin', 'mod']); return { settings: await settings() }; },
    'POST /api/aiops/progress-settings': async (req, body) => { requireRole(req, ['admin']); const n = { on: body.on === true }; await redis([['SET', K.settings, JSON.stringify(n)]]); return { settings: n }; },
    'POST /api/aiops/progress-preview': async (req, body) => { requireRole(req, ['admin', 'mod']); const z = String(body.zwid || '').replace(/\D/g, ''); if (!z) throw new HttpError(400, 'Enter a Zwift ID.'); const c = await card(z, body.name || z); if (!c) throw new HttpError(409, 'That rider has nothing to report yet.'); return c; },
    'POST /api/aiops/progress-send': async (req, body) => { requireRole(req, ['admin']); const z = String(body.zwid || '').replace(/\D/g, ''), c = await card(z, body.name || z); if (!c) throw new HttpError(409, 'That rider has nothing to report yet.'); await mail.sendTo({ zwid: z, subject: c.subject, body: c.body, category: 'news' }); return { ok: true }; },
  };
  return { routes, run, card, settings };
};

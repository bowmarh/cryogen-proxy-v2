'use strict';
// Two scheduled AI messages for riders who have said yes to the coach:
//  - a weekly plan on Monday for supporters who opted in (one model call per rider; the cost is what supporters fund);
//  - a race-day briefing about an hour before a Ladder, DIRT or ZRL race, written once for the whole line-up (one call per race, whoever is riding).
// Both go out as the club's automatic messages (so they respect each rider's message choices and the club's switch), both are skipped when the AI is
// off or the monthly budget is used, and neither sends a rider's name or contact details to the model.
module.exports = function createAiPlans({ redis, HttpError, memberFromRequest, ai, coach, support, notify, live, adminReq, fetchRoster, siteUrl = '', coachSystem = '', asMember }) {
  const OPT = 'cg:plan:optin', LAST = 'cg:plan:last', WEEKS = 'cg:plan:weeks', BRIEF = 'cg:brief:sent', CONSENT = 'cg:coach:consent';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const monday = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };

  const routes = {
    'GET /api/plan': async req => {
      const m = need(req), [opt, last, cons] = await redis([['HGET', OPT, m.zwid], ['HGET', LAST, m.zwid], ['HGET', CONSENT, m.zwid]]);
      return { optIn: !!opt, supporter: await support.isSupporter(m.zwid), consent: !!cons, last: parse(last), enabled: ai.enabled() };
    },
    'POST /api/plan/optin': async (req, body) => {
      const m = need(req);
      if (body.on === false) { await redis([['HDEL', OPT, m.zwid]]); return { optIn: false }; }
      const [cons] = await redis([['HGET', CONSENT, m.zwid]]);
      if (!cons) throw new HttpError(403, 'Say yes to the coach first, so it may use your numbers.');
      if (!(await support.isSupporter(m.zwid))) throw new HttpError(403, 'The weekly plan is a supporter extra.');
      await redis([['HSET', OPT, m.zwid, new Date().toISOString()]]); return { optIn: true };
    },
  };

  async function writePlan(zwid, name) {
    const ctx = await coach.context(asMember(zwid, name), { zwid });
    return ai.complete({ kind: 'plan', system: coachSystem, maxTokens: 2000, user: `Write my plan for this week, from Monday. My numbers: ${JSON.stringify(ctx).slice(0, 5000)}\n\nFormat: one short line per training day with the session, the length and the target as a percentage of FTP (or "rest"), then one line about any race this week and how to ride it. About 150 words, plain text, no preamble.` });
  }

  // Monday from 06:00 UTC: queue the opted-in supporters once, then work through them a few at a time (each tick has about a minute).
  async function planTick(now, budgetMs = 35000) {
    const done = [], d = new Date(now);
    if (d.getUTCDay() !== 1 && !(d.getUTCDay() === 2)) return done;      // Monday, with Tuesday to finish a long queue
    const week = monday(now), qKey = `cg:plan:q:${week}`;
    if (d.getUTCDay() === 1 && d.getUTCHours() < 6) return done;
    const [made] = await redis([['HSETNX', WEEKS, week, new Date(now).toISOString()]]);
    if (made) {
      const [optRaw, consRaw] = await redis([['HGETALL', OPT], ['HGETALL', CONSENT]]), cons = new Set(pairs(consRaw).map(([z]) => z));
      const ids = []; for (const [z] of pairs(optRaw)) if (cons.has(z) && await support.isSupporter(z)) ids.push(z);
      await redis([['SET', qKey, JSON.stringify(ids), 'EX', '864000']]);
    }
    const [raw] = await redis([['GET', qKey]]); let queue = parse(raw) || [];
    const started = Date.now(), { riders } = await fetchRoster().catch(() => ({ riders: [] }));
    while (queue.length && Date.now() - started < budgetMs && await ai.available(true)) {
      const z = queue.shift(), name = (riders.find(r => String(r.riderId) === z) || {}).name || z;
      try {
        const text = await writePlan(z, name);
        await redis([['HSET', LAST, z, JSON.stringify({ week, text, at: new Date(now).toISOString() })]]);
        await notify(z, `📅 Your plan for this week:\n${text.slice(0, 1300)}\n\nFull plan and your coach: ${siteUrl}`, { kind: 'coach', key: `plan:${week}:${z}` });
        done.push(`plan-${z}`);
      } catch (e) { console.error('Weekly plan:', e.message); }
      await redis([['SET', qKey, JSON.stringify(queue), 'EX', '864000']]);
    }
    return done;
  }

  // An hour before a race: one briefing for the line-up, a tip for each rider who has said yes to the coach.
  async function briefTick(now) {
    const done = [];
    if (!(await ai.available(false))) return done;
    const events = (await live.events(adminReq(), now)).filter(e => e.minutes >= 40 && e.minutes <= 80);
    if (!events.length) return done;
    const [consRaw] = await redis([['HGETALL', CONSENT]]), cons = new Set(pairs(consRaw).map(([z]) => z)), { riders } = await fetchRoster().catch(() => ({ riders: [] }));
    for (const e of events) {
      const going = e.riders.filter(r => r.role !== 'reserve' && r.answer !== 'no' && cons.has(r.zwid));
      if (!going.length) continue;
      const [first] = await redis([['HSETNX', BRIEF, `${e.kind}:${e.id}`, new Date(now).toISOString()]]); if (!first) continue;
      const refs = going.map((r, i) => { const x = riders.find(q => String(q.riderId) === r.zwid) || {}, p = x.power || {}; return { ref: String.fromCharCode(65 + i), zwid: r.zwid, name: r.name, info: { category: x.zpCategory || null, role: r.role || 'rider', best5minWkg: p.wkg300 || null, best20minWkg: p.wkg1200 || null, type: x.phenotype && x.phenotype.value || null } }; });
      try {
        const text = await ai.complete({ kind: 'brief', cap: 120, supporter: false, maxTokens: 1800, system: `${coachSystem}\nYou are writing a short race-day briefing for a team about to start. Reply with JSON only: {"team": "<3 to 5 sentences: how to ride this race together, who does what, pacing, one warning>", "riders": [{"ref": "A", "tip": "<one sentence for that rider based on their numbers and type>"}]}. Only use the refs given.`,
          user: `Race: ${e.title} (${e.kind}), starts in about ${e.minutes} minutes. Riders: ${JSON.stringify(refs.map(r => ({ ref: r.ref, ...r.info })))}` });
        const j = ai.json(text); if (!j || !j.team) throw new Error('unreadable briefing');
        const tips = Object.fromEntries((Array.isArray(j.riders) ? j.riders : []).map(t => [String(t.ref), ai.clip(t.tip, 220)]));
        for (const r of refs) { const sent = await notify(r.zwid, `🏁 Briefing for ${e.title}:\n${ai.clip(j.team, 700)}${tips[r.ref] ? `\n\nFor you: ${tips[r.ref]}` : ''}`, { kind: 'coach', key: `brief:${e.kind}:${e.id}:${r.zwid}` }); if (sent) done.push(`brief-${r.zwid}`); }
      } catch (err) { console.error('Briefing:', err.message); await redis([['HDEL', BRIEF, `${e.kind}:${e.id}`]]).catch(() => {}); }
    }
    return done;
  }

  return { routes, planTick, briefTick, runSchedule: async now => { await planTick(now).catch(e => console.error('Plans:', e.message)); await briefTick(now).catch(e => console.error('Briefings:', e.message)); return []; }, writePlan };
};

'use strict';
// The control room: one screen for race day, and one list of whether every moving part of the app is healthy.
//  - Race day: for each ZRL team, who has answered, whether the line-up is full and whether the result is in; the radio's recent posts; queues waiting for staff.
//  - Systems: storage, email, WordPress addresses, Google, the AI, the radio. Anything that needs attention is listed first.
//  - The watchdog (a scheduled job) tells the admin channel when the list of problems changes, never twice for the same set.
module.exports = function createControlRoom({ redis, requireRole, zrl, aiops, mail, join, gsheets, ai, discord = async () => false, siteUrl = '' }) {
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * 86400000).toISOString().slice(0, 10);

  async function race() {
    const data = await zrl.load(); if (!data.round) return { round: null };
    const [weekly, results] = await Promise.all([zrl.loadWeekly(), zrl.loadResults()]), today = new Date().toISOString().slice(0, 10);
    let week = Array.from({ length: data.round.weeks }, (_, i) => i).find(i => weekDate(data.round, i) >= today); if (week === undefined) week = data.round.weeks - 1;
    const teams = data.round.teams.map(t => {
      const pool = data.signups.filter(x => x.in && x.zwid && (data.assign[x.key] || []).includes(t.id)), count = a => pool.filter(x => zrl.availOf(weekly, week, x.zwid, t.id) === a).length;
      const picked = (weekly.lineup[`${week}:${t.id}`] || []).length, r = results[`${week}:${t.id}`], have = !!(r && (r.pos || (r.pts !== undefined && r.pts !== null)));
      return { id: t.id, name: t.name, riders: pool.length, yes: count('yes'), maybe: count('maybe'), no: count('no'), picked, short: Math.max(0, data.round.racing - picked), result: have ? { pos: r.pos || null, pts: r.pts ?? null } : null };
    });
    return { round: data.round.name, week, date: weekDate(data.round, week), racing: data.round.racing, teams };
  }

  async function systems() {
    const out = [], add = (name, level, detail) => out.push({ name, level, detail });
    const t0 = Date.now();
    try { await redis([['GET', 'cg:control:ping']]); add('Storage', Date.now() - t0 > 2500 ? 'warn' : 'ok', `Answered in ${Date.now() - t0} ms.`); } catch (e) { add('Storage', 'bad', String(e.message).slice(0, 200)); }
    if (mail) {
      try {
        const h = await mail.health();
        if (!h.configured) add('Email service', 'off', 'No email service is connected (see docs/EMAIL-SETUP.md).');
        else if (h.paused.length) add('Email service', 'bad', `A send is paused: "${h.paused[0].subject}" (${h.paused[0].error || 'the service refused it'}). Open Email and press Resume.`);
        else add('Email service', h.enabled ? 'ok' : 'warn', h.enabled ? `On, sending through ${h.provider}.${h.sending ? ` ${h.sending} send in progress.` : ''}` : 'Connected but switched off in Email settings.');
        if (h.addresses.error) add('Member addresses', 'bad', h.addresses.error); else add('Member addresses', h.addresses.withEmail ? 'ok' : 'warn', `${h.addresses.withEmail} of ${h.addresses.members} members have an email address.`);
      } catch (e) { add('Email service', 'bad', String(e.message).slice(0, 200)); }
    }
    const g = gsheets.status(); add('Google Sheets', g.configured ? 'ok' : 'off', g.configured ? `Signed in as ${g.email}.` : (g.error || 'No Google key is set (publishing to sheets is off; reading sheets still works).'));
    let aiOn = false; try { aiOn = await ai.available(true); } catch (e) { /* off */ }
    add('AI', ai.enabled() ? (aiOn ? 'ok' : 'warn') : 'off', ai.enabled() ? (aiOn ? 'On, inside its budget.' : 'The key is set but the budget is used up.') : 'No AI key: everything falls back to plain wording.');
    try { const s = await aiops.settings(); add('Race radio', 'ok', s.radio.on ? 'On: results are posted as they are entered.' : 'Off.'); } catch (e) { /* skip */ }
    const order = { bad: 0, warn: 1, ok: 2, off: 3 }; return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  async function overview() {
    const [r, sys, feed, joins] = await Promise.all([race().catch(e => ({ round: null, error: e.message })), systems(), aiops.feed().catch(() => []), join ? join.list().catch(() => []) : []]);
    return { generated: new Date().toISOString(), race: r, systems: sys, feed, joinOpen: joins.filter(x => x.status === 'open').length };
  }

  // Called by the scheduled job: a message only when the set of bad systems changes.
  async function watchdog() {
    const bad = (await systems()).filter(x => x.level === 'bad'), sig = bad.map(x => x.name).sort().join('|'), [last] = await redis([['GET', 'cg:watchdog:sig']]);
    if ((last || '') === sig) return [];
    await redis([['SET', 'cg:watchdog:sig', sig]]);
    if (bad.length) await discord('admin', { content: `🚨 **The club app needs attention:**\n${bad.map(x => `- ${x.name}: ${x.detail}`).join('\n')}\n${siteUrl}` }).catch(() => {});
    else if (last) await discord('admin', { content: '✅ The club app is healthy again.' }).catch(() => {});
    return ['watchdog'];
  }

  const routes = { 'GET /api/control': async req => { requireRole(req, ['admin', 'mod']); return overview(); } };
  return { routes, overview, systems, race, watchdog };
};

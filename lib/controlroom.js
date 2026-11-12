'use strict';
// The control room: one screen for race day, and one list of whether every moving part of the app is healthy.
//  - Race day: for each ZRL team, who has answered, whether the line-up is full and whether the result is in; the radio's recent posts; queues waiting for staff.
//  - Systems: storage, email, WordPress addresses, Google, the AI, the radio. Anything that needs attention is listed first.
//  - The watchdog (a scheduled job) tells the admin channel when the list of problems changes, never twice for the same set.
module.exports = function createControlRoom({ alertEmail = async () => false, redis, requireRole, zrl, aiops, mail, join, costs = null, housekeeping = null, pushStaff = async () => 0, gsheets, ai, backup = null, discord = async () => false, siteUrl = '' }) {
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
    if (backup) { try { const [lvl, detail] = await backup.healthRow(); add('Backups', lvl === 'ok' ? 'ok' : /^No backup yet/.test(detail) ? 'warn' : 'bad', detail); } catch (e) { add('Backups', 'warn', 'Could not read the backup status.'); } }
    if (process.env.VERCEL_ENV === 'preview') add('Environment', 'warn', process.env.ALLOW_OUTBOUND === '1' ? 'A preview deployment with outbound messages allowed.' : 'This is a preview deployment: emails and Discord posts are switched off, so it is safe to try things.');
    if (costs) { try { for (const m of await costs.snapshot()) if (m.limit && m.level !== 'ok') add(m.label, m.level, `${m.pct}% of the budget used. ${m.note}`); } catch (e) { /* skipped */ } }
    if (housekeeping) { try { const l = await housekeeping.last(), n = l ? Object.values(l.removed).reduce((a, b) => a + b, 0) : 0; add('Housekeeping', !l ? 'ok' : Date.now() - Date.parse(l.at) > 10 * 86400000 ? 'warn' : 'ok', l ? `Last weekly tidy-up ${l.at.slice(0, 10)}: ${n} old item${n === 1 ? '' : 's'} removed.` : 'The weekly tidy-up has not run yet (it runs early on Sundays).'); } catch (e) { /* skipped */ } }
    add('Owner login', process.env.OWNER_PASSWORD ? 'ok' : 'warn', process.env.OWNER_PASSWORD ? 'The owner login is set up: owner-only actions need it.' : 'No OWNER_PASSWORD is set, so every administrator currently has the owner\'s powers. Add OWNER_PASSWORD in Vercel (then redeploy) to keep backups, money, access and the switches to the owner.');
    const g = gsheets.status(); add('Google Sheets', g.configured ? 'ok' : 'off', g.configured ? `Signed in as ${g.email}.` : (g.error || 'No Google key is set (publishing to sheets is off; reading sheets still works).'));
    let aiOn = false; try { aiOn = await ai.available(true); } catch (e) { /* off */ }
    add('AI', ai.enabled() ? (aiOn ? 'ok' : 'warn') : 'off', ai.enabled() ? (aiOn ? 'On, inside its budget.' : 'The key is set but the budget is used up.') : 'No AI key: everything falls back to plain wording.');
    try { const s = await aiops.settings(); add('Race radio', 'ok', s.radio.on ? 'On: results are posted as they are entered.' : 'Off.'); } catch (e) { /* skip */ }
    const order = { bad: 0, warn: 1, ok: 2, off: 3 }; return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  // The systems list is the expensive part (about twenty storage reads), and it changes slowly: an open Control room tab reuses it for five minutes. The
  // watchdog, the go-live check and the smoke test always ask afresh.
  let sysCache = null;
  const systemsCached = async (ttl = 300000) => { if (sysCache && Date.now() - sysCache.at < ttl) return sysCache.list; const list = await systems(); sysCache = { at: Date.now(), list }; return list; };
  async function overview(fresh = false) {
    const [r, sys, feed, joins] = await Promise.all([race().catch(e => ({ round: null, error: e.message })), fresh ? systems().then(l => { sysCache = { at: Date.now(), list: l }; return l; }) : systemsCached(), aiops.feed().catch(() => []), join ? join.list().catch(() => []) : []]);
    return { generated: new Date().toISOString(), race: r, systems: sys, feed, joinOpen: joins.filter(x => x.status === 'open').length };
  }

  // Called by the scheduled job: a message only when the set of bad systems changes.
  async function watchdog() {
    const bad = (await systems()).filter(x => x.level === 'bad'), sig = bad.map(x => x.name).sort().join('|'), [last] = await redis([['GET', 'cg:watchdog:sig']]);
    if ((last || '') === sig) return [];
    await redis([['SET', 'cg:watchdog:sig', sig]]);
    if (bad.length) await discord('admin', { content: `🚨 **The club app needs attention:**\n${bad.map(x => `- ${x.name}: ${x.detail}`).join('\n')}\n${siteUrl}` }).catch(() => {});
    else if (last) await discord('admin', { content: '✅ The club app is healthy again.' }).catch(() => {});
    if (bad.length) await alertEmail('CRYO-GEN needs attention', `${bad.map(x => `- ${x.name}: ${x.detail}`).join('\n')}\n\n${siteUrl}`);
    else if (last) await alertEmail('CRYO-GEN is healthy again', `Everything is working again.\n\n${siteUrl}`);
    if (bad.length) await pushStaff({ title: 'CRYO-GEN needs attention', body: bad.map(x => x.name).join(', '), url: siteUrl }).catch(() => {});
    return ['watchdog'];
  }

  // What anyone may see on the open race page: team names, results and the radio's words. No riders, no counts of who said what.
  async function publicRace() {
    const [r, feed] = await Promise.all([race().catch(() => ({ round: null })), aiops.feed().catch(() => [])]);
    return { generated: new Date().toISOString(), round: r.round || null, week: r.week ?? null, date: r.date || null, teams: (r.teams || []).map(t => ({ name: t.name, result: t.result })), feed: feed.slice(0, 10).map(f => ({ at: f.at, text: f.text })) };
  }
  const routes = { 'GET /api/control': async (req, _b, q = {}) => { requireRole(req, ['admin', 'mod']); return overview(q.fresh === '1'); } };
  return { routes, overview, systems, systemsCached, race, watchdog, publicRace };
};

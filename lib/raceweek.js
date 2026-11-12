'use strict';
// Race week on autopilot (off until an administrator switches it on). For the next ZRL race, per team, once each:
//   6 to 5 days before: ask every rider for availability (Discord buttons; riders without a linked Discord get the one-tap email link);
//   4 to 3 days before: remind only the riders who have not answered;
//   2 to 1 days before: if no line-up is set, propose one and send the captain "Approve line-up" / "No thanks" buttons (staff are told if the captain cannot be reached).
// Nothing is ever applied without the captain's tap. Every step is recorded so it cannot repeat.
module.exports = function createRaceWeek({ redis, HttpError, requireRole, zrl, aiops, mail, notify, lineupButtons, applyLineup, discord = async () => false, siteUrl = '' }) {
  const K = { settings: 'cg:raceweek:settings', done: 'cg:raceweek:done', prop: 'cg:raceweek:prop:' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const DAY = 86400000, weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10);
  const settings = async () => ({ on: false, ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });
  const once = async key => (await redis([['HSETNX', K.done, key, new Date().toISOString()]]))[0];
  const first = n => String(n || '').trim().split(/\s+/)[0] || 'there';

  async function target(now) {
    const data = await zrl.load(); if (!data.round) return null;
    const today = new Date(now).toISOString().slice(0, 10); let week = Array.from({ length: data.round.weeks }, (_, i) => i).find(i => weekDate(data.round, i) >= today);
    if (week === undefined) return null;
    return { data, week, date: weekDate(data.round, week), days: Math.round((Date.parse(weekDate(data.round, week)) - Date.parse(today)) / DAY) };
  }
  async function emailUnreached(team, week, ids, step) {
    if (!mail || !ids.length) return;
    await mail.autoSend({ subject: `${team.name}: can you race in race ${week + 1}?`, body: `Hi {first},\n\n${step === 'remind' ? 'A quick reminder: ' : ''}we are picking the ${team.name} line-up for race ${week + 1}. Can you race?\n\n[Tell us in one tap]({rsvp}&w=${week})\n\nYour captain sees your answer straight away. Thank you!\n\nCRYO-GEN`, category: 'service', zwids: ids, who: 'automatic' }).catch(() => {});
  }
  async function propose(t, team) {
    const weekly = await zrl.loadWeekly(); if ((weekly.lineup[`${t.week}:${team.id}`] || []).length >= t.data.round.racing) return 'set';
    const s = await aiops.lineupSuggest({ team: team.id, week: t.week }).catch(() => null); if (!s || !s.picks.length) return 'none';
    await redis([['SET', K.prop + `${t.week}:${team.id}`, JSON.stringify({ zwids: s.picks.map(p => p.zwid), names: s.picks.map(p => p.name), at: new Date().toISOString() }), 'EX', 10 * DAY]]);
    const text = `Hi ${first(team.captainName)}, here is a proposed ${team.name} line-up for race ${t.week + 1} (${t.date}):\n${s.picks.map(p => `- ${p.name} (${p.why})`).join('\n')}${s.short ? `\n\n${s.short} place${s.short === 1 ? ' is' : 's are'} still open.` : ''}\n\nApprove it, or pick your own in the app: ${siteUrl}`;
    const sent = team.captain ? await notify(team.captain, text, { kind: 'lineup', key: `lineup:${t.week}:${team.id}`, components: lineupButtons(t.week, team.id) }).catch(() => false) : false;
    if (!sent) await discord('admin', { content: `🧩 A proposed **${team.name}** line-up for race ${t.week + 1} is ready but the captain could not be reached on Discord. Open ${siteUrl} → Control room → Suggest to apply it.` }).catch(() => {});
    return sent ? 'sent' : 'staff';
  }
  async function tick(now = Date.now()) {
    if (!(await settings()).on) return [];
    const t = await target(now); if (!t) return []; const done = [];
    const step = t.days >= 5 && t.days <= 6 ? 'ask' : t.days >= 3 && t.days <= 4 ? 'remind' : t.days >= 1 && t.days <= 2 ? 'propose' : '';
    if (!step) return done;
    for (const team of t.data.round.teams) {
      if (!(await once(`${t.week}:${team.id}:${step}`))) continue;
      try {
        if (step === 'propose') await propose(t, team);
        else { const r = await aiops.discordAsk({ team: team.id, week: t.week, step }); await emailUnreached(team, t.week, r.unreachableZwids || [], step); }
        done.push(`raceweek-${step}-${team.id}`);
      } catch (e) { await redis([['HDEL', K.done, `${t.week}:${team.id}:${step}`]]); console.error('Race week:', e.message); }
    }
    return done;
  }
  // The captain's tap on "Approve line-up" or "No thanks".
  async function lineupAction(zwid, week, teamId, action) {
    const data = await zrl.load(), team = data.round && data.round.teams.find(x => x.id === teamId);
    if (!team) throw new HttpError(404, 'That team does not exist.'); if (String(team.captain) !== String(zwid)) throw new HttpError(403, 'Only the team captain can answer this.');
    if (action === 'skip') return { text: 'No problem: you will pick the line-up yourself in the app.' };
    const prop = parse((await redis([['GET', K.prop + `${week}:${teamId}`]]))[0]); if (!prop) throw new HttpError(409, 'That proposal has expired. Open the app to pick the line-up.');
    await applyLineup(zwid, teamId, week, prop.zwids);
    return { text: `Line-up approved and set (${prop.names.join(', ')}).` };
  }
  const routes = {
    'GET /api/raceweek': async req => { requireRole(req, ['admin', 'mod']); const t = await target(Date.now()), [raw] = await redis([['HGETALL', K.done]]), steps = []; for (let i = 0; i < (raw || []).length; i += 2) if (t && raw[i].startsWith(`${t.week}:`)) steps.push(raw[i]); return { settings: await settings(), week: t ? t.week : null, date: t ? t.date : null, daysToRace: t ? t.days : null, doneSteps: steps }; },
    'POST /api/raceweek/settings': async (req, body) => { requireRole(req, ['admin']); const n = { on: body.on === true }; await redis([['SET', K.settings, JSON.stringify(n)]]); return { settings: n }; },
  };
  return { routes, tick, lineupAction, settings };
};

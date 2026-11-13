'use strict';
// "Your week" by Discord: once a week (from Monday morning UTC) each rider with a verified Discord link gets their own next seven days, with what
// still needs their answer first. It is the same "My week" card they see in the app, so it never shows anything they could not see there.
// Off until an administrator switches it on. A rider who switched "weekly summary" messages off in My Profile, or has nothing on, gets nothing.
// Each rider gets it once per week (a sent marker per ISO week); PER_RUN riders per scheduled run, so a big club is covered over a few runs on Monday.
module.exports = function createWeekPush({ redis, HttpError, requireRole, myweek, comms, rosterNames, siteUrl, recentResults = async () => [] }) {
  const SETTINGS = 'cg:weekpush:settings', PER_RUN = 40, DAY = 86400000;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const settings = async () => ({ on: false, ...(parse((await redis([['GET', SETTINGS]]))[0]) || {}) });
  // ISO week key, e.g. 2026-W46: the same all week, new each Monday.
  function weekKey(now) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = d.getUTCFullYear(); return `${y}-W${String(Math.ceil(((d - Date.UTC(y, 0, 1)) / DAY + 1) / 7)).padStart(2, '0')}`; }
  const fmtDay = it => { const t = new Date(it.atMs); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]}${it.timed ? ' ' + t.toISOString().slice(11, 16) + ' UTC' : ''}`; };

  function text(week, results = []) {
    const todo = week.items.filter(i => i.state === 'todo'), on = week.items.filter(i => i.state === 'in'), offer = week.items.filter(i => i.state === 'info');
    const line = i => `• ${fmtDay(i)} · **${i.kind}** ${i.title}${i.note ? ` (${i.note})` : ''}`;
    const parts = [`🗓️ **Your CRYO-GEN week, ${week.name.split(/\s+/)[0]}**`];
    if (results.length) parts.push(`**Last week** 🏁\n${results.slice(0, 4).map(r => `• ${r.catPos ? `#${r.catPos} in ${r.cat || 'your category'}` : r.pos ? `#${r.pos}` : 'Finished'} · ${r.title}`).join('\n')}`);
    if (todo.length) parts.push(`**Needs your answer (${todo.length})**\n${todo.slice(0, 6).map(line).join('\n')}`);
    if (on.length) parts.push(`**You're riding**\n${on.slice(0, 6).map(line).join('\n')}`);
    if (!todo.length && !on.length && offer.length) parts.push(`**On offer**\n${offer.slice(0, 4).map(line).join('\n')}`);
    parts.push(`Open the club app to answer: ${siteUrl}`);
    return parts.join('\n\n').slice(0, 1800);
  }

  async function runSchedule(now = Date.now()) {
    if (!(await settings()).on) return [];
    if ((new Date(now).getUTCDay() || 7) > 2) return [];   // Monday and Tuesday only: a late batch still lands early in the week
    const wk = weekKey(now), ids = await comms.verifiedDiscordIds(), names = await rosterNames(), done = [];
    for (const zwid of ids.keys()) {
      if (done.length >= PER_RUN) break;
      const name = names.get(zwid); if (!name) continue;   // not an active member
      const [claimed] = await redis([['HSETNX', 'cg:weekpush:sent', `${wk}:${zwid}`, new Date(now).toISOString()]]);   // claimed first, so two runs never send twice
      if (!Number(claimed)) continue;
      const week = await myweek.buildFor({ zwid, name }, now).catch(() => null);
      const results = (await recentResults(zwid).catch(() => [])).filter(r => r.time && now - r.time * 1000 <= 8 * DAY);
      if (!week || (!results.length && !week.items.some(i => i.state === 'todo' || i.state === 'in' || i.state === 'info'))) continue;
      if (await comms.notify(zwid, text(week, results), { kind: 'week' })) done.push(`week-${zwid}`);
    }
    return done.length ? [`Your week: sent to ${done.length}`] : [];
  }

  const routes = {
    'GET /api/weekpush': async req => { requireRole(req, ['admin', 'mod']); const [n] = await redis([['HLEN', 'cg:weekpush:sent']]); return { settings: await settings(), week: weekKey(Date.now()), sentEver: Number(n) || 0 }; },
    'POST /api/weekpush/settings': async (req, body) => { requireRole(req, ['admin']); const s = { on: body.on === true }; await redis([['SET', SETTINGS, JSON.stringify(s)]]); return { settings: s }; },
    'POST /api/weekpush/preview': async (req, body) => { requireRole(req, ['admin', 'mod']); const zwid = String(body.zwid || ''); const name = (await rosterNames()).get(zwid); if (!name) throw new HttpError(404, 'No active member with that Zwift ID.'); return { text: text(await myweek.buildFor({ zwid, name })) }; },
  };
  return { runSchedule, routes, text, weekKey };
};

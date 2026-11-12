'use strict';
// Usage against budgets: storage commands this month (versus the Upstash plan), AI spend this month (versus the budget set under Supporters), and emails
// today (versus the daily limit). Meters turn amber at 80% and red at 100%; the admin channel is told once per period at 80% and again at 100%.
module.exports = function createCosts({ redis, requireRole, support, mail = null, discord = async () => false, usageKey = 'cg:usage', env = process.env }) {
  const month = ms => new Date(ms).toISOString().slice(0, 7), day = ms => new Date(ms).toISOString().slice(0, 10);
  const level = p => (p >= 100 ? 'bad' : p >= 80 ? 'warn' : 'ok');
  async function snapshot(now = Date.now()) {
    const m = [], limit = Number(env.REDIS_MONTHLY_LIMIT) || 500000;
    const [used] = await redis([['HGET', usageKey, `m:${month(now)}`]]), cmds = Number(used) || 0;
    m.push({ key: 'storage', label: 'Storage commands this month', used: cmds, limit, unit: 'commands', pct: Math.round(100 * cmds / limit), note: 'A floor: the count is flushed every few minutes.', period: month(now) });
    try {
      const s = await support.settings(), mo = await support.month(now);
      if (s.budget && mo.cost !== null) m.push({ key: 'ai', label: 'AI spend this month', used: mo.cost, limit: s.budget, unit: '£', pct: Math.round(100 * mo.cost / s.budget), note: `${mo.answers} answers. The free coach rests at 100%, supporters at 150%.`, period: month(now) });
      else m.push({ key: 'ai', label: 'AI spend this month', used: mo.cost, limit: 0, unit: '£', pct: 0, note: s.budget ? 'No prices are set, so the cost cannot be worked out.' : 'No monthly budget is set (Admin → Supporters).', period: month(now) });
    } catch (e) { /* the AI meter is skipped */ }
    if (mail) { try { const u = await mail.usage(now); m.push({ key: 'email', label: 'Emails sent today', used: u.sentDay, limit: u.perDay, unit: 'emails', pct: u.perDay ? Math.round(100 * u.sentDay / u.perDay) : 0, note: `${u.sentHour} of ${u.perHour} this hour.${u.enabled ? '' : ' Email is switched off.'}`, period: day(now) }); } catch (e) { /* skipped */ } }
    return m.map(x => ({ ...x, level: x.limit ? level(x.pct) : 'off' }));
  }
  // Scheduled: a note to the admin channel at 80% and at 100% of the AI budget and the daily email limit (storage already has its own alerts).
  async function check(now = Date.now()) {
    for (const x of await snapshot(now)) {
      if (x.key === 'storage' || !x.limit) continue;
      for (const pct of [100, 80]) if (x.pct >= pct) {
        const [fresh] = await redis([['HSETNX', 'cg:alerts:cost', `${x.key}:${x.period}:${pct}`, new Date(now).toISOString()]]);
        if (fresh) await discord('admin', { content: `💰 **${x.label}:** ${x.pct}% used (${x.unit === '£' ? '£' + x.used + ' of £' + x.limit : x.used + ' of ' + x.limit + ' ' + x.unit}).${pct >= 100 ? ' The limit has been reached.' : ''}` }).catch(() => {});
        break;
      }
    }
    return [];
  }
  return { snapshot, check, routes: { 'GET /api/costs': async req => { requireRole(req, ['admin', 'mod']); return { meters: await snapshot() }; } } };
};

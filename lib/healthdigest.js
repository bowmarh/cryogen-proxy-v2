'use strict';
// A short weekly email to the owner (ALERT_EMAIL): what is wrong, who can race this week team by team, and what is waiting. It is the state of the club
// without opening the app. Counts only: no rider names. Sent once a week early on Monday (UK morning); an administrator can preview it or send it now.
module.exports = function createHealthDigest({ redis, HttpError, requireRole, overview, extra = async () => [], to = () => '', send, siteUrl = '', now = () => Date.now() }) {
  const DONE = 'cg:healthdigest:weeks', LAST = 'cg:healthdigest:last';
  const week = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / 86400000 + 1) / 7)).padStart(2, '0')}`; };
  async function compose() {
    const o = await overview(true), bad = o.systems.filter(s => s.level === 'bad'), amber = o.systems.filter(s => s.level === 'warn');
    const lines = [`Your CRYO-GEN week, ${new Date(now()).toISOString().slice(0, 10)}`, ''];
    lines.push(bad.length ? `NEEDS ATTENTION (${bad.length})` : amber.length ? `Working, with ${amber.length} thing${amber.length === 1 ? '' : 's'} to look at` : 'Everything is working.');
    for (const s of [...bad, ...amber]) lines.push(`  ${s.level === 'bad' ? '✗' : '!'} ${s.name}: ${s.detail}`);
    const r = o.race || {};
    if (r.round) {
      lines.push('', `${r.round}, week ${(r.week || 0) + 1}${r.date ? ` (${r.date})` : ''}: ${r.racing} to race per team`);
      for (const t of r.teams || []) lines.push(`  ${t.name}: ${t.yes} yes, ${t.maybe} maybe, ${t.no} no of ${t.riders}; line-up ${t.picked}/${r.racing}${t.short ? ` (${t.short} short)` : ''}${t.result ? `; result in${t.result.pos ? `: ${t.result.pos}` : ''}` : ''}`);
    } else lines.push('', 'No ZRL round is set up.');
    const more = await extra().catch(() => []); if (more.length) lines.push('', 'Errors and failing jobs', ...more.map(x => `  ${x}`));
    lines.push('', o.joinOpen ? `${o.joinOpen} join request${o.joinOpen === 1 ? ' is' : 's are'} waiting for you.` : 'No join requests waiting.', '', `Open the Control room: ${siteUrl}/`);
    return { subject: bad.length ? 'CRYO-GEN weekly: needs attention' : 'CRYO-GEN weekly: all well', body: lines.join('\n'), bad: bad.length };
  }
  async function sendNow() {
    const addr = to(); if (!addr) throw new HttpError(409, 'Set ALERT_EMAIL in Vercel to receive the weekly email.');
    const m = await compose(); await send({ to: addr, subject: m.subject, body: m.body });
    await redis([['SET', LAST, JSON.stringify({ at: new Date(now()).toISOString(), bad: m.bad })]]); return m;
  }
  // Scheduled: once each ISO week, from 06:00 UTC on Monday. A failed send (email off) is tried again at the next run the same morning, not repeated after it works.
  async function runSchedule(t = now()) {
    const d = new Date(t); if (d.getUTCDay() !== 1 || d.getUTCHours() < 6 || !to()) return [];
    const [first] = await redis([['HSETNX', DONE, week(t), new Date(t).toISOString()]]); if (!first) return [];
    try { await sendNow(); return ['health email']; } catch (e) { await redis([['HDEL', DONE, week(t)]]); return []; }
  }
  const routes = {
    'GET /api/healthdigest': async req => { requireRole(req, ['admin']); const [raw] = await redis([['GET', LAST]]); let last = null; try { last = raw ? JSON.parse(raw) : null; } catch (e) { /* none */ } return { configured: !!to(), last, preview: await compose() }; },
    'POST /api/healthdigest/send': async req => { requireRole(req, ['admin']); const m = await sendNow(); return { ok: true, subject: m.subject }; },
  };
  return { routes, compose, sendNow, runSchedule };
};

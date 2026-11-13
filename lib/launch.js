'use strict';
// Launch plan and "what needs fixing". The plan is an ordered list of the switches to turn on, one at a time, each with what must be true first (and the
// answer worked out live from the app's own state: owner login set, go-live checks passed, switches already on). "Needs fixing" gathers open bugs from the
// feedback button, new browser errors, red systems and failed jobs into one list; a short version is posted to the admin channel on Monday mornings.
module.exports = function createLaunch({ redis, requireRole, discord = async () => false, siteUrl = '', state }) {
  const WEEKS = 'cg:launch:weeks';
  const week = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / 86400000 + 1) / 7)).padStart(2, '0')}`; };
  // state: { ownerSet(), checks(), radio(), autoresults(), raceweek(), sitefeed(), wpsync(), joins(), systems(), feedback(), errors(), requests() }
  async function plan() {
    const [checks, radio, ar, rw, sf, wp] = await Promise.all([state.checks(), state.radio(), state.autoresults(), state.raceweek(), state.sitefeed(), state.wpsync()]);
    const joinsSeen = await state.joinsSeen(), ok = id => !!(checks[id] && checks[id].ok === true), steps = [];
    const add = (id, title, why, done, needs, where) => { const missing = needs.filter(n => !n.ok).map(n => n.text); steps.push({ id, title, why, where, status: done ? 'done' : missing.length ? 'blocked' : 'ready', blockedBy: done ? [] : missing }); };
    add('owner', 'Set the owner password', 'Keeps backups, money, access and the switches to you. Add OWNER_PASSWORD in Vercel and redeploy.', state.ownerSet(), [], 'Vercel → Environment Variables');
    add('golive', 'Run the go-live check', 'One real test per feature: email, Discord, the availability link, the PDF.', ['storage', 'email', 'discord-admin', 'discord-dm', 'pdf'].every(ok), [{ ok: state.ownerSet(), text: 'Set the owner password first' }], 'Control room → Go-live check');
    add('radio', 'Switch on the race radio', 'Posts each team result to Discord as it is entered.', radio.on, [{ ok: ok('discord-admin'), text: 'The admin Discord check must pass' }], 'AI desk → Radio & reports');
    add('results', 'Switch on automatic results', 'Reads your published results table on race day and the day after.', ar.on && !!ar.url, [{ ok: radio.on, text: 'Switch on the radio first (it announces what is read)' }], 'Control room → Results (use Test first)');
    add('autopilot', 'Switch on race-week autopilot', 'Asks for availability, reminds, and proposes a line-up for the captain to approve.', rw.on, [{ ok: ok('discord-dm'), text: 'The Discord DM check must pass' }, { ok: ok('rsvp'), text: 'The availability link check must pass' }], 'Control room → Now');
    add('website', 'Switch on website standings (as drafts)', 'Makes a draft post of the standings on cryogen.team after each race.', sf.on, [{ ok: state.wpConnected(), text: 'WordPress must be connected' }], 'Control room → Website');
    add('joins', 'Share the join page', 'Put /join.html (or the WordPress embed) where new riders will find it, then try one request yourself.', joinsSeen, [{ ok: ok('join'), text: 'The join form check must pass' }], 'Go-live check, then share the link');
    add('wpaccounts', 'Allow WordPress account creation', 'Only after you have handled one join request by hand and inspected the member plugin.', wp.on, [{ ok: joinsSeen, text: 'Handle one join request first' }], 'Control room → Website (Inspect the member plugin first)');
    const sec = state.security ? await state.security().catch(() => null) : null;
    if (sec) {
      add('alert', 'Set your alert email', 'Emails you when a job fails or a system goes red, and sends the Monday health email. Add ALERT_EMAIL in Vercel and redeploy.', sec.alertEmail, [], 'Vercel → Environment Variables');
      add('owner2fa', 'Turn on your authenticator app', 'The owner can do everything, so protect it with a second step. Save the recovery codes.', sec.ownerTotp, [{ ok: state.ownerSet(), text: 'Set the owner password first' }], 'Control room → Security');
      add('staffaccounts', 'Give every administrator a personal login', 'Each person signs in as themselves, with their own authenticator, and can reset their own password.', sec.personalAdmins > 0 && sec.personalNoMfa === 0, [{ ok: state.ownerSet(), text: 'Set the owner password first' }], 'Control room → Access, then Security');
      add('retire', 'Switch off the shared Administrator password', 'Once everyone has a personal login, the shared password is just a way in nobody can account for.', sec.adminSharedOff, [{ ok: sec.personalAdmins > 0 && sec.personalNoMfa === 0, text: 'Every administrator needs a personal login with an authenticator first' }], 'Control room → Security');
    }
    const done = steps.filter(s => s.status === 'done').length;
    return { steps, done, total: steps.length, next: steps.find(s => s.status !== 'done') || null };
  }
  async function issues() {
    const [sys, fb, errs, reqs, last] = await Promise.all([state.systems(), state.feedback(), state.errors(), state.requests(), state.lastErrors()]), out = [];
    for (const s of sys) if (s.level === 'bad') out.push({ level: 'bad', area: s.name, text: s.detail, where: 'Control room → Now' }); else if (s.level === 'warn') out.push({ level: 'warn', area: s.name, text: s.detail, where: 'Control room → Now' });
    for (const f of fb.filter(x => x.status === 'open' && x.kind === 'bug').slice(0, 5)) out.push({ level: f.priority === 'high' ? 'bad' : 'warn', area: 'Bug report', text: f.summary, where: 'Control room → Feedback' });
    for (const e of errs.filter(x => Date.now() - Date.parse(x.last) < 7 * 86400000).slice(0, 5)) out.push({ level: 'warn', area: 'Browser error', text: `${e.message} (${e.count}×${e.file ? ', ' + e.file : ''})`, where: 'Admin → Client errors' });
    for (const l of last) out.push({ level: 'warn', area: l.area, text: l.text, where: l.where });
    const open = reqs.filter(r => r.status === 'open').length; if (open) out.push({ level: 'info', area: 'Member requests', text: `${open} waiting for a volunteer`, where: 'Control room → Member requests' });
    const order = { bad: 0, warn: 1, info: 2 }; return out.sort((a, b) => order[a.level] - order[b.level]);
  }
  // Monday morning (from 8 UTC), once a week, only when there is something to say.
  async function runSchedule(now = Date.now()) {
    const d = new Date(now); if (d.getUTCDay() !== 1 || d.getUTCHours() < 8) return [];
    const [first] = await redis([['HSETNX', WEEKS, week(now), new Date(now).toISOString()]]); if (!first) return [];
    const [list, p] = await Promise.all([issues(), plan()]), real = list.filter(x => x.level !== 'info'); if (!real.length) return [];
    await discord('admin', { content: `🧰 **Weekly: what needs fixing** (${real.length})\n${real.slice(0, 8).map(x => `- ${x.area}: ${String(x.text).slice(0, 140)}`).join('\n')}${p.next ? `\nNext launch step: ${p.next.title}.` : ''}\n${siteUrl}` }).catch(() => {});
    return [];   // a digest, not an event
  }
  return { plan, issues, runSchedule, routes: { 'GET /api/launch': async req => { requireRole(req, ['admin', 'mod']); const [p, i] = await Promise.all([plan(), issues()]); return { plan: p, issues: i }; } } };
};

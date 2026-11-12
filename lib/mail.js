'use strict';
// Email for the club: staff write (or have the AI draft) a message, it is checked (fixed rules plus the AI), then an administrator approves it and it is sent
// to everyone, to a saved group, or to one person, a few at a time so the sending mailbox's limits are never exceeded. Addresses are the WordPress user
// accounts' emails, matched to club members. Every email carries an unsubscribe link; a person who unsubscribes is never emailed again for that kind.
// Two kinds: "news" (newsletters, club updates: stopped by an unsubscribe) and "service" (messages a member needs, such as race reminders: only a full
// "stop all" blocks these). Names never go to the AI: it writes {first} and the club puts the name in at send time.
const crypto = require('crypto');

module.exports = function createMail({ redis, HttpError, requireRole, staffNameOf = () => '', mailer, ai, fetchRoster, activeMembers, wpUsers = async () => [], segmentsOf = async () => new Set(),
  publicClub = async () => ({}), lifecycle = null, onboarding = null, discord = async () => false, secret = () => 'dev-secret', siteUrl = '' }) {
  const K = { settings: 'cg:mail:settings', groups: 'cg:mail:groups', camps: 'cg:mail:campaigns', rcpt: 'cg:mail:rcpt:', prog: 'cg:mail:prog:', optout: 'cg:mail:optout', map: 'cg:mail:map', names: 'cg:me:names',
    dir: 'cg:mail:dir', active: 'cg:mail:active', log: 'cg:mail:log', auto: 'cg:mail:auto', nh: 'cg:mail:n:h:', nd: 'cg:mail:n:d:' };
  const SEGMENT_LABELS = [['zrl', 'Riding in ZRL this round'], ['captains', 'ZRL team captains'], ['new', 'New members (last 30 days)'], ['quiet', 'Quiet members (45 to 180 days since a race)'], ['cat:A+', 'Category A+'], ['cat:A', 'Category A'], ['cat:B', 'Category B'], ['cat:C', 'Category C'], ['cat:D', 'Category D']];
  const DAY = 86400000, BATCH = 60, DIR_TTL = 6 * 3600000;
  const DEFAULTS = { enabled: false, fromName: 'CRYO-GEN', replyTo: '', footer: 'Team CRYO-GEN, a Zwift cycling club.', perHour: 30, perDay: 200, automations: { newsletter: { on: false, mode: 'approve' }, welcome: { on: false }, quiet: { on: false } } };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
  const ehash = e => sha(String(e).toLowerCase()).slice(0, 16);
  const norm = n => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nid = () => `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const isEmail = e => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(e || ''));
  const day = ms => new Date(ms).toISOString().slice(0, 10), hour = ms => new Date(ms).toISOString().slice(0, 13);
  const admin = req => requireRole(req, ['admin']), staff = req => requireRole(req, ['admin', 'mod']);

  // ── Settings ──
  async function settings() {
    const [raw] = await redis([['GET', K.settings]]), s = parse(raw) || {};
    return { ...DEFAULTS, ...s, automations: { ...DEFAULTS.automations, ...(s.automations || {}) } };
  }
  const saveSettings = s => redis([['SET', K.settings, JSON.stringify(s)]]);

  // ── Addresses: WordPress user accounts, matched to members by name (unique matches only), plus anything staff set by hand ──
  async function users(force = false) {
    const [raw] = await redis([['GET', K.dir]]), c = parse(raw);
    if (!force && c && Date.now() - c.at < DIR_TTL) return c;
    const list = (await wpUsers()).filter(u => u && isEmail(u.email)).map(u => ({ id: u.id, name: clean(u.name, 80), email: String(u.email).toLowerCase() }));
    const doc = { at: Date.now(), users: list }; await redis([['SET', K.dir, JSON.stringify(doc)]]); return doc;
  }
  async function directory(force = false) {
    const [{ members }, d, [mapRaw]] = await Promise.all([fetchRoster(), users(force), redis([['HGETALL', K.map]])]);
    const manual = new Map(pairs(mapRaw).map(([z, e]) => [z, e])), byName = new Map();
    for (const u of d.users) { const k = norm(u.name); if (k) byName.set(k, [...(byName.get(k) || []), u]); }
    const byZwid = new Map(), ambiguous = [], unmatched = [], names = new Map();
    for (const m of (Array.isArray(members) ? members : [])) {
      const z = String(m.zwift_id || '').trim(); if (!/^\d+$/.test(z) || m.status === 'left') continue;
      names.set(z, clean(m.name, 80));
      if (manual.has(z)) { byZwid.set(z, { email: manual.get(z), how: 'set by hand' }); continue; }
      const hit = byName.get(norm(m.name));
      if (hit && hit.length === 1) byZwid.set(z, { email: hit[0].email, how: 'matched by name' });
      else if (hit && hit.length > 1) ambiguous.push({ zwid: z, name: names.get(z) }); else unmatched.push({ zwid: z, name: names.get(z) });
    }
    return { byZwid, names, ambiguous, unmatched, wpUsers: d.users.length, at: d.at };
  }

  // ── Opt-outs and signed links ──
  const sign = p => crypto.createHmac('sha256', `${secret()}:mail`).update(p).digest('base64url').slice(0, 22);
  const tokenFor = (z, email) => { const p = Buffer.from(`${z}|${ehash(email)}`).toString('base64url'); return `${p}.${sign(p)}`; };
  function readToken(t) {
    const [p, sig] = String(t || '').split('.'); if (!p || !sig || sig !== sign(p)) return null;
    const [z, h] = Buffer.from(p, 'base64url').toString().split('|'); return z && h ? { zwid: z, hash: h } : null;
  }
  async function optouts() { const [raw] = await redis([['HGETALL', K.optout]]); return new Map(pairs(raw).map(([h, v]) => [h, (parse(v) || {}).scope || 'news'])); }

  // ── Writing: a small safe markup (paragraphs, **bold**, [text](https://link), - lists) to HTML and plain text ──
  function render(body, vars = {}) {
    const fill = t => String(t).replace(/\{first\}/g, vars.first || 'there').replace(/\{name\}/g, vars.name || 'there').replace(/\{rsvp\}/g, vars.rsvp || '');
    const inline = t => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (m, a, u) => `<a href="${u}" style="color:#0a7ea4">${a}</a>`);
    const blocks = fill(body).split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const html = blocks.map(b => (/^(- .*(\n|$))+$/.test(b) ? `<ul style="margin:0 0 14px 20px;padding:0">${b.split('\n').map(l => `<li style="margin:2px 0">${inline(l.slice(2))}</li>`).join('')}</ul>` : `<p style="margin:0 0 14px">${inline(b).replace(/\n/g, '<br/>')}</p>`)).join('');
    const text = blocks.map(b => b.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '$1 ($2)')).join('\n\n');
    return { html, text };
  }
  async function compose(camp, to, s) {
    const first = String(to.n || '').split(/\s+/)[0] || 'there', r = render(camp.body, { first, name: to.n, rsvp: `${siteUrl}/api/rsvp?t=${tokenFor(to.z || '0', to.e)}` }), link = `${siteUrl}/api/mail/unsubscribe?t=${tokenFor(to.z || '0', to.e)}`;
    const why = camp.category === 'service' ? 'You are getting this because you are a member of the club.' : 'You are getting this because you are a member of the club and have not opted out of club news.';
    const foot = `${s.footer} ${why}`;
    const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f2937;max-width:600px;margin:0 auto;padding:8px">${r.html}<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0 10px"/><p style="font-size:12px;color:#6b7280;margin:0">${esc(foot)} <a href="${esc(link)}" style="color:#6b7280">Unsubscribe or manage emails</a>.</p></div>`;
    const text = `${r.text}\n\n--\n${foot}\nUnsubscribe or manage emails: ${link}`;
    return { subject: clean(camp.subject, 200), html, text, fromName: s.fromName, replyTo: s.replyTo || undefined };
  }

  // ── Checks: fixed rules, then the AI (a second opinion; it can fail or be off without blocking) ──
  function rules(subject, body, category) {
    const out = [], add = (level, text) => out.push({ level, text }), b = String(body || ''), sub = String(subject || '');
    if (!sub.trim()) add('error', 'The subject is empty.'); else if (sub.length > 90) add('warn', 'The subject is long: it will be cut off on a phone (aim for under 60 characters).');
    if (!b.trim()) add('error', 'The message is empty.'); else if (b.length > 6000) add('warn', 'The message is very long: consider splitting it or linking to a page.');
    for (const m of new Set(b.match(/\{[^}]*\}/g) || [])) if (!['{first}', '{name}', '{rsvp}'].includes(m)) add('error', `${m} is a placeholder that will not be filled in. Only {first}, {name} and {rsvp} (the rider's own availability link) are.`);
    for (const m of new Set(b.match(/\bhttp:\/\/[^\s)]+/g) || [])) add('error', `${m} is not a secure link: use https.`);
    const links = (b.match(/\]\(https:\/\//g) || []).length; if (links > 8) add('warn', `There are ${links} links: emails with many links are more likely to be marked as spam.`);
    const letters = (sub + b).replace(/[^A-Za-z]/g, ''), caps = letters.replace(/[^A-Z]/g, '').length; if (letters.length > 40 && caps / letters.length > 0.3) add('warn', 'A lot of the text is in capitals, which looks like spam.');
    if ((sub.match(/!/g) || []).length > 1 || (b.match(/!/g) || []).length > 6) add('warn', 'Many exclamation marks make an email look like spam.');
    for (const w of ['free money', 'act now', 'click here', '100% free', 'guaranteed', 'winner', 'urgent!!!']) if (new RegExp(w, 'i').test(sub + ' ' + b)) add('warn', `"${w}" is a typical spam phrase.`);
    return out;
  }
  async function aiCheck(subject, body, category) {
    if (!ai.enabled()) return { ran: false, note: 'The AI check is off (no ANTHROPIC_API_KEY): only the fixed rules were applied.' };
    try {
      const text = await ai.complete({ kind: 'mailcheck', cap: 120, supporter: false, maxTokens: 1200, system: 'You proofread emails for a friendly, volunteer-run Zwift cycling club. Check ONLY: spelling and grammar, clarity, tone (warm, plain, never scolding or accusing anyone), claims that sound made up or cannot be checked, anything that looks like personal data about one rider in a message to many, and anything misleading. The club adds an unsubscribe footer itself and fills {first} with the first name. Reply with JSON only: {"verdict":"ok" or "fix","issues":[{"level":"error" or "warn","text":"..."}],"suggestion":"one short sentence, or empty"}. "error" is only for something that must not be sent as written.', user: `Kind: ${category === 'service' ? 'a service message members need' : 'club news'}\nSubject: ${subject}\n\n${body}` });
      const j = ai.json(text) || {};
      return { ran: true, verdict: j.verdict === 'fix' ? 'fix' : 'ok', issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 8).map(i => ({ level: i.level === 'error' ? 'error' : 'warn', text: clean(i.text, 300) })).filter(i => i.text), suggestion: clean(j.suggestion, 300) };
    } catch (e) { return { ran: false, note: `The AI check could not run (${clean(e.message, 120)}): only the fixed rules were applied.` }; }
  }
  const hashOf = c => sha(`${c.subject}\n${c.body}\n${c.category}`);

  // ── Drafting with the AI: names never go in, {first} does ──
  async function draft({ brief, kind = 'announcement', facts = [] }) {
    const text = await ai.complete({ kind: 'maildraft', cap: 60, supporter: false, maxTokens: 1800, system: `You write emails for Team CRYO-GEN, a friendly volunteer-run Zwift cycling club (ZRL, team time trials, social rides, a Ladder and a DIRT series). Voice: warm, plain, upbeat, like a club captain: short paragraphs, no jargon, no hype, no more than one emoji. Start with "Hi {first}," (the club fills in the name). Use only the facts you are given; never invent dates, results, names or numbers. You may use **bold**, "- " bullet lists and links written [text](https://...). Do not add an unsubscribe line or a sign-off address: the club adds those. Reply with JSON only: {"subject":"under 60 characters","body":"the email"}. Kind of email: ${kind}.`, user: `What the email should say:\n${clean(brief, 1500)}\n\nFacts you may use (nothing else):\n${facts.map(f => '- ' + clean(f, 300)).join('\n') || '(none given)'}` });
    const j = ai.json(text); if (!j || !j.subject || !j.body) throw new HttpError(502, 'The AI did not give a usable draft. Please try again.');
    return { subject: clean(j.subject, 120), body: String(j.body).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, 8000).trim() };
  }

  // ── Who gets it ──
  async function groupList() { const [raw] = await redis([['HGETALL', K.groups]]); return pairs(raw).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)); }
  async function recipients(audience, category) {
    const [dir, out, all, pn] = await Promise.all([directory(), optouts(), activeMembers().catch(() => []), redis([['HGETALL', 'cg:me:names']]).then(r => Object.fromEntries(pairs(r[0])))]);
    let zw;
    if (audience.type === 'people') zw = new Set((audience.zwids || []).map(String));
    else if (audience.type === 'group') {
      const g = (await groupList()).find(x => x.id === audience.group); if (!g) throw new HttpError(404, 'That group is not there any more.');
      zw = new Set((g.zwids || []).map(String)); for (const sname of g.segments || []) for (const z of await segmentsOf(sname)) zw.add(String(z));
    } else zw = new Set(all.map(String));
    const live = new Set(all.map(String)), list = [], seen = new Set(); let noEmail = 0, optedOut = 0;
    for (const z of zw) {
      if (!live.has(z)) continue;
      const d = dir.byZwid.get(z); if (!d) { noEmail++; continue; }
      const h = ehash(d.email), scope = out.get(h);
      if (scope === 'all' || (scope === 'news' && category === 'news')) { optedOut++; continue; }
      if (seen.has(h)) continue; seen.add(h);
      list.push({ z, e: d.email, n: pn[z] || dir.names.get(z) || '' });
    }
    return { list, noEmail, optedOut, considered: zw.size };
  }
  async function estimate(count) { const s = await settings(); const perDay = Math.max(1, Math.min(s.perDay, s.perHour * 24)); return { perHour: s.perHour, perDay, days: count ? Math.ceil(count / perDay) : 0 }; }

  // ── Campaigns ──
  async function load(id) { const [raw] = await redis([['HGET', K.camps, String(id)]]); const c = parse(raw); if (!c) throw new HttpError(404, 'That email is not there.'); return c; }
  const save = c => redis([['HSET', K.camps, c.id, JSON.stringify(c)]]);
  async function registry() { const [raw] = await redis([['GET', K.active]]); const r = parse(raw) || {}; return { sending: r.sending || [], scheduled: r.scheduled || [] }; }
  const saveRegistry = r => redis([['SET', K.active, JSON.stringify(r)]]);
  const audienceOf = a => (a && a.type === 'group' ? { type: 'group', group: String(a.group || '') } : a && a.type === 'people' ? { type: 'people', zwids: (a.zwids || []).map(String).filter(z => /^\d+$/.test(z)).slice(0, 500) } : { type: 'all' });

  async function create(body, who) {
    const c = { id: nid(), subject: clean(body.subject, 200), body: String(body.body || '').slice(0, 8000), category: body.category === 'service' ? 'service' : 'news', audience: audienceOf(body.audience), status: 'draft', source: clean(body.source || 'manual', 20), createdBy: who, createdAt: new Date().toISOString(), counts: { total: 0, sent: 0, failed: 0 } };
    await save(c); return c;
  }
  async function check(c) {
    const fixed = rules(c.subject, c.body, c.category), ai_ = await aiCheck(c.subject, c.body, c.category);
    const issues = [...fixed, ...(ai_.issues || [])];
    c.check = { at: new Date().toISOString(), hash: hashOf(c), issues, ai: { ran: !!ai_.ran, verdict: ai_.verdict || null, note: ai_.note || '', suggestion: ai_.suggestion || '' }, ok: !issues.some(i => i.level === 'error') };
    await save(c); return c.check;
  }
  async function start(c, who, sendAt) {
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, 'Only a draft can be approved.');
    if (!c.check || c.check.hash !== hashOf(c)) throw new HttpError(409, 'Run the check on the current wording first (it changed since the last check).');
    if (!c.check.ok) throw new HttpError(409, 'The check found a problem that must be fixed before this can be sent.');
    if (!mailer.status().configured) throw new HttpError(409, 'No email service is set up yet (see docs/EMAIL-SETUP.md).');
    const rc = await recipients(c.audience, c.category); if (!rc.list.length) throw new HttpError(409, 'Nobody would receive this: no one in that audience has an email address that is not opted out.');
    c.counts.total = rc.list.length; c.approvedBy = who; c.approvedAt = new Date().toISOString(); c.skipped = { noEmail: rc.noEmail, optedOut: rc.optedOut };
    await redis([['SET', K.rcpt + c.id, JSON.stringify(rc.list)], ['SET', K.prog + c.id, JSON.stringify({ next: 0, sent: 0, failed: [] })]]);
    const reg = await registry(); reg.sending = reg.sending.filter(x => x !== c.id); reg.scheduled = reg.scheduled.filter(x => x.id !== c.id);
    if (sendAt && sendAt > Date.now() + 60000) { c.status = 'scheduled'; c.sendAt = new Date(sendAt).toISOString(); reg.scheduled.push({ id: c.id, at: sendAt }); } else { c.status = 'sending'; delete c.sendAt; reg.sending.push(c.id); }
    await Promise.all([save(c), saveRegistry(reg)]); return c;
  }

  // ── Sending ──
  async function allowance(s, now) {
    const [h, d] = await redis([['GET', K.nh + hour(now)], ['GET', K.nd + day(now)]]);
    return Math.max(0, Math.min(s.perHour - (Number(h) || 0), s.perDay - (Number(d) || 0), BATCH));
  }
  const counted = (n, now) => (n ? redis([['INCRBY', K.nh + hour(now), n], ['EXPIRE', K.nh + hour(now), 7200], ['INCRBY', K.nd + day(now), n], ['EXPIRE', K.nd + day(now), 172800]]) : null);
  const logLine = e => redis([['LPUSH', K.log, JSON.stringify({ at: new Date().toISOString(), ...e })], ['LTRIM', K.log, 0, 299]]);

  async function pump(c, s, now, limit = Infinity) {
    const [rawR, rawP] = await redis([['GET', K.rcpt + c.id], ['GET', K.prog + c.id]]), list = parse(rawR) || [], p = parse(rawP) || { next: 0, sent: 0, failed: [] };
    let room = Math.min(await allowance(s, now), limit), used = 0, bad = 0, pausedWhy = '';
    const out = await optouts();
    while (room > 0 && p.next < list.length) {
      const to = list[p.next], sc = out.get(ehash(to.e));
      if (sc === 'all' || (sc === 'news' && c.category === 'news')) { p.next++; continue; }   // opted out since it was approved
      try { await mailer.send({ ...(await compose(c, to, s)), to: to.e }); p.sent++; used++; room--; bad = 0; p.next++; }
      catch (e) {
        if (e.retryable) { bad++; if (bad >= 3) { pausedWhy = e.message; break; } continue; }
        p.failed.push({ z: to.z, why: clean(e.message, 120) }); p.failed = p.failed.slice(-50); used++; room--; p.next++;
      }
    }
    c.counts.sent = p.sent; c.counts.failed = p.failed.length;
    const reg = await registry();
    if (pausedWhy) { c.status = 'paused'; c.error = pausedWhy; reg.sending = reg.sending.filter(x => x !== c.id); await discord('admin', { content: `⚠️ **Email paused:** "${clean(c.subject, 80)}" stopped after ${p.sent} of ${c.counts.total} because the email service kept refusing: ${clean(pausedWhy, 160)}. Open ${siteUrl}/ → Email to resume.` }).catch(() => {}); }
    else if (p.next >= list.length) { c.status = 'sent'; c.sentAt = new Date(now).toISOString(); reg.sending = reg.sending.filter(x => x !== c.id); await discord('admin', { content: `✉️ **Email sent:** "${clean(c.subject, 80)}" went to ${p.sent} member${p.sent === 1 ? '' : 's'}${p.failed.length ? ` (${p.failed.length} could not be sent)` : ''}.` }).catch(() => {}); await logLine({ campaign: c.id, subject: clean(c.subject, 80), sent: p.sent, failed: p.failed.length }); }
    await Promise.all([redis([['SET', K.prog + c.id, JSON.stringify(p)]]), save(c), saveRegistry(reg), counted(used, now)]);
    return used;
  }
  async function sendOne({ z, e, n, subject, body, category = 'service' }, s, now = Date.now()) {
    const out = await optouts(), sc = out.get(ehash(e));
    if (sc === 'all' || (sc === 'news' && category === 'news')) throw new HttpError(409, 'That person has opted out of these emails.');
    if ((await allowance(s, now)) < 1) throw new HttpError(429, 'The sending limit for this hour or day has been reached. Try again later.');
    await mailer.send({ ...(await compose({ subject, body, category }, { z, e, n }, s)), to: e }); await counted(1, now);
  }

  // ── The scheduled job: due campaigns, then the automations ──
  const london = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { dow: p.weekday, hour: Number(p.hour) }; };
  const isoWeek = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / DAY + 1) / 7)).padStart(2, '0')}`; };
  const once = async (key, now) => (await redis([['HSETNX', K.auto, key, new Date(now).toISOString()]]))[0];

  async function runSchedule(now = Date.now()) {
    const done = [], s = await settings(); if (!s.enabled || !mailer.status().configured) return done;
    const reg = await registry(), due = reg.scheduled.filter(x => x.at <= now);
    if (due.length) { for (const x of due) { const c = await load(x.id).catch(() => null); if (c && c.status === 'scheduled') { c.status = 'sending'; reg.sending.push(c.id); await save(c); } } reg.scheduled = reg.scheduled.filter(x => x.at > now); await saveRegistry(reg); }
    for (const id of reg.sending.slice(0, 1)) { const c = await load(id).catch(() => null); if (c && c.status === 'sending') { const n = await pump(c, s, now); if (n) done.push(`email-${n}`); } }
    const A = s.automations;
    if (A.newsletter.on) { const t = london(now); if (t.dow === 'Mon' && t.hour >= 8 && await once(`newsletter:${isoWeek(now)}`, now)) { await weeklyDraft(s, now).catch(e => console.error('Newsletter draft:', e.message)); done.push('email-newsletter'); } }
    if (A.welcome.on && onboarding) { let n = 0; for (const m of (await onboarding.scan(now)).filter(x => x.days <= 1).slice(0, 20)) { if (!(await once(`welcome:${m.zwid}`, now))) continue; const d = (await directory()).byZwid.get(String(m.zwid)); if (!d) continue; try { await sendOne({ z: m.zwid, e: d.email, n: m.name, subject: 'Welcome to CRYO-GEN', body: WELCOME, category: 'service' }, s, now); n++; } catch (e) { /* the limit or an opt-out: not retried */ } } if (n) done.push(`email-welcome-${n}`); }
    if (A.quiet.on && lifecycle) { let n = 0; const dir = await directory(); for (const m of (await lifecycle.quiet(now)).slice(0, 10)) { const d = dir.byZwid.get(String(m.zwid)); if (!d || !(await once(`quiet:${m.zwid}:${Math.floor(now / (60 * DAY))}`, now))) continue; try { await sendOne({ z: m.zwid, e: d.email, n: m.name, subject: 'We miss you on the road', body: QUIET, category: 'news' }, s, now); n++; } catch (e) { /* ditto */ } } if (n) done.push(`email-quiet-${n}`); }
    return done;
  }
  const WELCOME = "Hi {first},\n\nWelcome to Team CRYO-GEN! We are really glad you have joined.\n\nThe quickest way to get started is to open the club app, tick off the first-race checklist and sign up for the next team race or social ride:\n\n- [Open the club app](https://club.cryo-gen.team)\n- Link your Discord in My Profile so captains and ride leaders can reach you\n\nIf you get stuck, just reply to this email or say hello in the club Discord.\n\nSee you on the road,\nTeam CRYO-GEN";
  const QUIET = "Hi {first},\n\nWe have not seen you race for a little while and wanted to say hello. No pressure at all: there is always a spot for you, whether that is a team race, the Ladder or an easy social ride.\n\n[See what is coming up](https://club.cryo-gen.team)\n\nIf something got in the way (a trainer, a schedule, motivation), tell us and we will help where we can.\n\nTeam CRYO-GEN";
  async function weeklyDraft(s, now) {
    const pc = await publicClub(now).catch(() => ({})), facts = [];
    for (const n of (pc.next || []).slice(0, 8)) facts.push(`Coming up: ${n.series}: ${n.title} (${n.date})`);
    for (const g of pc.podium || []) if (g.top && g.top[0]) facts.push(`ZRL ${g.division}: ${g.top.map(t => `${t.rank}. ${t.team} (${t.points} points)`).join(', ')}`);
    let subject = 'This week at CRYO-GEN', body = `Hi {first},\n\nHere is what is coming up at the club this week:\n\n${(pc.next || []).slice(0, 8).map(n => `- ${n.series}: ${n.title} (${n.date})`).join('\n') || '- No races are scheduled yet.'}\n\n[Open the club app](https://club.cryo-gen.team) to sign up or check your team.\n\nTeam CRYO-GEN`;
    if (ai.enabled() && facts.length) { try { const d = await draft({ brief: 'The club\'s weekly newsletter: what is coming up this week and how the teams are doing. Friendly and short.', kind: 'weekly newsletter', facts }); subject = d.subject; body = d.body; } catch (e) { /* the plain template stands */ } }
    const c = await create({ subject, body, category: 'news', audience: { type: 'all' }, source: 'newsletter' }, 'automatic');
    const ck = await check(c);
    if (s.automations.newsletter.mode === 'auto' && ck.ok && !ck.issues.some(i => i.level === 'warn' && i.text.length)) { await start(c, 'automatic', null); await discord('admin', { content: `📰 **Newsletter approved automatically** (it passed the checks) and is going out over the next few days. Open ${siteUrl}/ → Email to look.` }).catch(() => {}); }
    else await discord('admin', { content: `📰 **A newsletter draft is ready** for this week${ck.ok ? '' : ' (it needs fixing before it can be sent)'}. Open ${siteUrl}/ → Email → Drafts to read, change and approve it.` }).catch(() => {});
  }

  // ── Unsubscribe (public) ──
  async function unsubscribe(token, scope) {
    const t = readToken(token); if (!t) throw new HttpError(400, 'That link is not valid. Please use the link in your latest email.');
    if (scope === 'on') { await redis([['HDEL', K.optout, t.hash]]); return { ok: true, scope: 'on' }; }   // choosing everything again undoes an earlier opt-out
    await redis([['HSET', K.optout, t.hash, JSON.stringify({ scope: scope === 'all' ? 'all' : 'news', at: new Date().toISOString() })]]); return { ok: true, scope: scope === 'all' ? 'all' : 'news' };
  }
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#060a14;color:#e5e7eb;margin:0;padding:24px}main{max-width:480px;margin:40px auto;background:#0f1623;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:22px}h1{font-size:20px;margin:0 0 10px}p{line-height:1.5;color:#d1d5db}button{font:inherit;font-weight:700;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:#00D4FF;color:#06101c;cursor:pointer;margin:6px 8px 6px 0}button.o{background:transparent;color:#e5e7eb}</style></head><body><main>${body}</main></body></html>`;
  const unsubscribePage = token => page('Email preferences', readToken(token) ? `<h1>Email preferences</h1><p>Choose which emails you would like from the club. You can still use the club app and Discord as normal, and you can come back to this page from any club email to change your mind.</p><form method="post"><input type="hidden" name="t" value="${esc(token)}"/><button name="scope" value="news">Stop newsletters and club news</button><button class="o" name="scope" value="all">Stop all emails from the club app</button><button class="o" name="scope" value="on">Turn everything back on</button></form>` : '<h1>Link not valid</h1><p>Please use the link in your latest email, or ask an administrator.</p>');
  const donePage = scope => page('Done', `<h1>Done</h1><p>${scope === 'on' ? 'You will get club news and team emails again. Thank you!' : scope === 'all' ? 'You will not get any more emails from the club app.' : 'You will not get newsletters or club news by email any more. You may still get messages you need as a member, such as race reminders.'}</p>`);

  // ── Routes ──
  const routes = {
    'GET /api/mail': async req => {
      staff(req);
      const [s, camps, groups, [logRaw], dir] = await Promise.all([settings(), redis([['HGETALL', K.camps]]).then(r => pairs(r[0]).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60)), groupList(), redis([['LRANGE', K.log, 0, 19]]), directory().catch(e => ({ error: e.message }))]);
      const st = mailer.status(), members = dir.names ? dir.names.size : 0;
      return { segments: SEGMENT_LABELS, settings: s, provider: st.provider || '', configured: st.configured, campaigns: camps.map(c => ({ ...c, body: undefined, hasBody: true })), groups, log: (logRaw || []).map(parse), addresses: dir.error ? { error: dir.error } : { members, withEmail: dir.byZwid.size, ambiguous: dir.ambiguous.length, unmatched: dir.unmatched.length, wpUsers: dir.wpUsers, at: dir.at } };
    },
    'GET /api/mail/campaign': async (req, b, q) => { staff(req); return { campaign: await load(String(q.id || '')) }; },
    'GET /api/mail/addresses': async req => { admin(req); const d = await directory(true); return { withEmail: d.byZwid.size, wpUsers: d.wpUsers, ambiguous: d.ambiguous.slice(0, 100), unmatched: d.unmatched.slice(0, 100) }; },
    'POST /api/mail/address': async (req, body) => {
      admin(req); const z = String(body.zwid || '').trim(), e = String(body.email || '').trim().toLowerCase();
      if (!/^\d{1,10}$/.test(z)) throw new HttpError(400, 'Enter the rider\'s Zwift ID (numbers only).');
      if (!e) { await redis([['HDEL', K.map, z]]); return { ok: true, removed: true }; }
      if (!isEmail(e)) throw new HttpError(400, 'That is not an email address.'); await redis([['HSET', K.map, z, e]]); return { ok: true };
    },
    'POST /api/mail/settings': async (req, body) => {
      admin(req); const cur = await settings(), n = { ...cur };
      if (typeof body.enabled === 'boolean') n.enabled = body.enabled;
      if (body.fromName != null) n.fromName = clean(body.fromName, 60) || cur.fromName;
      if (body.replyTo != null) { const r = String(body.replyTo).trim(); if (r && !isEmail(r)) throw new HttpError(400, 'The reply-to address is not an email address.'); n.replyTo = r; }
      if (body.footer != null) n.footer = clean(body.footer, 240);
      for (const k of ['perHour', 'perDay']) if (body[k] != null) { const v = Number(body[k]); if (!Number.isInteger(v) || v < 1 || v > 5000) throw new HttpError(400, 'Limits are whole numbers from 1 to 5000.'); n[k] = v; }
      if (body.automations) for (const k of Object.keys(DEFAULTS.automations)) if (body.automations[k]) { const a = body.automations[k]; n.automations[k] = { ...n.automations[k], ...(typeof a.on === 'boolean' ? { on: a.on } : {}), ...(k === 'newsletter' && ['approve', 'auto'].includes(a.mode) ? { mode: a.mode } : {}) }; }
      await saveSettings(n); return { settings: n };
    },
    'POST /api/mail/group': async (req, body) => {
      admin(req); const name = clean(body.name, 60); if (!name) throw new HttpError(400, 'Give the group a name.');
      const g = { id: body.id ? String(body.id) : nid(), name, segments: (Array.isArray(body.segments) ? body.segments : []).map(x => clean(x, 30)).filter(Boolean).slice(0, 20), zwids: (Array.isArray(body.zwids) ? body.zwids : []).map(String).filter(z => /^\d+$/.test(z)).slice(0, 1000) };
      await redis([['HSET', K.groups, g.id, JSON.stringify(g)]]); return { group: g };
    },
    'POST /api/mail/group-delete': async (req, body) => { admin(req); await redis([['HDEL', K.groups, String(body.id || '')]]); return { ok: true }; },
    'POST /api/mail/audience': async (req, body) => { staff(req); const category = body.category === 'service' ? 'service' : 'news', r = await recipients(audienceOf(body.audience), category); return { count: r.list.length, noEmail: r.noEmail, optedOut: r.optedOut, estimate: await estimate(r.list.length) }; },
    'POST /api/mail/draft': async (req, body) => { staff(req); if (!clean(body.brief, 1500)) throw new HttpError(400, 'Say what the email should be about.'); return draft({ brief: body.brief, kind: clean(body.kind, 40) || 'announcement', facts: Array.isArray(body.facts) ? body.facts.slice(0, 12) : [] }); },
    // The preview shows the first real recipient's name when the audience is known (so "Hi Rick" for yourself), a sample name otherwise.
    'POST /api/mail/preview': async (req, body) => {
      staff(req); const s = await settings(), c = { subject: clean(body.subject, 200), body: String(body.body || ''), category: body.category === 'service' ? 'service' : 'news' };
      let who = { z: '0', e: 'preview@example.com', n: 'Alex Example' }, as = '';
      if (body.audience) { try { const r = await recipients(audienceOf(body.audience), c.category); if (r.list[0]) { who = { z: r.list[0].z, e: 'preview@example.com', n: r.list[0].n }; as = r.list[0].n; } } catch (e) { /* the sample name stands */ } }
      const m = await compose(c, who, s); return { subject: m.subject, html: m.html, text: m.text, as };
    },
    // Find members by name or Zwift ID, for picking individual riders.
    'GET /api/mail/find': async (req, b, q) => {
      staff(req); const term = String(q.q || '').trim().toLowerCase(); if (term.length < 2 && !/^\d+$/.test(term)) return { matches: [] };
      const dir = await directory(), out = [];
      for (const [z, n] of dir.names) { if (z.startsWith(term) || String(n).toLowerCase().includes(term)) out.push({ zwid: z, name: n, hasEmail: dir.byZwid.has(z) }); if (out.length >= 12) break; }
      return { matches: out };
    },
    'POST /api/mail/save': async (req, body) => {
      staff(req); let c;
      if (body.id) { c = await load(String(body.id)); if (c.status !== 'draft') throw new HttpError(409, 'Only a draft can be changed.'); Object.assign(c, { subject: clean(body.subject, 200), body: String(body.body || '').slice(0, 8000), category: body.category === 'service' ? 'service' : 'news', audience: audienceOf(body.audience) }); delete c.check; await save(c); }
      else c = await create(body, staffNameOf(req) || 'staff');
      return { campaign: c };
    },
    'POST /api/mail/check': async (req, body) => { staff(req); const c = await load(String(body.id || '')); return { check: await check(c) }; },
    'POST /api/mail/approve': async (req, body) => { admin(req); const c = await load(String(body.id || '')), at = body.sendAt ? Date.parse(body.sendAt) : 0; if (body.sendAt && Number.isNaN(at)) throw new HttpError(400, 'That send time is not a date.'); const started = await start(c, staffNameOf(req) || 'admin', at);
      // The scheduled job only runs hourly, so a tiny send (a note to yourself, a few riders) goes now; bigger ones follow on the job's runs within the limits.
      if (started.status === 'sending' && started.counts.total <= 5) await pump(started, await settings(), Date.now()).catch(e => console.error('Email first batch:', e.message));
      return { campaign: await load(started.id) };
    },
    'POST /api/mail/cancel': async (req, body) => { admin(req); const c = await load(String(body.id || '')); if (!['scheduled', 'sending', 'paused', 'draft'].includes(c.status)) throw new HttpError(409, 'That email has already gone out.'); c.status = 'cancelled'; const r = await registry(); r.sending = r.sending.filter(x => x !== c.id); r.scheduled = r.scheduled.filter(x => x.id !== c.id); await Promise.all([save(c), saveRegistry(r)]); return { campaign: c }; },
    'POST /api/mail/resume': async (req, body) => { admin(req); const c = await load(String(body.id || '')); if (c.status !== 'paused') throw new HttpError(409, 'That email is not paused.'); c.status = 'sending'; delete c.error; const r = await registry(); r.sending.push(c.id); await Promise.all([save(c), saveRegistry(r)]); return { campaign: c }; },
    'POST /api/mail/test': async (req, body) => {
      admin(req); const to = String(body.to || '').trim(); if (!isEmail(to)) throw new HttpError(400, 'Enter the address to send the test to.');
      const s = await settings(); try { await mailer.send({ ...(await compose({ subject: `[Test] ${clean(body.subject, 150) || 'Test email'}`, body: String(body.body || 'This is a test email from the club app.'), category: 'service' }, { z: '0', e: to, n: 'Test' }, s)), to }); } catch (e) { throw new HttpError(e.status === 400 ? 400 : 502, e.message); }
      return { ok: true };
    },
    'POST /api/mail/send-one': async (req, body) => {
      admin(req); const z = String(body.zwid || '').trim(), s = await settings(); if (!s.enabled) throw new HttpError(409, 'Email is switched off: turn it on in the Email settings first.'); if (!mailer.status().configured) throw new HttpError(409, 'No email service is set up yet.');
      const d = (await directory()).byZwid.get(z); if (!d) throw new HttpError(404, 'There is no email address for that rider.');
      const c = { subject: clean(body.subject, 200), body: String(body.body || '').slice(0, 8000), category: body.category === 'news' ? 'news' : 'service' }, ck = rules(c.subject, c.body, c.category).filter(i => i.level === 'error'); if (ck.length) throw new HttpError(409, ck[0].text);
      await sendOne({ z, e: d.email, n: (await directory()).names.get(z) || '', ...c }, s); await logLine({ one: z, subject: clean(c.subject, 80) }); return { ok: true };
    },
  };
  // For other features: a draft for staff to approve in the Email page (never sent by this call).
  async function createDraft({ subject, body, category, zwids, who }) { return create({ subject, body, category, audience: { type: 'people', zwids }, source: 'ai-desk' }, who); }
  // One email to an address that is not in the member list (for example a join request): same limits, still an administrator's decision to call it.
  async function sendDirect({ to, name, subject, body }) {
    const s = await settings(); if (!s.enabled || !mailer.status().configured) throw new HttpError(409, 'Email is off or no email service is set up.');
    if (!isEmail(String(to || '').trim())) throw new HttpError(400, 'That is not an email address.');
    await sendOne({ z: '0', e: String(to).trim().toLowerCase(), n: name, subject, body, category: 'service' }, s);
  }
  // A one-line health picture for the control room.
  async function health() {
    const s = await settings(), st = mailer.status(), [raw] = await redis([['HGETALL', K.camps]]), camps = pairs(raw).map(([, v]) => parse(v)).filter(Boolean);
    const dir = await directory().catch(e => ({ error: e.message }));
    return { configured: !!st.configured, provider: st.provider || '', enabled: !!s.enabled, paused: camps.filter(c => c.status === 'paused').map(c => ({ id: c.id, subject: c.subject, error: c.error || '' })), sending: camps.filter(c => c.status === 'sending').length, addresses: dir.error ? { error: dir.error } : { withEmail: dir.byZwid.size, members: dir.names.size } };
  }
  // One email to a known member (their address from the member list), counted against the limits; opted-out members are refused by sendOne.
  async function sendTo({ zwid, subject, body, category = 'news' }) {
    const s = await settings(); if (!s.enabled || !mailer.status().configured) throw new HttpError(409, 'Email is off or no email service is set up.');
    const dir = await directory(), d = dir.byZwid.get(String(zwid)); if (!d) throw new HttpError(404, 'There is no email address for that rider.');
    const [pn] = await redis([['HGET', 'cg:me:names', String(zwid)]]);
    await sendOne({ z: String(zwid), e: d.email, n: pn || dir.names.get(String(zwid)) || '', subject, body, category }, s);
  }
  async function usage(now = Date.now()) { const s = await settings(), [h, d] = await redis([['GET', K.nh + hour(now)], ['GET', K.nd + day(now)]]); return { sentHour: Number(h) || 0, sentDay: Number(d) || 0, perHour: s.perHour, perDay: s.perDay, enabled: !!s.enabled }; }
  const everyone = category => recipients({ type: 'all' }, category);
  // A member's own choice about our emails, kept as the same one-way-hashed opt-out the unsubscribe link uses.
  const mask = e => { const [u, d] = String(e).split('@'); return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`; };
  async function prefsOf(zwid) {
    const d = (await directory()).byZwid.get(String(zwid)); if (!d) return { known: false };
    const sc = (await optouts()).get(ehash(d.email)); return { known: true, email: mask(d.email), choice: sc === 'all' ? 'all' : sc === 'news' ? 'news' : 'on' };
  }
  async function setPrefs(zwid, choice) {
    const d = (await directory()).byZwid.get(String(zwid)); if (!d) throw new HttpError(404, 'We have no email address for you yet.');
    if (choice === 'on') await redis([['HDEL', K.optout, ehash(d.email)]]); else if (['news', 'all'].includes(choice)) await redis([['HSET', K.optout, ehash(d.email), JSON.stringify({ scope: choice, at: new Date().toISOString() })]]); else throw new HttpError(400, 'Choose everything, only emails I need, or none.');
  }
  async function optOutAddress(email, scope) { await redis([['HSET', K.optout, ehash(String(email).trim().toLowerCase()), JSON.stringify({ scope: scope === 'all' ? 'all' : 'news', at: new Date().toISOString() })]]); }
  // For other features that email people on staff's behalf: writes, checks and (only if it passes and email is on) starts the send.
  async function autoSend({ subject, body, category, zwids, who }) {
    const s = await settings(); if (!s.enabled || !mailer.status().configured) return { sent: false, why: 'Email is off or no service is set up.' };
    const c = await create({ subject, body, category, audience: { type: 'people', zwids } }, who), ck = await check(c);
    if (!ck.ok) return { sent: false, id: c.id, why: 'The check found problems: ' + ck.issues.filter(i => i.level === 'error').map(i => i.text).join(' ') };
    const r = await start(c, who, 0); return { sent: true, id: r.id, counts: r.counts };
  }
  return { prefsOf, setPrefs, usage, sendTo, everyone, createDraft, sendDirect, health, optOutAddress, autoSend, routes, runSchedule, render, rules, check, settings, directory, recipients, unsubscribe, unsubscribePage, donePage, tokenFor, readToken, weeklyDraft, DEFAULTS };
};

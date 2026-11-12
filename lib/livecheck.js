'use strict';
// The go-live check: one list, one real test per feature, each marked passed or failed with the time and what happened. Tests that can be done by the
// app (email, the admin Discord channel, a DM, the PDF, storage, the AI, the watchdog) run when the button is pressed; the rest give a link and ask you
// to confirm what you saw. Results are kept so you can see what has been proven and when.
module.exports = function createLiveCheck({ redis, HttpError, requireRole, mail, discord, notify, aiops, controlRoom, ai, siteUrl = '' }) {
  const KEY = 'cg:livecheck';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const ITEMS = [
    { id: 'storage', label: 'Storage answers', how: 'auto' },
    { id: 'email', label: 'A test email arrives', how: 'auto', needs: 'Your email address' },
    { id: 'discord-admin', label: 'The admin Discord channel gets a message', how: 'auto' },
    { id: 'discord-dm', label: 'A Discord DM reaches you', how: 'auto', needs: 'Your Zwift ID (your Discord must be linked)' },
    { id: 'rsvp', label: 'The availability link works', how: 'link', needs: 'Your Zwift ID and email address' },
    { id: 'optout', label: 'The email preferences page works', how: 'link', needs: 'Your Zwift ID and email address' },
    { id: 'join', label: 'The join form works', how: 'link', link: '/join.html' },
    { id: 'race', label: 'The open race page works', how: 'link', link: '/race.html' },
    { id: 'pdf', label: 'The monthly PDF is made', how: 'auto' },
    { id: 'ai', label: 'The AI is switched on and inside its budget', how: 'auto' },
    { id: 'watchdog', label: 'No system is red in the Control room', how: 'auto' },
    { id: 'radio', label: 'Race radio posts a result', how: 'manual', hint: 'Switch the radio on, enter a test result in ZRL, and watch the public Discord channel.' },
  ];
  const load = async () => parse((await redis([['GET', KEY]]))[0]) || {};
  const save = async (id, r) => { const all = await load(); all[id] = { ...r, at: new Date().toISOString() }; await redis([['SET', KEY, JSON.stringify(all)]]); return all[id]; };
  async function run(req, body) {
    const id = String(body.id || ''), item = ITEMS.find(x => x.id === id); if (!item) throw new HttpError(404, 'That check does not exist.');
    const z = String(body.zwid || '').replace(/\D/g, ''), to = String(body.to || '').trim();
    try {
      if (id === 'storage') { await redis([['GET', 'cg:livecheck:ping']]); return await save(id, { ok: true, note: 'Storage answered.' }); }
      if (id === 'email') { if (!to) throw new HttpError(400, 'Enter your email address.'); await mail.routes['POST /api/mail/test'](req, { to, subject: 'Go-live check', body: 'If you are reading this, email works.' }); return await save(id, { ok: true, note: `A test email was sent to ${to}. Mark it as received once it arrives.`, confirm: true }); }
      if (id === 'discord-admin') { const ok = await discord('admin', { content: '✅ Go-live check: the admin channel works.' }); return await save(id, { ok: !!ok, note: ok ? 'A message was posted to the admin channel.' : 'Discord did not accept the message (is the admin webhook set?).' }); }
      if (id === 'discord-dm') { if (!z) throw new HttpError(400, 'Enter your Zwift ID.'); const ok = await notify(z, 'Go-live check: this is a test message from the club app.', { kind: 'test', key: `livecheck:${z}:${Date.now()}` }); return await save(id, { ok: !!ok, note: ok ? 'A DM was sent: check your Discord.' : 'No DM could be sent (is your Discord linked in My Profile?).' }); }
      if (id === 'rsvp' || id === 'optout') {
        if (!z || !to) throw new HttpError(400, 'Enter your Zwift ID and email address.'); const t = mail.tokenFor(z, to.toLowerCase());
        return await save(id, { ok: null, link: id === 'rsvp' ? `${siteUrl}/api/rsvp?t=${t}` : `${siteUrl}/api/mail/unsubscribe?t=${t}`, note: 'Open the link, then mark it as working.' });
      }
      if (id === 'join' || id === 'race') return await save(id, { ok: null, link: `${siteUrl}${item.link}`, note: 'Open the page, then mark it as working.' });
      if (id === 'pdf') { const b = await aiops.monthlyPdf(Date.now()); return await save(id, { ok: b.subarray(0, 5).toString() === '%PDF-', note: `A ${Math.round(b.length / 1024 * 10) / 10} KB PDF was made.` }); }
      if (id === 'ai') { const on = ai.enabled(), ok = on && await ai.available(true); return await save(id, { ok, note: on ? (ok ? 'On and inside its budget.' : 'The key is set but the budget is used up.') : 'No AI key is set.' }); }
      if (id === 'watchdog') { const bad = (await controlRoom.systems()).filter(s => s.level === 'bad'); return await save(id, { ok: !bad.length, note: bad.length ? bad.map(b => `${b.name}: ${b.detail}`).join(' ') : 'Nothing is red.' }); }
      throw new HttpError(400, 'That check is confirmed by hand: use "Mark as working".');
    } catch (e) { if (e instanceof HttpError && e.status < 500 && e.status !== 404) throw e; return save(id, { ok: false, note: String(e.message || e).slice(0, 200) }); }
  }
  async function mark(id, ok) { if (!ITEMS.find(x => x.id === id)) throw new HttpError(404, 'That check does not exist.'); const cur = (await load())[id] || {}; return save(id, { ...cur, ok: !!ok, confirmed: true, note: ok ? 'Confirmed working by an administrator.' : 'Reported not working by an administrator.' }); }
  const routes = {
    'GET /api/livecheck': async req => { requireRole(req, ['admin', 'mod']); const all = await load(); return { items: ITEMS.map(i => ({ ...i, result: all[i.id] || null })) }; },
    'POST /api/livecheck/run': async (req, body) => { requireRole(req, ['admin']); return { result: await run(req, body) }; },
    'POST /api/livecheck/mark': async (req, body) => { requireRole(req, ['admin']); return { result: await mark(String(body.id || ''), body.ok === true) }; },
  };
  return { routes, run, mark, ITEMS };
};

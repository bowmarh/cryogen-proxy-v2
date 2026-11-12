'use strict';
// Sends one email through a sending service over HTTPS (the app cannot use a normal mailbox from a serverless function). Hostinger's Mail API is the
// default: HOSTINGER_MAIL_TOKEN (an API token made in hPanel → Agentic Mail → API access) and HOSTINGER_MAIL_MAILBOX_ID (the mailbox it is allowed to use).
// Resend is supported as a drop-in for newsletters: RESEND_API_KEY and EMAIL_FROM_ADDRESS. EMAIL_PROVIDER picks one when both are set.
// Every adapter answers { ok: true } or throws an Error with .status and .retryable. No credential is ever put in a message.
const trim = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function settings(env = process.env) {
  const hostinger = !!(env.HOSTINGER_MAIL_TOKEN && env.HOSTINGER_MAIL_MAILBOX_ID), resend = !!(env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS);
  const pick = env.EMAIL_PROVIDER === 'resend' && resend ? 'resend' : env.EMAIL_PROVIDER === 'hostinger' && hostinger ? 'hostinger' : hostinger ? 'hostinger' : resend ? 'resend' : '';
  return { provider: pick, hostinger, resend, configured: !!pick };
}

async function call(fetchImpl, url, headers, body) {
  let r;
  try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw Object.assign(new Error('The email service could not be reached.'), { status: 0, retryable: true }); }
  if (r.ok) return { ok: true };
  const text = trim(await r.text().catch(() => ''), 300);
  let why = text; try { const j = JSON.parse(text); why = trim(j.message || j.error || (j.error && j.error.message) || text, 200); } catch (e) { /* not JSON */ }
  throw Object.assign(new Error(`The email service refused it (HTTP ${r.status})${why ? `: ${why}` : ''}`), { status: r.status, retryable: r.status === 429 || r.status >= 500 });
}

// message: { to, subject, html, text, fromName, replyTo, headers }
function createMailer({ fetchImpl = (...a) => fetch(...a), env = () => process.env } = {}) {
  const status = () => settings(env());
  async function send(m) {
    const e = env(), s = settings(e);
    if (!s.configured) throw Object.assign(new Error('No email service is set up: add the sending keys in Vercel (see docs/EMAIL-SETUP.md).'), { status: 503, retryable: false });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(m.to || ''))) throw Object.assign(new Error('That is not an email address.'), { status: 400, retryable: false });
    const subject = trim(m.subject, 200); if (!subject) throw Object.assign(new Error('The email has no subject.'), { status: 400, retryable: false });
    if (e.VERCEL_ENV === 'preview' && e.ALLOW_OUTBOUND !== '1') return { ok: true, staged: true };   // a preview deployment sends nothing real (set ALLOW_OUTBOUND=1 to allow it)
    if (s.provider === 'resend') {
      const from = `${trim(m.fromName || 'CRYO-GEN', 60).replace(/[<>"]/g, '')} <${e.EMAIL_FROM_ADDRESS}>`;
      return call(fetchImpl, 'https://api.resend.com/emails', { Authorization: `Bearer ${e.RESEND_API_KEY}` }, { from, to: [m.to], subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}) });
    }
    const base = String(e.HOSTINGER_MAIL_BASE || 'https://api.mail.hostinger.com').replace(/\/$/, '');
    return call(fetchImpl, `${base}/api/v1/mailboxes/${encodeURIComponent(e.HOSTINGER_MAIL_MAILBOX_ID)}/send`, { Authorization: `Bearer ${e.HOSTINGER_MAIL_TOKEN}` }, { to: [m.to], subject, html: m.html, text: m.text, displayName: trim(m.fromName || 'CRYO-GEN', 60) });
  }
  return { send, status };
}
module.exports = { createMailer, settings };

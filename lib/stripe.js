'use strict';
// Supporter payments through Stripe Checkout (a hosted payment page: no card details ever touch this app). A member presses "Become a supporter", is sent
// to Stripe, and Stripe tells this app (a signed webhook) when the subscription starts, fails or ends; the supporter list follows by itself.
// Off until STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET are set. The webhook is checked with Stripe's signature (HMAC-SHA256 over the
// timestamp and the exact bytes received, five minutes' tolerance), so nothing that is not from Stripe can add or remove a supporter.
const crypto = require('crypto');

module.exports = function createStripe({ redis, HttpError, memberFromRequest, support, discord = async () => false, siteUrl = '', env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  const K = { customers: 'cg:stripe:customers', events: 'cg:stripe:events' };   // customer id -> zwid; event id -> time (so a repeated delivery does nothing)
  const enabled = () => !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
  async function stripe(path, params) {
    if (!env.STRIPE_SECRET_KEY) throw new HttpError(409, 'Supporter payments are not set up yet.');
    let r, d; try { r = await fetchImpl(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params), signal: AbortSignal.timeout(15000) }); d = await r.json(); } catch (e) { throw new HttpError(502, 'Stripe could not be reached just now.'); }
    if (!r.ok) throw new HttpError(502, `Stripe refused it: ${String((d.error && d.error.message) || r.status).slice(0, 160)}`);
    return d;
  }
  async function checkout(req) {
    const m = need(req); if (!enabled()) throw new HttpError(409, 'Supporter payments are not set up yet.');
    if (await support.isSupporter(m.zwid)) throw new HttpError(409, 'You are already a supporter. Thank you!');
    const s = await stripe('checkout/sessions', { mode: 'subscription', 'line_items[0][price]': env.STRIPE_PRICE_ID, 'line_items[0][quantity]': 1, client_reference_id: String(m.zwid), 'metadata[zwid]': String(m.zwid), success_url: `${siteUrl}/?supporter=thanks`, cancel_url: `${siteUrl}/?supporter=cancelled`, allow_promotion_codes: 'true' });
    return { url: s.url };
  }
  async function portal(req) {
    const m = need(req), [cust] = await redis([['HGET', K.customers, `z:${m.zwid}`]]); if (!cust) throw new HttpError(404, 'We could not find a Stripe subscription for you.');
    return { url: (await stripe('billing_portal/sessions', { customer: cust, return_url: siteUrl })).url };
  }
  function verify(raw, header) {
    const secret = env.STRIPE_WEBHOOK_SECRET || ''; if (!secret) return false;
    const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2)), t = Number(parts.t), sig = String(parts.v1 || '');
    if (!t || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(now() / 1000 - t) > 300) return false;
    const want = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
  }
  async function webhook(raw, header) {
    if (!verify(raw, header)) throw new HttpError(400, 'Bad signature.');
    let ev; try { ev = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Bad payload.'); }
    const [fresh] = await redis([['HSETNX', K.events, String(ev.id), new Date(now()).toISOString()]]); if (!fresh) return { ok: true, duplicate: true };
    const o = (ev.data && ev.data.object) || {};
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
      const zwid = String(o.client_reference_id || (o.metadata && o.metadata.zwid) || '').replace(/\D/g, ''); if (!zwid) return { ok: true, ignored: 'no rider' };
      await redis([['HSET', support.KEYS.LIST, zwid, JSON.stringify({ since: new Date(now()).toISOString().slice(0, 10), until: '', note: 'Stripe subscription', by: 'stripe' })], ['HSET', K.customers, String(o.customer), zwid], ['HSET', K.customers, `z:${zwid}`, String(o.customer)]]);
      await discord('admin', { content: `⭐ **New supporter** (Zwift ID ${zwid}) through Stripe. Thank you!` }).catch(() => {}); return { ok: true, added: zwid };
    }
    if (ev.type === 'customer.subscription.deleted') {
      const [zwid] = await redis([['HGET', K.customers, String(o.customer)]]);
      if (zwid) { await redis([['HDEL', support.KEYS.LIST, zwid]]); await discord('admin', { content: `ℹ️ A supporter's Stripe subscription ended (Zwift ID ${zwid}); they have been taken off the supporter list.` }).catch(() => {}); return { ok: true, removed: zwid }; }
    }
    if (ev.type === 'invoice.payment_failed') { const [zwid] = await redis([['HGET', K.customers, String(o.customer)]]); await discord('admin', { content: `⚠️ A supporter payment failed${zwid ? ` (Zwift ID ${zwid})` : ''}. Stripe will retry; they stay a supporter until the subscription ends.` }).catch(() => {}); }
    return { ok: true };
  }
  const routes = {
    'POST /api/support/checkout': async req => checkout(req),
    'POST /api/support/portal': async req => portal(req),
  };
  return { routes, webhook, verify, enabled, checkout };
};

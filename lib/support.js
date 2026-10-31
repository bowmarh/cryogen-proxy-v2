'use strict';
// Supporters and what the coach costs. The coach is the only part of the app that costs money per use, so it has a free allowance and a bigger one
// for supporters (people who chip in to the club). Everything that runs the club stays free. A supporter is added by an administrator by hand after
// the rider has paid through the club's own link (Ko-fi, Stripe, a bank transfer: the app takes no payments). Prices here are the club's own numbers
// for estimating cost; nothing is charged by this code.
module.exports = function createSupport({ redis, HttpError, requireRole, staffNameOf = () => '', fetchRoster }) {
  const LIST = 'cg:support:list', SETTINGS = 'cg:support:settings', AI = 'cg:ai:usage';
  const DEFAULTS = { payUrl: '', price: 3, freeWeekly: 3, supporterDaily: 15, freeRides: 1, shareCost: false, budget: 0, inPrice: 0, outPrice: 0 };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

  const clean = s => ({
    payUrl: /^https:\/\/[^\s"'<>]{4,290}$/.test(String(s.payUrl || '')) ? String(s.payUrl) : '',
    price: n(s.price, 0, 100, DEFAULTS.price), freeWeekly: Math.round(n(s.freeWeekly, 0, 50, DEFAULTS.freeWeekly)), supporterDaily: Math.round(n(s.supporterDaily, 1, 100, DEFAULTS.supporterDaily)),
    freeRides: Math.round(n(s.freeRides, 0, 10, DEFAULTS.freeRides)), shareCost: s.shareCost === true, budget: n(s.budget, 0, 100000, 0), inPrice: n(s.inPrice, 0, 1000, 0), outPrice: n(s.outPrice, 0, 1000, 0),
  });
  const settings = async () => clean(parse((await redis([['GET', SETTINGS]]))[0]) || {});
  const entries = async () => pairs((await redis([['HGETALL', LIST]]))[0]).map(([zwid, v]) => ({ zwid, ...(parse(v) || {}) }));
  const live = (e, today = day()) => !e.until || e.until >= today;
  const isSupporter = async zwid => { const [v] = await redis([['HGET', LIST, String(zwid)]]); const e = parse(v); return !!e && live(e); };
  const activeIds = async () => (await entries()).filter(e => live(e)).map(e => e.zwid);

  // What the AI has cost this month, from the tokens counted. Null while the club has not entered its prices.
  async function month(now = Date.now()) {
    const m = day(now).slice(0, 7), s = await settings(), raw = pairs((await redis([['HGETALL', AI]]))[0]);
    let tin = 0, tout = 0, calls = 0;
    for (const [f, v] of raw) { if (!f.startsWith(m)) continue; const k = f.split(':')[1]; if (k === 'in') tin += Number(v) || 0; else if (k === 'out') tout += Number(v) || 0; else if (k === 'calls') calls += Number(v) || 0; }
    const priced = s.inPrice > 0 || s.outPrice > 0;
    return { month: m, tokensIn: tin, tokensOut: tout, answers: calls, cost: priced ? Math.round((tin / 1e6 * s.inPrice + tout / 1e6 * s.outPrice) * 100) / 100 : null };
  }
  // The coach is open to everyone below the budget; past it the free allowance pauses, and well past it everyone's does.
  async function budgetState(supporter) {
    const s = await settings(); if (!s.budget) return { ok: true };
    const { cost } = await month(); if (cost === null) return { ok: true };
    if (cost >= s.budget * 1.5) return { ok: false, why: 'The coach has used up this month\'s budget and is resting until next month. Thank you for your patience.' };
    if (cost >= s.budget && !supporter) return { ok: false, why: 'The free coach has used this month\'s budget and is resting until next month. Supporters can still ask.' };
    return { ok: true };
  }
  async function publicInfo(zwid) {
    const s = await settings(), sup = (await activeIds()).length, mo = s.shareCost ? await month() : null;
    return { payUrl: s.payUrl, price: s.price, supporter: await isSupporter(zwid), supporters: sup, transparency: s.shareCost && mo && mo.cost !== null ? { month: mo.month, cost: mo.cost, supporters: sup, monthly: Math.round(sup * s.price * 100) / 100 } : null };
  }

  const routes = {
    'GET /api/support': async req => {
      requireRole(req, ['admin']);
      const [s, list, mo] = await Promise.all([settings(), entries(), month()]);
      const { riders } = await fetchRoster().catch(() => ({ riders: [] })), name = z => (riders.find(r => String(r.riderId) === z) || {}).name || z;
      return { settings: s, month: mo, supporters: list.map(e => ({ ...e, name: name(e.zwid), active: live(e) })).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name)), income: Math.round(list.filter(e => live(e)).length * s.price * 100) / 100 };
    },
    'POST /api/support/settings': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.payUrl && !/^https:\/\//.test(String(body.payUrl))) throw new HttpError(400, 'The payment link must start with https://');
      const s = clean(body); await redis([['SET', SETTINGS, JSON.stringify(s)]]); return { settings: s };
    },
    'POST /api/support/add': async (req, body) => {
      requireRole(req, ['admin']);
      const zwid = String(body.zwid || '').replace(/\D/g, ''); if (!zwid) throw new HttpError(400, 'Choose the rider.');
      const until = body.until ? String(body.until) : ''; if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new HttpError(400, 'The end date must be a real date.');
      await redis([['HSET', LIST, zwid, JSON.stringify({ since: day(), until, note: String(body.note || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 80), by: staffNameOf(req) || 'admin' })]]);
      return { ok: true };
    },
    'POST /api/support/remove': async (req, body) => { requireRole(req, ['admin']); await redis([['HDEL', LIST, String(body.zwid || '')]]); return { ok: true }; },
  };
  return { routes, settings, isSupporter, activeIds, month, budgetState, publicInfo, KEYS: { LIST, SETTINGS, AI } };
};

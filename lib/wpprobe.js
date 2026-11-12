'use strict';
// "What does the club's WordPress member plugin actually offer?" A read-only inspection: it asks the plugin's own route list (the standard WordPress REST
// index for its namespace) which routes exist, with which methods and which arguments, and reads the member list once to report the field NAMES and their
// types (never the values). The answer is kept so it can be looked at again, and it tells us which member details the app can safely write.
module.exports = function createWpProbe({ redis, HttpError, requireRole, wpApi, wpAuth, fetchImpl = (...a) => fetch(...a) }) {
  const KEY = 'cg:wpprobe:last';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const hdr = () => ({ Authorization: `Basic ${Buffer.from(wpAuth()).toString('base64')}`, Accept: 'application/json', 'User-Agent': 'cryogen-proxy/2.0' });
  async function get(url) { try { const r = await fetchImpl(url, { headers: hdr(), signal: AbortSignal.timeout(15000) }); return { status: r.status, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, body: null, error: 'could not be reached' }; } }
  const type = v => (v === null ? 'empty' : Array.isArray(v) ? 'list' : typeof v);
  async function run() {
    if (!wpAuth()) throw new HttpError(409, 'WordPress is not connected (WP_API_USER / WP_API_APP_PASSWORD).');
    const out = { at: new Date().toISOString(), namespace: wpApi, routes: [], memberFields: [], notes: [] };
    const idx = await get(wpApi.replace(/\/$/, ''));
    if (idx.status === 200 && idx.body && idx.body.routes) {
      for (const [route, info] of Object.entries(idx.body.routes).slice(0, 80)) {
        const methods = [...new Set((info.endpoints || []).flatMap(e => e.methods || []))], args = {};
        for (const e of info.endpoints || []) for (const [name, a] of Object.entries(e.args || {})) args[name] = { type: Array.isArray(a.type) ? a.type.join('|') : a.type || '', required: !!a.required, ...(a.enum ? { values: a.enum.slice(0, 12) } : {}) };
        out.routes.push({ route: route.replace(/^\/cryogen\/v1/, '') || '/', methods, args });
      }
    } else out.notes.push(`The route list was not available (HTTP ${idx.status}): the plugin may not publish one.`);
    const mem = await get(`${wpApi.replace(/\/$/, '')}/members`);
    const first = mem.status === 200 && Array.isArray(mem.body) ? mem.body.find(x => x && typeof x === 'object') : null;
    if (first) out.memberFields = Object.entries(first).map(([name, v]) => ({ name, type: type(v) })); else out.notes.push(`The member list could not be read (HTTP ${mem.status}).`);
    const can = out.routes.filter(r => /member/i.test(r.route)).map(r => `${r.methods.join('/')} ${r.route}`);
    out.summary = can.length ? `Member routes found: ${can.join(', ')}.` : 'No member routes were listed.';
    await redis([['SET', KEY, JSON.stringify(out)]]); return out;
  }
  return { run, routes: { 'GET /api/wpprobe': async req => { requireRole(req, ['admin']); return { last: parse((await redis([['GET', KEY]]))[0]) }; }, 'POST /api/wpprobe/run': async req => { requireRole(req, ['admin']); return { result: await run() }; } } };
};

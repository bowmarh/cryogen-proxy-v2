'use strict';
// Test helpers: an in-process fake of everything the server talks to (Redis, WordPress,
// Google Sheets, Discord) plus a tiny HTTP client. No network and no packages are needed.
// Each test file runs in its own process (node --test), so env and module state are per file.

const http = require('http');
const crypto = require('crypto');

const BASE_ENV = {
  ADMIN_PASSWORD: 'admin-pw',
  MOD_PASSWORD: 'mod-pw',
  KV_REST_API_URL: 'http://redis.test',
  KV_REST_API_TOKEN: 'redis-token',
  WP_API_URL: 'http://wp.test/api',
  WP_API_USER: 'wpuser',
  WP_API_APP_PASSWORD: 'wppass',
  WP_SSO_SECRET: 'sso-secret-for-tests',
  CRON_SECRET: 'cron-secret',
  DISCORD_WEBHOOK_PUBLIC: 'http://discord.test/public',
  DISCORD_WEBHOOK_ADMIN: 'http://discord.test/admin',
  RATE_LIMIT_WRITES_PER_MIN: '100000',   // ordinary tests post far more than a person would; the limit has its own test
  LOGIN_MAX_FAILS: '1000',
};

// Must run before the server module is loaded: some settings are read at load time.
function setEnv(extra = {}) {
  for (const k of ['SESSION_SECRET', 'REQUIRE_MEMBER_LOGIN', 'WP_SSO_LOGIN_URL', 'SITE_URL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) delete process.env[k];
  Object.assign(process.env, BASE_ENV);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete process.env[k]; // null = make sure it is unset
    else process.env[k] = v;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function defaultRiders() {
  return Array.from({ length: 5 }, (_, i) => ({
    riderId: 1000 + i,
    name: `Rider ${i}`,
    country: 'gb',
    zpCategory: ['A', 'B', 'C', 'D', 'B'][i],
    zpFTP: 250 + i * 10,
    age: 40, gender: 'm', height: 180, weight: 75, // must never reach the public
    power: { wkg1200: 3.5 },
    race: { current: { rating: 1000 + i * 100, mixed: { category: 'Ruby' } } },
    phenotype: { value: 'Sprinter' },
  }));
}

function defaultMembers() {
  const m = (id, zwift_id, name, status, tier) => ({ id, zwift_id, name, status, tier, offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' });
  return [
    m(1, '1000', 'Rick DB', 'active', 'full'),
    m(2, '1001', 'Rider One', 'left', 'full'),
    m(3, '1002', 'Rider Two (old)', 'active', 'full'),
    m(4, '1002', 'Rider Two', 'active', 'full'), // duplicate: the last record wins
    m(5, 'TBD', 'No Id Yet', 'active', 'full'),  // placeholder: ignored
  ];
}

// gviz response for a sheet tab: { cols: ['A','B'], rows: [['x','y']] }
function gviz(tab) {
  const table = {
    cols: tab.cols.map(label => ({ id: label, label, type: 'string' })),
    rows: tab.rows.map(r => ({ c: r.map(v => ({ v })) })),
  };
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify({ table })});`;
}

function createWorld(overrides = {}) {
  return {
    db: {},                   // fake Redis: key -> string | { field: string }
    redisCalls: 0,
    clubCalls: 0,
    clubMode: 'ok',           // 'ok' | '429'
    riders: defaultRiders(),
    members: defaultMembers(),
    memberRequests: [],       // { url, headers } of GET /members
    patches: [],              // { id, body } of PATCH /members/:id
    patchStatus: 200,
    patchMessage: null,
    patchApply: (rec, body) => Object.assign(rec, body), // what the "plugin" really saves
    patchEcho: ['tier'],      // fields the plugin echoes back, as the real one does for tier
    staleMembers: null,       // if set, GET /members returns this instead of the live list
    sheet: { first: 'TEAM LIST', tabs: { 'TEAM LIST': { cols: ['Name', 'Zwift ID'], rows: [['Alice', '1']] } }, html: false },
    discord: [],              // { channel, body }
    zr: { status: 200, body: {} },   // what zwiftracing.app answers
    ...overrides,
  };
}

function redisRun(db, [cmd, key, ...a]) {
  const hash = k => (db[k] = db[k] || {});
  switch (String(cmd).toUpperCase()) {
    case 'GET': return db[key] ?? null;
    case 'SET': if (a.includes('NX') && key in db) return null; db[key] = a[0]; return 'OK';
    case 'DEL': { let n = 0; for (const k of [key, ...a]) if (k in db) { delete db[k]; n++; } return n; }
    case 'INCR': db[key] = (Number(db[key]) || 0) + 1; return db[key];
    case 'INCRBY': db[key] = (Number(db[key]) || 0) + Number(a[0]); return db[key];
    case 'EXPIRE': return key in db ? 1 : 0;
    case 'HGET': return (db[key] || {})[a[0]] ?? null;
    case 'HGETALL': return Object.entries(db[key] || {}).flat();
    case 'HKEYS': return Object.keys(db[key] || {});
    case 'HLEN': return Object.keys(db[key] || {}).length;
    case 'HSET': hash(key)[a[0]] = a[1]; return 1;
    case 'HINCRBY': { const h = hash(key); h[a[0]] = String((Number(h[a[0]]) || 0) + Number(a[1])); return Number(h[a[0]]); }
    case 'HSETNX': if (a[0] in hash(key)) return 0; hash(key)[a[0]] = a[1]; return 1;
    case 'HDEL': { let n = 0; for (const f of a) if (f in hash(key)) { delete db[key][f]; n++; } return n; }
    case 'LPUSH': { const l = (db[key] = db[key] || []); for (const v of a) l.unshift(v); return l.length; }
    case 'LTRIM': { const l = db[key] || []; const to = Number(a[1]); db[key] = l.slice(Number(a[0]), to < 0 ? l.length + to + 1 : to + 1); return 'OK'; }
    case 'LRANGE': { const l = db[key] || []; const to = Number(a[1]); return l.slice(Number(a[0]), to < 0 ? l.length + to + 1 : to + 1); }
    case 'LSET': { const l = db[key] || []; l[Number(a[0])] = a[1]; return 'OK'; }
    default: throw new Error(`unsupported redis command ${cmd}`);
  }
}

function handleWp(world, u, opts) {
  const path = u.pathname.replace('/api', '');
  const authed = Boolean(opts.headers && (opts.headers.Authorization || opts.headers.authorization));
  const method = (opts.method || 'GET').toUpperCase();
  if (/^\/zwift\/public\/clubs\/\d+\/0$/.test(path)) {
    world.clubCalls++;
    if (world.clubMode === '429') return json({ message: 'Too many requests' }, 429);
    return json({ riders: world.riders });
  }
  if (path === '/members' && method === 'GET') {
    world.memberRequests.push({ url: u.href, headers: opts.headers || {} });
    if (!authed) return json({ code: 'rest_forbidden' }, 401);
    return json(world.staleMembers || world.members);
  }
  const patch = /^\/members\/(\d+)$/.exec(path);
  if (patch && method === 'PATCH') {
    if (!authed) return json({ code: 'rest_forbidden' }, 401);
    const body = JSON.parse(opts.body);
    world.patches.push({ id: patch[1], body });
    if (world.patchStatus !== 200) return json({ code: 'rest_forbidden', message: world.patchMessage || 'nope' }, world.patchStatus);
    const rec = world.members.find(x => String(x.id) === patch[1]);
    if (!rec) return json({ message: 'Member not found' }, 404);
    world.patchApply(rec, body);
    const echo = {};
    for (const k of world.patchEcho) if (k in body) echo[k] = body[k];
    return json({ ok: true, id: rec.id, ...echo });
  }
  return json({ message: `no stub for ${method} ${path}` }, 404);
}

function handleSheet(world, u, opts = {}) {
  const name = u.searchParams.get('sheet');
  if (world.sheet.fail) return Promise.reject(new TypeError('fetch failed'));
  if (world.sheet.hang && opts.signal) { // never answers; ends only when the caller's timeout aborts the request
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
  }
  if (world.sheet.html) return new Response('<html>Sign in</html>', { status: 200 });
  // Like Google: an unknown tab name silently returns the first tab.
  const tab = world.sheet.tabs[name] || world.sheet.tabs[world.sheet.first];
  return new Response(gviz(tab), { status: 200 });
}

function installFetch(world) {
  const real = global.fetch;
  global.fetch = async (input, opts = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.host === 'redis.test') {
      world.redisCalls++;
      if ((opts.headers || {}).Authorization !== `Bearer ${BASE_ENV.KV_REST_API_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const out = JSON.parse(opts.body).map(c => { try { return { result: redisRun(world.db, c) }; } catch (e) { return { error: e.message }; } });
      return json(out);
    }
    if (u.host === 'wp.test') return handleWp(world, u, opts);
    if (u.host === 'docs.google.com') return handleSheet(world, u, opts);
    if (u.host === 'zwiftracing.app' || u.host === 'api.zwiftracing.app') {   // the ZwiftRacing.app organizer API: world.zr = { status, body, seen: [] }
      (world.zr.seen = world.zr.seen || []).push({ path: u.pathname, auth: (opts.headers || {}).Authorization });
      (world.zr.calls = world.zr.calls || []).push({ method: (opts.method || 'GET').toUpperCase(), path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
      const special = (world.zr.byPath || {})[`${(opts.method || 'GET').toUpperCase()} ${u.pathname}`];   // an answer for one method and path
      if (special) return json(special.body ?? {}, special.status || 200);
      if (typeof world.zr.body === 'string') return new Response(world.zr.body, { status: world.zr.status || 200, headers: { 'Content-Type': 'text/html' } });
      return json(world.zr.body ?? {}, world.zr.status || 200);
    }
    if (u.host === 'push.test') {   // a browser's push service: world.pushes collects { path, headers, body (Buffer) }; world.pushStatus answers (201 by default, 410 for a gone device)
      (world.pushes = world.pushes || []).push({ path: u.pathname, headers: opts.headers || {}, body: Buffer.from(opts.body) });
      return new Response('', { status: (world.pushStatus || {})[u.pathname] || 201 });
    }
    if (u.host === 'api.anthropic.com') {   // the model behind the staff assistant: world.anthropic = { reply: <text the model answers>, status, seen: [] }
      const a = world.anthropic = world.anthropic || { reply: '{"reply":"","actions":[]}', status: 200, seen: [] };
      a.seen.push({ key: (opts.headers || {})['x-api-key'], body: JSON.parse(opts.body) });
      return json(a.status === 200 ? { content: [{ type: 'text', text: a.reply }], ...(a.usage ? { usage: a.usage } : {}) } : { error: { message: 'model error' } }, a.status);
    }
    if (u.host === 'hooks.test') {   // an outbound webhook (Zapier, Make): world.hooks collects what was sent; world.hookFail makes it answer 500
      (world.hooks = world.hooks || []).push({ path: u.pathname, body: JSON.parse(opts.body) });
      return world.hookFail ? json({}, 500) : json({ ok: true });
    }
    if (u.host === 'cal.test') return new Response(world.ical || '', { status: world.icalStatus || 200 });   // an iCal feed
    if (u.host === 'oauth2.googleapis.com') {   // a service account signing in: world.gs.tokenCalls counts them, world.gs.tokenFail answers 400
      const gs = world.gs = world.gs || { sheets: {}, calls: [], tokenCalls: 0 };
      gs.tokenCalls++;
      if (gs.tokenFail) return json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400);
      return json({ access_token: 'gs-token', expires_in: 3600 });
    }
    if (u.host === 'sheets.googleapis.com') {   // the Sheets API: world.gs.sheets[<id>] = { tabs: { <title>: rows[][] } }; a sheet not listed answers 404, one with `locked` answers 403
      const gs = world.gs = world.gs || { sheets: {}, calls: [], tokenCalls: 0 };
      if ((opts.headers || {}).Authorization !== 'Bearer gs-token') return json({ error: { message: 'unauthenticated' } }, 401);
      const m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
      const sheet = m && gs.sheets[decodeURIComponent(m[1])];
      gs.calls.push({ method: opts.method || 'GET', path: u.pathname + u.search });
      if (!sheet) return json({ error: { message: 'not found' } }, 404);
      if (sheet.locked) return json({ error: { message: 'The caller does not have permission' } }, 403);
      const rest = decodeURIComponent(m[2]);
      if (!rest) return json({ sheets: Object.keys(sheet.tabs).map(title => ({ properties: { title } })) });
      if (rest === ':batchUpdate') { for (const r of JSON.parse(opts.body).requests) if (r.addSheet) sheet.tabs[r.addSheet.properties.title] = []; return json({}); }
      const t = /^\/values\/'((?:[^']|'')*)'!(.*?)(:clear)?$/.exec(rest);
      if (t) {
        const title = t[1].replace(/''/g, "'");
        if (!(title in sheet.tabs)) return json({ error: { message: 'Unable to parse range' } }, 400);
        if (t[3]) { sheet.tabs[title] = []; return json({}); }
        const body = JSON.parse(opts.body); sheet.tabs[title] = body.values;
        return json({ updatedCells: body.values.reduce((n, r) => n + r.length, 0) });
      }
      return json({ error: { message: 'no stub' } }, 404);
    }
    if (u.host === 'discord.com') {   // the Discord bot API: world.dms collects direct messages; world.dmFail is a set of user ids whose DMs are closed
      const m = /\/channels\/dm-(\d+)\/messages$/.exec(u.pathname);
      if (/\/guilds\/\d+\/members$/.test(u.pathname)) {   // the server's member list: world.guildMembers (world.guildDenied answers 403, as when the Server Members Intent is off)
        if (world.guildDenied) return json({ code: 50001 }, 403);
        const after = u.searchParams.get('after') || '0', all = world.guildMembers || [];
        const start = after === '0' ? 0 : all.findIndex(m => m.user.id === after) + 1;
        return json(all.slice(start, start + Number(u.searchParams.get('limit') || 1000)));
      }
      if (u.pathname.endsWith('/oauth2/token')) { (world.oauthCalls = world.oauthCalls || []).push(String(opts.body)); return world.oauthFail ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'user-token' }); }   // "Sign in with Discord"
      if (u.pathname === '/api/v10/users/@me' && /^Bot /.test((opts.headers || {}).Authorization || '')) return world.botBad ? json({}, 401) : json({ id: 'bot' });
      if (u.pathname === '/api/v10/users/@me') return (opts.headers || {}).Authorization === 'Bearer user-token' && world.oauthUser ? json(world.oauthUser) : json({}, 401);
      if (u.pathname.endsWith('/users/@me/channels')) { const id = JSON.parse(opts.body).recipient_id; return json(world.dmFail && world.dmFail.has(id) ? { code: 50007 } : { id: `dm-${id}` }, world.dmFail && world.dmFail.has(id) ? 403 : 200); }
      if (m) { (world.dms = world.dms || []).push({ userId: m[1], body: JSON.parse(opts.body), auth: (opts.headers || {}).Authorization }); return json({ id: 'msg' }); }
      return json({}, 404);
    }
    if (u.host === 'discord.test') {
      if (world.discordFail > 0) { world.discordFail--; return new Response(JSON.stringify({ retry_after: 0.01 }), { status: world.discordFailStatus || 500 }); }   // Discord having a bad moment
      world.discord.push({ channel: u.pathname.slice(1), body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 }); // Discord answers 204 with no body
    }
    return real(input, opts);
  };
  return () => { global.fetch = real; };
}

// Loads a fresh copy of the server (a "new serverless instance") and serves it on a free port.
async function startApp(world, { host = 'localhost', port = 0 } = {}) {
  const restore = installFetch(world);
  const file = require.resolve('../api/server.js');
  delete require.cache[file];
  const handler = require(file);
  const server = http.createServer(handler);
  await new Promise(r => server.listen(port, host, r));
  const base = `http://${host}:${server.address().port}`;
  let closed = false;

  const app = {
    base,
    world,
    // Returns { status, body (parsed JSON or text), location }.
    async call(method, path, { token, body, headers = {} } = {}) {
      const h = { ...headers };
      if (token) h.Authorization = `Bearer ${token}`;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const raw = await res.text();
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (e) { /* not JSON */ }
      return { status: res.status, body: parsed, location: res.headers.get('location'), headers: Object.fromEntries(res.headers) };
    },
    get: (path, opts) => app.call('GET', path, opts),
    post: (path, body, opts = {}) => app.call('POST', path, { ...opts, body: body === undefined ? {} : body }),
    async login(role) {
      const r = await app.post('/api/login', { role, password: role === 'admin' ? BASE_ENV.ADMIN_PASSWORD : BASE_ENV.MOD_PASSWORD });
      return r.body.token;
    },
    // Signs a rider in through the cryogen.team hand-off and returns their member session token.
    // Signs a rider in through the cryogen.team hand-off. Test riders are full members: unless `associate` is set, a member record is added
    // for a Zwift ID the roster does not know, so they are not mistaken for an associate (someone not yet in the club).
    async memberSession(zwid, { name = 'WP Name', nonce, associate = false } = {}) {
      const known = world.riders.some(r => String(r.riderId) === String(zwid)) || (world.members || []).some(m => String(m.zwift_id) === String(zwid));
      if (!associate && !known) world.members.push({ id: 9000 + world.members.length, zwift_id: String(zwid), name, status: 'active', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0', testRecord: true });
      const r = await app.get(`/api/auth/wp?t=${ssoToken({ zwid, name, nonce })}`);
      const m = /#sso=(.+)$/.exec(r.location || '');
      if (!m) throw new Error(`sign-in failed: ${r.location}`);
      return m[1];
    },
    async close() {
      if (closed) return; // safe to call twice, e.g. from a cleanup hook after a test already closed it
      closed = true;
      await new Promise(r => server.close(r));
      restore();
    },
  };
  return app;
}

let nonceCounter = 0;
function ssoToken({ zwid, name = 'WP Name', nonce, expiresInMs = 5 * 60 * 1000, secret = BASE_ENV.WP_SSO_SECRET }) {
  const payload = Buffer.from(JSON.stringify({
    zwid, name, n: nonce || `nonce-${Date.now()}-${++nonceCounter}-abcdef`, exp: Date.now() + expiresInMs,
  })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

// A staff-style token signed like the server does, for crafting expired or forged ones.
function signedToken(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function defaultSessionSecret() {
  return crypto.createHash('sha256').update(`cg-session|${process.env.ADMIN_PASSWORD || ''}|${process.env.MOD_PASSWORD || ''}`).digest('hex');
}

// yyyy-mm-dd, offset days from today (UTC)
function ymd(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

module.exports = { setEnv, createWorld, startApp, ssoToken, signedToken, defaultSessionSecret, ymd, BASE_ENV, gviz };

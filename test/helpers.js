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
};

// Must run before the server module is loaded: some settings are read at load time.
function setEnv(extra = {}) {
  for (const k of ['SESSION_SECRET', 'REQUIRE_MEMBER_LOGIN', 'WP_SSO_LOGIN_URL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA']) delete process.env[k];
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
    m(2, '1001', 'Rider One', 'left', 'half'),
    m(3, '1002', 'Rider Two (old)', 'active', 'half'),
    m(4, '1002', 'Rider Two', 'active', 'full'), // duplicate: the last record wins
    m(5, 'TBD', 'No Id Yet', 'active', 'half'),  // placeholder: ignored
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
    ...overrides,
  };
}

function redisRun(db, [cmd, key, ...a]) {
  const hash = k => (db[k] = db[k] || {});
  switch (String(cmd).toUpperCase()) {
    case 'GET': return db[key] ?? null;
    case 'SET': if (a.includes('NX') && key in db) return null; db[key] = a[0]; return 'OK';
    case 'DEL': { let n = 0; for (const k of [key, ...a]) if (k in db) { delete db[k]; n++; } return n; }
    case 'HGET': return (db[key] || {})[a[0]] ?? null;
    case 'HGETALL': return Object.entries(db[key] || {}).flat();
    case 'HKEYS': return Object.keys(db[key] || {});
    case 'HSET': hash(key)[a[0]] = a[1]; return 1;
    case 'HSETNX': if (a[0] in hash(key)) return 0; hash(key)[a[0]] = a[1]; return 1;
    case 'HDEL': { let n = 0; for (const f of a) if (f in hash(key)) { delete db[key][f]; n++; } return n; }
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
    if (u.host === 'discord.test') {
      world.discord.push({ channel: u.pathname.slice(1), body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 }); // Discord answers 204 with no body
    }
    return real(input, opts);
  };
  return () => { global.fetch = real; };
}

// Loads a fresh copy of the server (a "new serverless instance") and serves it on a free port.
async function startApp(world) {
  const restore = installFetch(world);
  const file = require.resolve('../api/server.js');
  delete require.cache[file];
  const handler = require(file);
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
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
      return { status: res.status, body: parsed, location: res.headers.get('location') };
    },
    get: (path, opts) => app.call('GET', path, opts),
    post: (path, body, opts = {}) => app.call('POST', path, { ...opts, body: body === undefined ? {} : body }),
    async login(role) {
      const r = await app.post('/api/login', { role, password: role === 'admin' ? BASE_ENV.ADMIN_PASSWORD : BASE_ENV.MOD_PASSWORD });
      return r.body.token;
    },
    // Signs a rider in through the cryogen.team hand-off and returns their member session token.
    async memberSession(zwid, { name = 'WP Name', nonce } = {}) {
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

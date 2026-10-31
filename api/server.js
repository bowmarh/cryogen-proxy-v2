const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public'); // local dev only; Vercel serves public/ itself

// ── Google Sheets ──────────────────────────────────────────
// Sheets are read through the gviz endpoint, so the sheet must be shared as
// "Anyone with the link can view". Override the ID with the SHEET_ID env var.
const SHEET_ID = process.env.SHEET_ID || '1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw';
const SHEET_TABS = {
  rides: process.env.SHEET_TAB_RIDES || 'Social Rides',
  'ttt-sheet': process.env.SHEET_TAB_TTT || 'TEAM LIST',
};

// ── Shared data ────────────────────────────────────────────
// Weekly TTT moved to its own TTT Week feature (/api/ttt).
const SERIES_MAX = { ladder: 30, zrl: 24, dirt: 20, herd: 30 };
const CATS = ['A+', 'A', 'B', 'C', 'D'];
const KEYS = {
  signups: 'cg:signups', // field "<series>|<lowercase name>"
  locks: 'cg:locks',     // field "<series>" -> "1"
  rides: 'cg:rides',     // field "<ride id>" -> ride JSON
  rsvps: 'cg:rsvps',     // field "<ride id>|<lowercase name>"
  rideSent: 'cg:rides:sent', // field "<ride id>:reminder" -> ISO time, so a ride is announced once
};

const ROLE_PASSWORD_ENV = { admin: 'ADMIN_PASSWORD', mod: 'MOD_PASSWORD' };
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

function sendJSON(res, statusCode, obj){
  const s = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': SITE_ORIGIN
  });
  res.end(s);
}

// Reads the path and query of a request with the standard URL class (url.parse is deprecated and
// logged a warning on every request). Leading double slashes are collapsed so they can't be read as a host.
function parseRequestUrl(req){
  try {
    const u = new URL(String(req.url || '/').replace(/^\/{2,}/, '/'), 'http://localhost');
    return { pathname: u.pathname, query: Object.fromEntries(u.searchParams) };
  } catch (e) {
    throw new HttpError(400, 'bad request');
  }
}

function readJSONBody(req, limit = 20000){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > limit){ reject(new HttpError(413, 'request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Auth ───────────────────────────────────────────────────
function passwordMatches(given, expected){
  // Compare hashes so the comparison is constant-time regardless of input length.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenSecret(){
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Derived from the passwords, so changing a password also signs everyone out.
  return crypto.createHash('sha256')
    .update(`cg-session|${process.env.ADMIN_PASSWORD || ''}|${process.env.MOD_PASSWORD || ''}`)
    .digest('hex');
}

function signToken(role, extra = {}){
  const payload = Buffer.from(JSON.stringify({ ...extra, role, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function sessionFromRequest(req){
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return session.exp > Date.now() ? session : null;
  } catch (e) { return null; }
}

// Staff role ('admin' / 'mod'), or null. A member session is never a staff role.
function roleFromRequest(req){
  const session = sessionFromRequest(req);
  return session && ROLE_PASSWORD_ENV[session.role] ? session.role : null;
}

// A rider who signed in with their cryogen.team account: { zwid, name }, or null.
function memberFromRequest(req){
  const session = sessionFromRequest(req);
  return session && session.role === 'member' && /^\d{1,12}$/.test(String(session.zwid)) && session.name
    ? { zwid: String(session.zwid), name: String(session.name), assoc: session.assoc === true } : null;
}

function memberLoginRequired(){
  return process.env.REQUIRE_MEMBER_LOGIN === '1' || process.env.VERCEL_ENV === 'production';
}

// Who a sign-up / withdrawal / RSVP is for. A signed-in member always acts as themselves.
// Staff and (when member login is not required) guests name the rider in the request.
function identify(req, body){
  const member = memberFromRequest(req);
  if (member) return member;
  if (!roleFromRequest(req) && memberLoginRequired()){
    throw new HttpError(401, 'Please sign in with your cryogen.team account.');
  }
  return {
    name: text(body.name, 'name', 60).replace(/\s+/g, ' '),   // spacing alone never makes a second rider
    zwid: /^\d{1,12}$/.test(String(body.zwid || '')) ? String(body.zwid) : '',
  };
}

function requireRole(req, roles){
  const role = roleFromRequest(req);
  if (!role) throw new HttpError(401, 'Please log in again.');
  if (!roles.includes(role)) throw new HttpError(403, 'Not allowed for your role.');
  return role;
}

// ── Abuse limits (counters live in Redis, so every server instance shares them; if Redis is down they fail open) ──
function clientIp(req){
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
async function counter(key, windowSec){
  try { return (await redis([['INCR', key], ['EXPIRE', key, windowSec]]))[0]; } catch (e) { return 0; }
}
async function peek(key){
  try { return Number((await redis([['GET', key]]))[0]) || 0; } catch (e) { return 0; }
}
const LOGIN_WINDOW_SEC = 900;
const loginMaxFails = () => Number(process.env.LOGIN_MAX_FAILS) || 10;
const writesPerMinute = () => Number(process.env.RATE_LIMIT_WRITES_PER_MIN) || 120;

async function handleLogin(req, res){
  const payload = await readJSONBody(req);
  // A personal staff account: username and password.
  if (payload.username !== undefined){
    const failKey = `cg:rl:login:${clientIp(req)}`;
    if (await peek(failKey) >= loginMaxFails()) throw new HttpError(429, 'Too many wrong passwords from this connection. Try again in 15 minutes.');
    const u = typeof payload.password === 'string' ? await staff.verify(String(payload.username), payload.password) : null;
    if (u) return sendJSON(res, 200, { role: u.role, name: u.name, token: signToken(u.role, { staffName: u.name, user: u.username }) });
    await counter(failKey, LOGIN_WINDOW_SEC);
    return sendJSON(res, 401, { error: 'incorrect username or password' });
  }
  const envName = ROLE_PASSWORD_ENV[payload.role];
  if (!envName) throw new HttpError(400, 'unknown role');
  const expected = process.env[envName];
  if (!expected) return sendJSON(res, 503, { error: 'login not configured', missing: envName });
  // Too many wrong passwords from one address: no more tries (right or wrong) until the window passes.
  const failKey = `cg:rl:login:${clientIp(req)}`;
  if (await peek(failKey) >= loginMaxFails()) throw new HttpError(429, 'Too many wrong passwords from this connection. Try again in 15 minutes.');
  if (typeof payload.password === 'string' && passwordMatches(payload.password, expected)){
    return sendJSON(res, 200, { role: payload.role, token: signToken(payload.role) });
  }
  await counter(failKey, LOGIN_WINDOW_SEC);
  sendJSON(res, 401, { error: 'incorrect password' });
}

// ── Redis (Upstash REST API, as added through the Vercel Marketplace) ──
function redisConfig(){
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ''), token } : null;
}

// Rough daily usage so a quota is seen coming: counted in this process and added to the day's totals on every scheduled run.
// Each running copy of the app counts its own, so the totals are a floor, not an exact bill.
const usage = { redis: 0, discord: 0 };
async function redis(commands){
  const cfg = redisConfig();
  usage.redis += commands.length;
  if (!cfg) throw new HttpError(503, 'Shared storage is not set up yet.');
  let r;
  try {
    r = await fetch(`${cfg.base}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(8000),   // a stuck connection must fail fast, not hold the request until the platform kills it
    });
  } catch (e) {
    throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, e && e.name === 'TimeoutError' ? 'Shared storage did not answer in time.' : 'Shared storage could not be reached.');
  }
  if (!r.ok) throw new HttpError(502, `storage error (${r.status})`);
  const out = await r.json();
  const failed = out.find(x => x.error);
  if (failed) throw new HttpError(502, `storage error: ${failed.error}`);
  return out.map(x => x.result);
}

// HGETALL comes back as a flat [field, value, field, value, ...] array.
function pairs(flat){
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

async function loadState(){
  const [signups, locks, rides, rsvps] = await redis([
    ['HGETALL', KEYS.signups], ['HGETALL', KEYS.locks], ['HGETALL', KEYS.rides], ['HGETALL', KEYS.rsvps],
  ]);
  const state = { signups: {}, locks: {}, rides: [], rsvps: {} };
  for (const s of Object.keys(SERIES_MAX)) state.signups[s] = [];
  for (const [field, value] of pairs(signups)){
    const series = field.split('|')[0];
    if (state.signups[series]) state.signups[series].push(JSON.parse(value));
  }
  for (const [series, value] of pairs(locks)) state.locks[series] = value === '1';
  for (const [, value] of pairs(rides)) state.rides.push(JSON.parse(value));
  for (const [field, value] of pairs(rsvps)){
    const rideId = field.slice(0, field.indexOf('|'));
    (state.rsvps[rideId] = state.rsvps[rideId] || []).push(JSON.parse(value));
  }
  for (const list of Object.values(state.signups)) list.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const list of Object.values(state.rsvps)) list.sort((a, b) => a.ts.localeCompare(b.ts));
  return state;
}

// ── Input validation ───────────────────────────────────────
function text(value, field, max, required = true){
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required) throw new HttpError(400, `Please enter a ${field}.`);
  if (s.length > max) throw new HttpError(400, `The ${field} is too long (max ${max} characters).`);
  return s;
}

function series(value){
  if (!Object.prototype.hasOwnProperty.call(SERIES_MAX, value)) throw new HttpError(400, 'unknown series');
  return value;
}

function rideId(value){
  const s = String(value == null ? '' : value);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s)) throw new HttpError(400, 'invalid ride id');
  return s;
}

function linkOrEmpty(value){
  const s = text(value, 'link', 500, false);
  if (s && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'The link must start with http:// or https://');
  return s;
}

// ── Shared-data routes ─────────────────────────────────────
// Every write returns the full, fresh state so the page can re-render from it.
const DATA_ROUTES = {
  'GET /api/state': async () => loadState(),

  'POST /api/signups': async (req, body) => {
    const s = series(body.series);
    const { name, zwid } = identify(req, body);
    const cat = CATS.includes(body.cat) ? body.cat : 'B';
    const [locked, all] = await redis([['HGET', KEYS.locks, s], ['HKEYS', KEYS.signups]]);
    if (locked === '1') throw new HttpError(409, 'Sign-ups are locked.');
    if (all.filter(f => f.startsWith(`${s}|`)).length >= SERIES_MAX[s]) throw new HttpError(409, 'Event is full.');
    const entry = { name, cat, zwid, ts: new Date().toISOString() };
    const [added] = await redis([['HSETNX', KEYS.signups, `${s}|${name.toLowerCase()}`, JSON.stringify(entry)]]);
    if (!added) throw new HttpError(409, 'Already signed up!');
  },

  'POST /api/signups/remove': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    await redis([['HDEL', KEYS.signups, `${series(body.series)}|${text(body.name, 'name', 60).toLowerCase()}`]]);
  },

  'POST /api/signups/clear': async (req) => {
    requireRole(req, ['admin']);
    await redis([['DEL', KEYS.signups]]);
  },

  'POST /api/locks': async (req, body) => {
    requireRole(req, ['admin']);
    const s = series(body.series);
    await redis([body.locked ? ['HSET', KEYS.locks, s, '1'] : ['HDEL', KEYS.locks, s]]);
  },

  'POST /api/rides': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const date = text(body.date, 'date', 10);
    if (!validDate(date)) throw new HttpError(400, 'The date must be a real date, like 2026-10-28.');
    const ride = {
      id: String(Date.now()),
      title: text(body.title, 'title', 100),
      date,
      time: text(body.time, 'time', 20, false),
      route: text(body.route, 'route', 100, false),
      dist: text(body.dist, 'distance', 30, false),
      pace: text(body.pace, 'pace', 30, false),
      desc: text(body.desc, 'description', 500, false),
      link: linkOrEmpty(body.link),
      max: Math.min(Math.max(parseInt(body.max, 10) || 25, 1), 500),
      cat: text(body.cat, 'category', 20, false) || 'All',
    };
    await redis([['HSET', KEYS.rides, ride.id, JSON.stringify(ride)]]);
  },

  // Staff: who has RSVP'd, as a spreadsheet (CSV): every ride from today on, or one ride (?id=). Formula-looking names are neutralised.
  'GET /api/rides/export': async (req) => {
    requireRole(req, ['admin', 'mod']);
    const id = String(parseRequestUrl(req).query.id || '');
    const state = await loadState();
    const today = new Date().toISOString().slice(0, 10);
    const cell = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rides = state.rides.filter(r => (id ? r.id === id : r.date >= today)).sort((a, b) => a.date.localeCompare(b.date));
    if (id && !rides.length) throw new HttpError(404, 'That ride was not found.');
    const rows = [['Ride', 'Date', 'Time', 'Rider', 'RSVP made']];
    for (const r of rides) for (const x of state.rsvps[r.id] || []) rows.push([r.title, r.date, r.time || '', x.name, x.ts || '']);
    if (rows.length === 1) throw new HttpError(409, 'Nobody has RSVP\'d yet.');
    return { filename: `rsvps-${id ? 'ride' : 'upcoming'}-${today}.csv`, csv: rows.map(r => r.map(cell).join(',')).join('\n') };
  },

  'POST /api/rides/remove': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const id = rideId(body.id);
    const [fields] = await redis([['HKEYS', KEYS.rsvps]]);
    const rsvpFields = fields.filter(f => f.startsWith(`${id}|`));
    await redis([['HDEL', KEYS.rides, id], ...(rsvpFields.length ? [['HDEL', KEYS.rsvps, ...rsvpFields]] : [])]);
  },

  'POST /api/rsvps': async (req, body) => {
    const id = rideId(body.rideId);
    const { name } = identify(req, body);
    const entry = { name, ts: new Date().toISOString() };
    const [added] = await redis([['HSETNX', KEYS.rsvps, `${id}|${name.toLowerCase()}`, JSON.stringify(entry)]]);
    if (!added) throw new HttpError(409, "Already RSVP'd!");
  },

  'POST /api/rsvps/cancel': async (req, body) => {
    await redis([['HDEL', KEYS.rsvps, `${rideId(body.rideId)}|${identify(req, body).name.toLowerCase()}`]]);
  },
};

// ── TTT week ───────────────────────────────────────────────
// One "current week" plus an archive of past weeks. Riders sign up, staff assign
// them to teams, then publish the line-ups for everyone to see.
const TTT_KEYS = {
  week: 'cg:ttt:week',         // JSON {id, title, date, open, published, teams:[{id,name,level,zone,max}]}
  signups: 'cg:ttt:signups',   // field "<lowercase name>" -> signup JSON
  assign: 'cg:ttt:assign',     // field "<lowercase name>" -> JSON array of team ids
  archive: 'cg:ttt:archive',   // field "<week id>" -> snapshot JSON
  sent: 'cg:ttt:sent',         // field "<week id>:<event>" -> ISO time; makes scheduled events fire once
  last: 'cg:ttt:last',         // field "<zwid, or lowercase name>" -> the settings of that rider's last available sign-up (for "run it back")
};
const TTT_STYLES = ['race', 'casual'];
const TTT_TEAM_MAX = 6; // default riders per team
// Starting teams, taken from the club's TEAM LIST sheet. Staff can edit them in the dashboard.
const DEFAULT_TTT_TEAMS = [
  ['Hawks', 'Latte', 'Zone 22'], ['Magpies', 'Latte+', 'Zone 22'], ['Kites', 'Mocha', 'Zone 22'],
  ['Buzzards', 'Frappe', 'Zone 15'], ['Kestrels', 'Frappe', 'Zone 9'], ['Kawaus', 'Latte+', 'Zone 9'],
  ['Snow Geese', 'Latte+', 'Zone 8'], ['Owls', 'Mocha', 'Zone 8'], ['Crows', 'Latte', 'Zone 30'],
].map(([name, level, zone]) => ({ id: teamId(name), name, level, zone, max: TTT_TEAM_MAX }));

function teamId(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'team';
}

function parseTeams(list){
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one team.');
  if (list.length > 40) throw new HttpError(400, 'Too many teams (max 40).');
  const seen = new Set();
  return list.map(t => {
    const name = text(t && t.name, 'team name', 40);
    const id = teamId(name);
    if (seen.has(id)) throw new HttpError(400, `Two teams are called "${name}".`);
    seen.add(id);
    return {
      id, name,
      level: text(t.level, 'team level', 30, false),
      zone: text(t.zone, 'team zone', 30, false),
      max: Math.min(Math.max(parseInt(t.max, 10) || TTT_TEAM_MAX, 1), 20),
    };
  });
}

// ── TTT schedule (UK time) ─────────────────────────────────
// Race is on the week's date. Sign-ups close CLOSE_DAYS_BEFORE days earlier at CLOSE_TIME,
// a reminder goes out 24h before that, and the next week starts the day after the race.
const TTT_TZ = 'Europe/London';
const TTT_CLOSE_DAYS_BEFORE = 2;   // Wednesday race -> Monday
const TTT_CLOSE_HOUR = 19;         // 7pm
const TTT_NEXT_WEEK_HOUR = 9;      // 9am the day after the race
const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.SITE_URL || 'https://club.cryo-gen.team';
const SITE_ORIGIN = new URL(SITE_URL).origin;

function addDays(ymd, n){
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function ukOffsetMinutes(ms){
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: TTT_TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName').value; // "GMT" or "GMT+1"
  const m = /GMT([+-]\d+)?(?::(\d+))?/.exec(name);
  return m && m[1] ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
}

// UK wall-clock time on a given date -> UTC milliseconds (handles BST/GMT).
function ukTime(ymd, hour){
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0);
  return guess - ukOffsetMinutes(guess - ukOffsetMinutes(guess) * 60000) * 60000;
}

function ukLabel(ms){
  return new Date(ms).toLocaleString('en-GB', { timeZone: TTT_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' UK';
}

function weekTitle(ymd){
  return `Weekly TTT · ${new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}`;
}

function scheduleFor(week){
  const closesAt = week.closesAt ? Date.parse(week.closesAt) : null;
  return {
    closesAt,
    remindAt: closesAt ? closesAt - DAY_MS : null,
    nextWeekAt: ukTime(addDays(week.date, 1), TTT_NEXT_WEEK_HOUR),
  };
}

// ── Discord ────────────────────────────────────────────────
// Posts via channel webhooks: DISCORD_WEBHOOK_PUBLIC (club channel) and DISCORD_WEBHOOK_ADMIN (private admin channel) for the
// TTT. The ZRL has its own pair, DISCORD_WEBHOOK_ZRL_PUBLIC and DISCORD_WEBHOOK_ZRL_ADMIN, and uses the TTT ones when they are
// not set. A missing webhook just means that message isn't sent.
const DISCORD_HOOKS = {
  public: ['DISCORD_WEBHOOK_PUBLIC'],
  admin: ['DISCORD_WEBHOOK_ADMIN'],
  'zrl-public': ['DISCORD_WEBHOOK_ZRL_PUBLIC', 'DISCORD_WEBHOOK_PUBLIC'],
  'zrl-admin': ['DISCORD_WEBHOOK_ZRL_ADMIN', 'DISCORD_WEBHOOK_ADMIN'],
  ladder: ['DISCORD_WEBHOOK_LADDER', 'DISCORD_WEBHOOK_PUBLIC'],
  'ladder-admin': ['DISCORD_WEBHOOK_LADDER_ADMIN', 'DISCORD_WEBHOOK_ADMIN'],
  drs: ['DISCORD_WEBHOOK_DRS', 'DISCORD_WEBHOOK_PUBLIC'],
  'drs-admin': ['DISCORD_WEBHOOK_DRS_ADMIN', 'DISCORD_WEBHOOK_ADMIN'],
  comms: ['DISCORD_WEBHOOK_COMMS', 'DISCORD_WEBHOOK_PUBLIC'],
};
const discordEscape = t => String(t == null ? '' : t).replace(/([\\*_~`|>\[\]])/g, '\\$1');

const USAGE_KEY = 'cg:usage', REDIS_DAILY_LIMIT = () => Number(process.env.REDIS_DAILY_LIMIT) || 16000;
const usageDay = () => new Date().toISOString().slice(0, 10);
async function flushUsage(){
  const r = usage.redis, d = usage.discord; usage.redis = 0; usage.discord = 0;
  if (!r && !d) return [];
  const day = usageDay();
  await redis([['HINCRBY', USAGE_KEY, `${day}:redis`, r + 1], ['HINCRBY', USAGE_KEY, `${day}:discord`, d]]);
  return [];
}
const OUTBOX_KEY = 'cg:outbox', OUTBOX_MAX = 50, OUTBOX_TRIES = 5, OUTBOX_AGE_MS = 24 * 3600000;
async function sendHook(hook, payload){
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Never let rider-entered text ping @everyone, roles or users.
      body: JSON.stringify({ username: process.env.STAGING === '1' ? '[STAGING] CRYO-GEN TTT' : 'CRYO-GEN TTT', allowed_mentions: { parse: [] }, ...payload }),
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) return { ok: true };
    let wait = 0;
    if (r.status === 429) { try { wait = Number((await r.json()).retry_after) * 1000 || 0; } catch (e) { /* no body */ } }
    return { ok: false, status: r.status, transient: r.status === 429 || r.status >= 500, wait };
  } catch (e) {
    return { ok: false, status: 0, transient: true, wait: 0, error: e.message };
  }
}
// A post that hits a hiccup (Discord busy, a timeout) is tried once more straight away; if it still fails it goes in the outbox and the
// scheduled run keeps trying for up to a day. A bad hook (a 4xx other than "slow down") is not retried: that needs a person.
async function discord(channel, payload, opts = {}){
  const hook = (DISCORD_HOOKS[channel] || DISCORD_HOOKS.public).map(k => process.env[k]).find(Boolean);
  if (!hook) return false;
  let r = await sendHook(hook, payload);
  if (!r.ok && r.transient) { await new Promise(ok => setTimeout(ok, Math.min(r.wait || 400, 1500))); r = await sendHook(hook, payload); }
  usage.discord++;
  if (r.ok) return true;
  console.error(`Discord ${channel} webhook failed: ${r.status || r.error}`);
  if (r.transient && !opts.noQueue) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await redis([['HSET', OUTBOX_KEY, id, JSON.stringify({ channel, payload, tries: 1, at: Date.now() })]]).catch(() => {});
  }
  return false;
}
// Run from the schedule: send what is waiting, drop what is a day old or has failed five times, and tell the admin channel once about the drops.
async function flushOutbox(){
  const [all] = await redis([['HGETALL', OUTBOX_KEY]]);
  const entries = [];
  for (let i = 0; i < (all || []).length; i += 2) { try { entries.push([all[i], JSON.parse(all[i + 1])]); } catch (e) { await redis([['HDEL', OUTBOX_KEY, all[i]]]); } }
  entries.sort((a, b) => a[1].at - b[1].at);
  let sent = 0; const dropped = [];
  for (const [id, e] of entries.slice(0, OUTBOX_MAX)) {
    const hook = (DISCORD_HOOKS[e.channel] || DISCORD_HOOKS.public).map(k => process.env[k]).find(Boolean);
    const r = hook ? await sendHook(hook, e.payload) : { ok: false, transient: false };
    if (r.ok) { await redis([['HDEL', OUTBOX_KEY, id]]); sent++; continue; }
    e.tries++;
    if (!r.transient || e.tries > OUTBOX_TRIES || Date.now() - e.at > OUTBOX_AGE_MS) { await redis([['HDEL', OUTBOX_KEY, id]]); dropped.push(e); }
    else await redis([['HSET', OUTBOX_KEY, id, JSON.stringify(e)]]);
  }
  if (dropped.length) await discord('admin', { content: `📭 ${dropped.length} Discord message${dropped.length === 1 ? '' : 's'} could not be delivered and ${dropped.length === 1 ? 'was' : 'were'} dropped (first: "${discordEscape(String((dropped[0].payload && dropped[0].payload.content) || '').slice(0, 80))}"). Check the webhook for the ${dropped[0].channel} channel.` }, { noQueue: true });
  return sent ? [`Outbox: sent ${sent} waiting message${sent === 1 ? '' : 's'}`] : [];
}

const teamLabel = t => [t.level, t.zone].filter(Boolean).join(' · ');

function postSignupsOpen(week){
  const close = week.closesAt ? `\nSign-ups close **${ukLabel(Date.parse(week.closesAt))}**.` : '';
  return discord('public', {
    content: `📣 **TTT sign-ups are open — ${discordEscape(week.title)}**\nSign up at ${SITE_URL} → 🏁 TTT Week.\nRode last week? Tap **🔁 Run it back** there to sign up with the same settings in one go.${close}`,
    embeds: [{ title: 'Teams this week', color: 0x00d4ff,
      description: week.teams.map(t => `**${discordEscape(t.name)}** — ${discordEscape(teamLabel(t))} (max ${t.max})`).join('\n').slice(0, 4000) }],
  });
}

function postReminder(week, signups){
  const n = signups.filter(s => s.available).length;
  return discord('public', {
    content: `⏰ **Last day to sign up for ${discordEscape(week.title)}** — ${n} rider${n === 1 ? '' : 's'} signed up so far.\nSign-ups close **${ukLabel(Date.parse(week.closesAt))}**: ${SITE_URL}\nSame as last week? Tap **🔁 Run it back** on the TTT Week page.`,
  });
}

// Race-day summary for the staff channel: teams racing, those under four riders, those with no captain, line-ups not published, and available
// riders who are in no team.
function postTttDigest(week, signups, assign){
  const n = {};
  for (const ids of Object.values(assign || {})) for (const id of ids) n[id] = (n[id] || 0) + 1;
  const racing = week.teams.filter(t => n[t.id]);
  const short = racing.filter(t => n[t.id] < 4).map(t => `${discordEscape(t.name)} (${n[t.id]})`);
  const noCaptain = racing.filter(t => !(week.captains || {})[t.id]).map(t => discordEscape(t.name));
  const unplaced = signups.filter(s => s.available && !(assign[s.name.toLowerCase()] || []).length).length;
  const lines = [`📅 **${discordEscape(week.title)}: race day**`, `• ${racing.length} team${racing.length === 1 ? '' : 's'} racing`,
    week.published ? '• ✅ Line-ups are published' : '• ⚠️ The line-ups are not published yet'];
  if (short.length) lines.push(`• ⚠️ Under 4 riders: ${short.join(', ')}`);
  if (noCaptain.length) lines.push(`• ⭐ No captain yet: ${noCaptain.join(', ')}`);
  if (unplaced) lines.push(`• ${unplaced} available rider${unplaced === 1 ? ' is' : 's are'} in no team`);
  lines.push(`${SITE_URL} → 🏁 TTT Week`);
  return discord('admin', { content: lines.join('\n') });
}
function postClosed(week, signups, assign, auto){
  const avail = signups.filter(s => s.available);
  const unplaced = avail.filter(s => !(assign[s.name.toLowerCase()] || []).length).length;
  const extra = auto ? [`🤖 Teams suggested automatically: ${auto.placed} placed${auto.merged && auto.merged.length ? `, ${auto.merged.length} moved out of a team that was too small` : ''}.`,
    auto.short.length ? `⚠️ Under 4 riders: ${auto.short.join(', ')}` : '', auto.noCaptain.length ? `⭐ No captain yet: ${auto.noCaptain.join(', ')}` : '', auto.unplaced.length ? `❌ Could not fit: ${auto.unplaced.join(', ')}` : '', auto.outside.length ? `↔️ Outside their choices: ${auto.outside.join(', ')}` : ''].filter(Boolean).join('\n') + '\n' : '';
  return Promise.all([
    discord('public', { content: `🔒 Sign-ups for **${discordEscape(week.title)}** are closed — ${avail.length} rider${avail.length === 1 ? '' : 's'}. Line-ups coming soon.` }),
    discord('admin', { content: `🛠️ **${discordEscape(week.title)}**: sign-ups closed — ${avail.length} available, ${unplaced} not yet in a team.\n${extra}${auto ? 'Check the teams and publish' : 'Build and publish the teams'}: ${SITE_URL} → 🏁 TTT Week` }),
  ]);
}

function postLineups(week, signups, assign){
  const captains = captainsOf({ week, assign });
  const byTeam = Object.fromEntries(week.teams.map(t => [t.id, []]));
  for (const s of signups) for (const id of assign[s.name.toLowerCase()] || []) if (byTeam[id]) byTeam[id].push(s);
  return discord('public', {
    content: `🏁 **Line-ups published — ${discordEscape(week.title)}**\nFull details: ${SITE_URL} → 🏁 TTT Week`
      + (() => { const w = waitlistOf({ week, signups, assign }); return w.length ? `\n⏳ Waitlist: ${w.map(s => discordEscape(s.name)).join(', ')}` : ''; })(),
    embeds: [{ color: 0x10b981, fields: week.teams.slice(0, 25).map(t => ({
      name: `${t.name} · ${teamLabel(t)} (${byTeam[t.id].length}/${t.max})`.slice(0, 256),
      value: (byTeam[t.id].map(s => {
        const cap = captains[t.id] === s.name.toLowerCase();
        return `${cap ? '⭐ ' : ''}${s.cat ? `[${s.cat}] ` : ''}${discordEscape(s.name)}${cap ? ' (captain)' : ''}`;
      }).join('\n') || '—').slice(0, 1024),
      inline: true,
    })) }],
  });
}

async function loadTtt(){
  const [week, signups, assign, archiveIds] = await redis([
    ['GET', TTT_KEYS.week], ['HGETALL', TTT_KEYS.signups], ['HGETALL', TTT_KEYS.assign], ['HKEYS', TTT_KEYS.archive],
  ]);
  return {
    week: week ? JSON.parse(week) : null,
    signups: pairs(signups).map(([, v]) => JSON.parse(v)).sort((a, b) => a.ts.localeCompare(b.ts)),
    assign: Object.fromEntries(pairs(assign).map(([k, v]) => [k, JSON.parse(v)])),
    archive: archiveIds.sort().reverse(),
  };
}

// What a given role may see: comments are staff-only, and line-ups stay hidden until published.
function tttView(data, role){
  const staff = role === 'admin' || role === 'mod';
  const showLineups = staff || (data.week && data.week.published);
  return {
    week: data.week,
    signups: data.signups.map(s => (staff ? s : { ...s, comments: undefined })),
    assign: showLineups ? data.assign : {},
    captains: showLineups ? captainsOf(data) : {},
    waitlist: data.week && (data.week.published || staff) ? waitlistOf(data).map(s => s.name) : [],
    archive: data.archive,
    role: role || null,
  };
}

async function requireWeek(){
  const data = await loadTtt();
  if (!data.week) throw new HttpError(409, 'No TTT week has been started yet.');
  return data;
}

async function weekWith(changes){
  const data = await requireWeek();
  const week = { ...data.week, ...changes };
  await redis([['SET', TTT_KEYS.week, JSON.stringify(week)]]);
}

// Results to Discord: one club-channel message listing every team whose result was just entered for
// the first time. Corrections to an existing result stay quiet.
const hasResult = r => Boolean(r && (r.dnf || r.position || r.time));
const newResultIds = (before, after) => Object.keys(after).filter(id => hasResult(after[id]) && !hasResult((before || {})[id]));
const ordinalWord = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;
const resultWords = r => (r.dnf ? 'DNF' : [r.position ? `${ordinalWord(r.position)}${r.of ? ` of ${r.of}` : ''}` : '', r.time].filter(Boolean).join(' · '));
const MEDALS = ['🥇', '🥈', '🥉'];

function postResults(week, signups, assign, teamIds){
  const names = new Map(signups.map(s => [s.name.toLowerCase(), s.name]));
  const rows = week.teams.filter(t => teamIds.includes(t.id)).map(t => ({ t, r: week.results[t.id] }))
    .sort((a, b) => (Boolean(a.r.dnf) - Boolean(b.r.dnf)) || ((a.r.position || 9999) - (b.r.position || 9999)) || String(a.r.time).localeCompare(String(b.r.time)));
  const build = withRiders => rows.map(({ t, r }) => {
    const medal = !r.dnf && r.position >= 1 && r.position <= 3 ? MEDALS[r.position - 1] : '🏁';
    const link = r.link && !/[<>\s]/.test(r.link) ? ` · [results](<${r.link}>)` : '';
    const captain = (week.captains || {})[t.id];
    const riders = Object.entries(assign || {}).filter(([, ids]) => ids.includes(t.id))
      .map(([k]) => `${k === captain ? '⭐ ' : ''}${discordEscape(names.get(k) || k)}`);
    return `${medal} **${discordEscape(t.name)}** — ${resultWords(r)}${link}` + (withRiders && riders.length ? `\n      ${riders.join(', ')}` : '');
  }).join('\n');
  const head = `🏁 **Results — ${discordEscape(week.title)}**\n`;
  let body = build(true);
  if (head.length + body.length > 1900) body = build(false); // drop the rider lists before cutting anything
  return discord('public', { content: (head + body).slice(0, 1990) });
}

// Team results are typed in by staff after the race and stored on the week (current or archived).
function parseResults(body, teams){
  const out = {};
  for (const t of teams){
    const r = (body && body[t.id]) || {};
    const time = text(r.time, `${t.name} time`, 12, false);
    if (time && !/^(\d{1,2}:)?\d{1,2}:\d{2}(\.\d{1,3})?$/.test(time)) throw new HttpError(400, `${t.name}: time must look like 24:31 or 1:02:05.`);
    const position = r.position === '' || r.position == null ? null : parseInt(r.position, 10);
    const of = r.of === '' || r.of == null ? null : parseInt(r.of, 10);
    if (position !== null && !(position >= 1 && position <= 9999)) throw new HttpError(400, `${t.name}: position must be a number.`);
    if (of !== null && !(of >= 1 && of <= 9999)) throw new HttpError(400, `${t.name}: number of teams must be a number.`);
    if (position !== null && of !== null && position > of) throw new HttpError(400, `${t.name}: position can't be higher than the number of teams.`);
    const link = linkOrEmpty(r.link);
    const dnf = r.dnf === true;
    if (time || position !== null || link || dnf) out[t.id] = { time, position, of, link, dnf };
  }
  return out;
}

const TTT_ROUTES = {
  'GET /api/ttt': async () => {},

  // Staff: the TTT thank-you for the current season (or every week if no season is set): team wins, riders with the most podiums, and who rode the most weeks.
  'GET /api/ttt/recognition': async req => { requireRole(req, ['admin', 'mod']); return tttRecognition(); },
  'POST /api/ttt/post-recognition': async req => {
    requireRole(req, ['admin', 'mod']);
    const r = await tttRecognition();
    const [claimed] = await redis([['HSETNX', TTT_KEYS.sent, `recognition:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
    if (!claimed) throw new HttpError(429, 'That was posted a moment ago.');
    for (const m of r.messages) await discord('public', { content: m });
    return { posted: r.messages.length };
  },

  'POST /api/ttt/results': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const weekId = String(body.weekId || '');
    const current = await loadTtt();
    if (current.week && current.week.id === weekId){
      const results = parseResults(body.results, current.week.teams);
      await weekWith({ results });
      const fresh = newResultIds(current.week.results, results);
      if (fresh.length) await postResults({ ...current.week, results }, current.signups, current.assign, fresh);
      return;
    }
    // Results usually arrive after the Thursday rollover, so archived weeks can be updated too.
    const [snap] = await redis([['HGET', TTT_KEYS.archive, weekId]]);
    if (!snap) throw new HttpError(404, 'That week was not found.');
    const data = JSON.parse(snap);
    const results = parseResults(body.results, data.week.teams);
    const fresh = newResultIds(data.week.results, results);
    data.week = { ...data.week, results };
    await redis([['HSET', TTT_KEYS.archive, weekId, JSON.stringify(data)]]);
    if (fresh.length) await postResults(data.week, data.signups || [], data.assign || {}, fresh);
    return tttView({ ...data, archive: current.archive }, roleFromRequest(req));
  },

  'GET /api/ttt/archive': async (req) => {
    const id = String(parseRequestUrl(req).query.id || '');
    const [snap] = await redis([['HGET', TTT_KEYS.archive, id]]);
    if (!snap) throw new HttpError(404, 'That week is not in the archive.');
    const data = JSON.parse(snap);
    return tttView({ ...data, archive: [] }, roleFromRequest(req));
  },

  // Staff: ask the club for riders: how many teams are short and who has signed up so far. While sign-ups are open, once a day.
  'POST /api/ttt/recruit': async (req) => {
    requireRole(req, ['admin', 'mod']);
    const { week } = await requireWeek();
    if (!week.open) throw new HttpError(409, 'Sign-ups are closed. Reopen them before asking for riders.');
    const day = new Date().toISOString().slice(0, 10);
    const [claimed] = await redis([['HSETNX', TTT_KEYS.sent, `${week.id}:recruit:${day}`, new Date().toISOString()]]);
    if (!claimed) throw new HttpError(429, 'A message asking for riders was already posted today.');
    const data = await loadTtt();
    const n = {};
    for (const ids of Object.values(data.assign)) for (const id of ids) n[id] = (n[id] || 0) + 1;
    const short = week.teams.filter(t => n[t.id] && n[t.id] < 4);
    const available = data.signups.filter(s => s.available).length;
    await discord('public', { content: `🚴 **${discordEscape(week.title)}: we need more riders!**\n${available} signed up so far${short.length ? `, and ${short.length} team${short.length === 1 ? ' is' : 's are'} short of riders` : ''}. Every team needs at least four.\nSign up in a minute: ${SITE_URL} → 🏁 TTT Week` });
    return { posted: true, available, short: short.length };
  },

  // Staff: a spreadsheet (CSV) of this week's line-ups, or the season's results. Cells that look like formulas are neutralised.
  'GET /api/ttt/export': async (req) => {
    requireRole(req, ['admin', 'mod']);
    const q = parseRequestUrl(req).query;
    const cell = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const rows = [];
    if (q.kind === 'results') {
      const [data, seasons] = await Promise.all([loadTtt(), loadSeasons()]);
      const choices = seasonChoices(seasons, data.archive);
      const choice = choices.find(c => c.id === (q.season || choices[choices.length - 1].id));
      if (!choice) throw new HttpError(404, 'That season does not exist.');
      const ids = data.archive.filter(id => inSeason(id, choice)).slice(0, SEASON_MAX_WEEKS);
      const snaps = ids.length ? (await redis(ids.map(id => ['HGET', TTT_KEYS.archive, id]))).map(x => (x ? JSON.parse(x) : null)) : [];
      if (data.week && inSeason(data.week.date, choice) && Object.keys(data.week.results || {}).length) snaps.unshift({ week: data.week, signups: data.signups, assign: data.assign });
      rows.push(['Date', 'Week', 'Team', 'Level', 'Zone', 'Position', 'Time', 'Did not finish', 'Captain', 'Riders']);
      for (const w of seasonSummary(snaps).weeks.slice().reverse()) for (const t of w.teams) {
        if (!t.result) continue;
        rows.push([w.date, w.title, t.name, t.level || '', t.zone || '', t.result.dnf ? '' : (t.result.position || ''), t.result.time || '', t.result.dnf ? 'yes' : '', t.captain || '', t.riders.join('; ')]);
      }
      if (rows.length === 1) throw new HttpError(409, 'There are no results to export yet.');
      return { filename: `ttt-results-${String(choice.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'all'}.csv`, csv: rows.map(r => r.map(cell).join(',')).join('\n') };
    }
    const { week, signups, assign } = await requireWeek();
    const names = new Map(signups.map(s => [s.name.toLowerCase(), s.name]));
    rows.push(['Team', 'Level', 'Zone', 'Rider', 'Captain', 'Double-up']);
    for (const t of week.teams) for (const [k, ids] of Object.entries(assign)) if (ids.includes(t.id)) {
      rows.push([t.name, t.level || '', t.zone || '', names.get(k) || k, (week.captains || {})[t.id] === k ? 'yes' : '', ids.length > 1 ? 'yes' : '']);
    }
    if (rows.length === 1) throw new HttpError(409, 'No riders are in teams yet.');
    return { filename: `ttt-lineups-${week.date}.csv`, csv: rows.map(r => r.map(cell).join(',')).join('\n') };
  },

  'GET /api/ttt/season': async (req) => {
    const [data, seasons] = await Promise.all([loadTtt(), loadSeasons()]);
    const choices = seasonChoices(seasons, data.archive);
    const wanted = parseRequestUrl(req).query.season || choices[choices.length - 1].id; // default: the latest season
    const choice = choices.find(c => c.id === wanted);
    if (!choice) throw new HttpError(404, 'That season does not exist.');
    const ids = data.archive.filter(id => inSeason(id, choice)).slice(0, SEASON_MAX_WEEKS);
    const snaps = ids.length ? (await redis(ids.map(id => ['HGET', TTT_KEYS.archive, id]))).map(x => (x ? JSON.parse(x) : null)) : [];
    // This week counts once results have been entered, even before it rolls over.
    if (data.week && inSeason(data.week.date, choice) && Object.keys(data.week.results || {}).length) {
      snaps.unshift({ week: data.week, signups: data.signups, assign: data.assign });
    }
    return { ...seasonSummary(snaps), season: choice, seasons: choices };
  },

  'POST /api/ttt/seasons': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const name = text(body.name, 'season name', 40);
    const start = String(body.start || '');
    if (!validDate(start)) throw new HttpError(400, 'The start date must be a real date, like 2026-10-28.');
    const seasons = await loadSeasons();
    const last = seasons[seasons.length - 1];
    if (last && start <= last.start) throw new HttpError(409, `A new season must start after ${last.name} (${last.start}).`);
    seasons.push({ id: start, name, start });
    await redis([['SET', SEASONS_KEY, JSON.stringify(seasons)]]);
    const data = await loadTtt();
    return { seasons: seasonChoices(seasons, data.archive) };
  },

  'POST /api/ttt/seasons/remove': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const seasons = await loadSeasons();
    const kept = seasons.filter(x => x.id !== String(body.id || ''));
    if (kept.length === seasons.length) throw new HttpError(404, 'That season does not exist.');
    await redis([kept.length ? ['SET', SEASONS_KEY, JSON.stringify(kept)] : ['DEL', SEASONS_KEY]]);
    const data = await loadTtt();
    return { seasons: seasonChoices(kept, data.archive) }; // its weeks fall back into the season before it
  },

  'GET /api/ttt/mine': async (req) => {
    const member = memberFromRequest(req);
    if (!member) throw new HttpError(401, 'Sign in with your cryogen.team account to see your status.');
    const data = await loadTtt();
    const ids = data.archive.slice(0, MY_TTT_HISTORY);
    const snaps = ids.length ? await redis(ids.map(id => ['HGET', TTT_KEYS.archive, id])) : [];
    const own = data.signups.find(s => s.zwid === member.zwid);   // may be under another spelling of their name
    const out = myTttStatus(data, (own ? own.name : member.name).toLowerCase(), snaps.map(x => (x ? JSON.parse(x) : null)));
    const last = data.week ? await lastSettings(data, member, data.week) : null;
    if (last) out.repeat = { style: last.style, doubleUp: last.doubleUp, captain: last.captain, preferred: last.preferred.map(id => (data.week.teams.find(t => t.id === id) || { name: id }).name), same: !!own && own.available && own.style === last.style && own.doubleUp === last.doubleUp && own.captain === last.captain && JSON.stringify([...(own.preferred || [])].sort()) === JSON.stringify([...last.preferred].sort()) };
    return out;
  },

  'POST /api/ttt/signup': async (req, body) => {
    const { week } = await requireWeek();
    if (!week.open) throw new HttpError(409, 'TTT sign-ups are closed for this week.');
    const who = identify(req, body);
    const { zwid } = who;
    // One rider is one Zwift ID: if this rider already signed up under another spelling of their name, update that
    // sign-up (keeping its name, and so its team places) instead of creating a second one.
    const data = await loadTtt();
    const twin = zwid && data.signups.find(s => s.zwid === zwid);
    const name = twin ? twin.name : who.name;
    const teamIds = new Set(week.teams.map(t => t.id));
    const preferred = (Array.isArray(body.preferred) ? body.preferred : []).filter(id => teamIds.has(id)).slice(0, 5);
    const entry = {
      name,
      zwid,
      cat: CATS.includes(body.cat) ? body.cat : '',
      available: body.available !== false,
      style: TTT_STYLES.includes(body.style) ? body.style : 'casual',
      doubleUp: body.doubleUp === true,
      preferred,
      comments: text(body.comments, 'comment', 300, false),
      captain: body.captain === true,
      ts: new Date().toISOString(),
    };
    // Signing up again with the same name updates the entry but keeps their place in the queue.
    const key = name.toLowerCase();
    const existing = data.signups.find(s => s.name.toLowerCase() === key);
    if (existing) entry.ts = existing.ts;
    await redis([['HSET', TTT_KEYS.signups, key, JSON.stringify(entry)], ...(entry.available ? [['HSET', TTT_KEYS.last, zwid || key, JSON.stringify(lastOf(entry))]] : [])]);
    if (!week.published) return;
    const placed = (data.assign[key] || []).length > 0;
    const fresh = { ...data, signups: [...data.signups.filter(s => s.name.toLowerCase() !== key), entry] };
    if (placed && !entry.available){
      await freePlaces(fresh, key, name, 'is no longer available for');
    } else if (!placed && entry.available && (!existing || !existing.available)){
      // Late sign-up after publishing: straight into a picked team with room, otherwise the waitlist.
      const velo = await riderVelos([entry]);
      const { placements } = planTeams({ teams: week.teams, signups: [entry], assign: data.assign, velo: { ...velo } });
      const ids = (placements[key] || []).filter(id => !entry.preferred.length || entry.preferred.includes(id));
      if (ids.length){
        await redis([['HSET', TTT_KEYS.assign, key, JSON.stringify(ids)]]);
        await discord('admin', { content: `➕ Late sign-up: **${discordEscape(name)}** placed in **${discordEscape(ids.map(id => week.teams.find(t => t.id === id).name).join(' and '))}** — ${discordEscape(week.title)}.` });
      } else {
        const position = waitlistOf(fresh).findIndex(s => s.name.toLowerCase() === key) + 1;
        await discord('admin', { content: `⏳ Late sign-up: **${discordEscape(name)}** joined the waitlist (#${position}) — ${discordEscape(week.title)}.` });
      }
    }
  },

  // "Run it back": sign up again with the settings of the rider's last available sign-up (cat, style, double-up, captain, preferred teams that still exist).
  'POST /api/ttt/repeat': async (req) => {
    const member = memberFromRequest(req);
    if (!member) throw new HttpError(401, 'Sign in with your cryogen.team account.');
    const { week } = await requireWeek();
    if (!week.open) throw new HttpError(409, 'TTT sign-ups are closed for this week.');
    const last = await lastSettings(await loadTtt(), member, week);
    if (!last) throw new HttpError(404, 'There is no earlier sign-up to copy yet. Sign up once and next week it is one tap.');
    return TTT_ROUTES['POST /api/ttt/signup'](req, { name: member.name, zwid: member.zwid, cat: last.cat, available: true, style: last.style, doubleUp: last.doubleUp, captain: last.captain, preferred: last.preferred, comments: '' })
      .then(() => undefined);
  },

  // Staff: bring the Google Form sign-ups from the club sheet into this week's sign-ups (preview first, then apply). In-app sign-ups are never overwritten.
  'POST /api/ttt/import-sheet': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    await requireWeek();
    const [candidates, data] = await Promise.all([readTttSheet(), loadTtt()]);
    const taken = new Set(data.signups.map(s => s.name.toLowerCase())), takenIds = new Set(data.signups.map(s => s.zwid).filter(Boolean));
    const rows = candidates.map(c => ({ ...c, status: taken.has(c.name.toLowerCase()) || (c.zwid && takenIds.has(c.zwid)) ? 'exists' : 'new' }));
    const idsFor = names => data.week.teams.filter(t => (names || []).some(n => n.toLowerCase() === t.name.toLowerCase())).map(t => t.id).slice(0, 5);
    const fresh = rows.filter(r => r.status === 'new');
    if (!body.apply) return { preview: { rows, counts: { total: rows.length, new: fresh.length, exists: rows.length - fresh.length, unmatched: fresh.filter(r => !r.zwid).length, unavailable: fresh.filter(r => !r.available).length } } };
    if (fresh.length) {
      const now = new Date().toISOString();
      await redis(fresh.map(r => ['HSETNX', TTT_KEYS.signups, r.name.toLowerCase(), JSON.stringify({ name: r.name, zwid: r.zwid, cat: r.cat, available: r.available, style: r.style, doubleUp: r.doubleUp, preferred: idsFor(r.preferredNames), comments: '', captain: false, ts: now, source: 'sheet' })]));
    }
    return { ...tttView(await loadTtt(), roleFromRequest(req)), imported: fresh.length };
  },

  // Staff: read the published teams from the TEAM LIST tab (names with Zwift IDs beside them, in blocks across the sheet) and compare them with the
  // teams here. Preview first: which columns were read, and for each rider whether the app already agrees. Applying creates missing sign-ups and puts
  // unplaced riders on the team the sheet names (full teams are left alone); `overwrite` also moves riders the app has on another team.
  'POST /api/ttt/import-board': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    await requireWeek();
    const [board, data] = await Promise.all([readTttBoard(), loadTtt()]);
    let roster = []; try { roster = (await fetchRoster()).riders || []; } catch (e) { /* names are still compared */ }
    const byRosterName = new Map(); for (const r of roster) { const k = nameKey(r.name); byRosterName.set(k, byRosterName.has(k) ? null : r); }   // two riders with one name: no safe match
    for (const b of board.blocks) for (const r of b.riders) if (!r.zwid) { const m = byRosterName.get(nameKey(r.name)); if (m) r.zwid = String(m.riderId); }
    const teamByName = new Map(data.week.teams.map(t => [t.name.toLowerCase(), t]));
    const signupOf = (r) => data.signups.find(s => (r.zwid && s.zwid === r.zwid) || s.name.toLowerCase() === r.name.toLowerCase());
    const fill = {}; for (const ids of Object.values(data.assign)) for (const id of ids) fill[id] = (fill[id] || 0) + 1;
    const plan = [], seen = new Set();
    for (const b of board.blocks) {
      const team = teamByName.get(String(b.label).toLowerCase()) || null;
      for (const r of b.riders) {
        const key = `${r.zwid || r.name.toLowerCase()}|${b.label}`; if (seen.has(key)) continue; seen.add(key);
        const su = signupOf(r), placed = su ? (data.assign[su.name.toLowerCase()] || []) : [];
        const status = !team ? 'no-team' : placed.includes(team.id) ? 'same' : !su ? 'new' : placed.length ? 'elsewhere' : 'unplaced';
        plan.push({ name: r.name, zwid: r.zwid, block: b.cols, label: b.label, zone: b.zone, team: team ? team.id : '', status, appTeams: placed.map(id => (data.week.teams.find(t => t.id === id) || { name: id }).name) });
      }
    }
    const counts = Object.fromEntries(['same', 'new', 'unplaced', 'elsewhere', 'no-team'].map(k => [k, plan.filter(p => p.status === k).length]));
    const blocks = board.blocks.map(b => ({ cols: b.cols, label: b.label, zone: b.zone, riders: b.riders.length, withId: b.riders.filter(r => r.sheetId).length, team: teamByName.has(String(b.label).toLowerCase()) }));
    if (!body.apply) return { preview: { tab: board.tab, blocks, plan, counts } };
    const now = new Date().toISOString(), cmds = [], skipped = [];
    let created = 0, placedN = 0;
    for (const p of plan) {
      if (!p.team || p.status === 'same' || p.status === 'no-team') continue;
      if (p.status === 'elsewhere' && body.overwrite !== true) continue;
      const max = (data.week.teams.find(t => t.id === p.team) || {}).max || TTT_TEAM_MAX;
      if ((fill[p.team] || 0) >= max) { skipped.push({ name: p.name, reason: 'That team is full' }); continue; }
      const key = p.name.toLowerCase();
      if (p.status === 'new') { cmds.push(['HSETNX', TTT_KEYS.signups, key, JSON.stringify({ name: p.name, zwid: p.zwid, cat: '', available: true, style: 'casual', doubleUp: false, preferred: [], comments: '', captain: false, ts: now, source: 'sheet' })]); created++; }
      const su = signupOf(p), k = su ? su.name.toLowerCase() : key;
      cmds.push(['HSET', TTT_KEYS.assign, k, JSON.stringify([p.team])]);
      fill[p.team] = (fill[p.team] || 0) + 1; placedN++;
    }
    // With `prune` (the sheet wins): a rider the app has on a team whose block is on the sheet, but who is not in that block, comes off that team.
    let pruned = 0;
    if (body.prune === true) {
      const listed = new Map();
      for (const p of plan) if (p.team) (listed.get(p.team) || listed.set(p.team, new Set()).get(p.team)).add(p.name.toLowerCase()).add(p.zwid || p.name.toLowerCase());
      for (const su of data.signups) {
        const key = su.name.toLowerCase(), cur = data.assign[key] || [];
        const next = cur.filter(id => !listed.has(id) || listed.get(id).has(key) || (su.zwid && listed.get(id).has(su.zwid)));
        if (next.length !== cur.length) { cmds.push(next.length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(next)] : ['HDEL', TTT_KEYS.assign, key]); pruned++; }
      }
    }
    if (cmds.length) await redis(cmds);
    return { ...tttView(await loadTtt(), roleFromRequest(req)), board: { created, placed: placedN, pruned, skipped } };
  },

  'POST /api/ttt/withdraw': async (req, body) => {
    const who = identify(req, body);
    const key = who.name.toLowerCase();
    // Every sign-up that is this rider's: the name, and any other spelling carrying their Zwift ID.
    let data = await loadTtt();
    const keys = [...new Set([key, ...data.signups.filter(s => who.zwid && s.zwid === who.zwid).map(s => s.name.toLowerCase())])];
    for (const k of keys){
      const rider = data.signups.find(s => s.name.toLowerCase() === k);
      await redis([['HDEL', TTT_KEYS.signups, k]]);
      // Free their place(s); once line-ups are out, the waitlist moves up automatically.
      if (data.week && rider){
        await freePlaces({ ...data, signups: data.signups.filter(s => s.name.toLowerCase() !== k) }, k, rider.name, 'withdrew from');
      } else {
        await redis([['HDEL', TTT_KEYS.assign, k]]);
      }
      data = await loadTtt();
    }
  },

  'POST /api/ttt/assign': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const { week, signups } = await requireWeek();
    const key = text(body.name, 'name', 60).toLowerCase();
    if (!signups.some(s => s.name.toLowerCase() === key)) throw new HttpError(404, 'That rider has not signed up.');
    const ids = [...new Set(Array.isArray(body.teams) ? body.teams : [])].filter(Boolean);
    const valid = new Set(week.teams.map(t => t.id));
    if (ids.some(id => !valid.has(id))) throw new HttpError(400, 'Unknown team.');
    if (ids.length > 2) throw new HttpError(400, 'A rider can be in at most 2 teams.');
    await redis([ids.length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(ids)] : ['HDEL', TTT_KEYS.assign, key]]);
  },

  'POST /api/ttt/auto-assign': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const data = await requireWeek();
    const velo = await riderVelos(data.signups);
    const plan = tttAllocation(data, velo);
    // A preview shows who would go where and changes nothing; staff look, then apply.
    if (body && body.preview) {
      const nameOf = new Map(data.signups.map(x => [x.name.toLowerCase(), x.name]));
      return { plan: Object.entries(plan.placements).map(([key, ids]) => ({ name: nameOf.get(key) || key, teams: ids })), summary: plan.summary,
        captains: Object.entries(plan.newCaptains).map(([id, key]) => ({ team: id, name: nameOf.get(key) || key })) };
    }
    await redis(plan.commands);
    await recordTttAllocation(data, plan, 'staff').catch(e => console.error('Auto log:', e.message));
    return { ...tttView(await loadTtt(), roleFromRequest(req)), summary: plan.summary };
  },

  // Staff: switch the automatic allocation (when sign-ups close) on or off for this week.
  'POST /api/ttt/auto-settings': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    await requireWeek();
    await weekWith({ autoAllocate: body.allocate !== false });
  },

  'POST /api/ttt/captain': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const data = await requireWeek();
    const team = data.week.teams.find(t => t.id === body.team);
    if (!team) throw new HttpError(400, 'Unknown team.');
    const captains = { ...captainsOf(data) };
    const key = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    if (!key) delete captains[team.id];
    else if (!(data.assign[key] || []).includes(team.id)) throw new HttpError(400, `That rider isn't in ${team.name}.`);
    else captains[team.id] = key;
    await weekWith({ captains });
  },

  'POST /api/ttt/clear-assign': async (req) => {
    requireRole(req, ['admin', 'mod']);
    await requireWeek();
    await redis([['DEL', TTT_KEYS.assign]]);
    await weekWith({ captains: {} });
  },

  'POST /api/ttt/status': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const changes = {};
    if (typeof body.open === 'boolean') changes.open = body.open;
    if (typeof body.published === 'boolean') changes.published = body.published;
    const before = await requireWeek();
    await weekWith(changes);
    if (changes.published && !before.week.published){
      await postLineups({ ...before.week, ...changes }, before.signups, before.assign);
    }
  },

  'POST /api/ttt/teams': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const teams = parseTeams(body.teams);
    const { assign } = await requireWeek();
    await weekWith({ teams });
    // Drop assignments to teams that no longer exist.
    const valid = new Set(teams.map(t => t.id));
    const commands = [];
    for (const [key, ids] of Object.entries(assign)){
      const kept = ids.filter(id => valid.has(id));
      if (kept.length !== ids.length) commands.push(kept.length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(kept)] : ['HDEL', TTT_KEYS.assign, key]);
    }
    if (commands.length) await redis(commands);
  },

  'POST /api/ttt/new-week': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const date = text(body.date, 'date', 10);
    if (!validDate(date)) throw new HttpError(400, 'The date must be a real date, like 2026-10-28.');
    await startWeek(date, text(body.title, 'title', 80, false) || weekTitle(date));
  },
};

// The part of a sign-up worth repeating next week.
const lastOf = e => ({ cat: e.cat || '', style: e.style, doubleUp: !!e.doubleUp, captain: !!e.captain, preferred: e.preferred || [] });
// A rider's last available sign-up, from the "last" record, or failing that the newest archived week they were in. Preferred teams that
// are not in this week's list are dropped.
async function lastSettings(data, member, week){
  const key = member.name.toLowerCase();
  let found = null;
  const [raw] = await redis([['HGET', TTT_KEYS.last, member.zwid]]);
  if (raw) { try { found = JSON.parse(raw); } catch (e) { /* fall through */ } }
  if (!found) {
    const [byName] = await redis([['HGET', TTT_KEYS.last, key]]);
    if (byName) { try { found = JSON.parse(byName); } catch (e) { /* fall through */ } }
  }
  if (!found && data.archive.length) {
    const snaps = await redis(data.archive.slice(0, MY_TTT_HISTORY).map(id => ['HGET', TTT_KEYS.archive, id]));
    for (const raw2 of snaps) {
      let snap; try { snap = raw2 && JSON.parse(raw2); } catch (e) { snap = null; }
      const s = snap && (snap.signups || []).find(x => x.available && ((x.zwid && x.zwid === member.zwid) || x.name.toLowerCase() === key));
      if (s) { found = lastOf(s); break; }
    }
  }
  if (!found) return null;
  const ids = new Set(week.teams.map(t => t.id));
  return { cat: CATS.includes(found.cat) ? found.cat : '', style: TTT_STYLES.includes(found.style) ? found.style : 'casual', doubleUp: !!found.doubleUp, captain: !!found.captain,
    preferred: (found.preferred || []).filter(id => ids.has(id)).slice(0, 5) };
}

// The club's Google Form responses, as TTT sign-up candidates: name, Zwift ID (from the form's Zwift Power ID answer, else matched by name in the club
// roster), whether they are available, riding style, double-up, the teams they asked for. The last row for a name wins. The responses are not on
// the TEAM LIST tab (that tab holds the published teams), so the form tab is looked for: SHEET_TAB_TTT_FORM, the usual form tab names, then the
// workbook's first tab (where Google puts form responses by default). A tab is accepted only if it has the form's columns.
const nameKey = n => String(n || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const TTT_FORM_NAME = /^please select your name/i, TTT_FORM_OTHER = /enter your first name and surname|first name and surname/i;
function tttFormColumns(headers){
  const find = (re, not) => headers.find(h => re.test(h) && !(not && not.test(h)));
  const col = {
    name: find(TTT_FORM_NAME) || find(/^(riders?|name|full name)\b/i) || find(/\bname\b/i, /zwift|e-?mail|consent|other|first name/i),
    other: find(TTT_FORM_OTHER),
    zwid: find(/zwift ?power ?id|zwift ?id|zwid/i),
    cat: find(/^cat/i),
    avail: find(/^availability$/i) || find(/^avail/i) || find(/avail/i, /zone/i),
    style: find(/level for this week|practice or race|practice|competitive/i, /zone/i),
    region: find(/which region|^region/i),
    dbl: find(/double/i),
    teams: find(/teams you would like to ride/i),
  };
  return col;
}
const tttFormUsable = col => !!col.name && !!(col.zwid || col.avail);
async function tttFormRows(){
  const tried = [];
  for (const tab of [...new Set([process.env.SHEET_TAB_TTT_FORM, 'Form Responses 1', 'Form responses 1', SHEET_TABS['ttt-sheet'], `__first_tab_${Date.now()}`].filter(Boolean))]){
    let parsed;
    parsed = parseGviz(await fetchTab(tab));   // Google answers an unknown tab name with the first tab, so a real error (not shared, slow, down) is passed on
    const col = tttFormColumns(parsed.headers);
    if (tttFormUsable(col)) return { ...parsed, col, tab };
    tried.push(tab);
  }
  throw new HttpError(422, 'The sign-up form responses were not found in the Google Sheet: no tab has the form\'s "Please select your name" and "Availability" columns. Set SHEET_TAB_TTT_FORM to the form responses tab name.');
}
const teamNamesOf = v => String(v || '').split(/\)\s*,\s*/).map(x => x.replace(/\)\s*$/, '').split(/\s+-\s+/)[0].trim()).filter(Boolean);
async function readTttSheet(){
  const { rows, col } = await tttFormRows();
  let roster = [];
  try { roster = (await fetchRoster()).riders || []; } catch (e) { /* match nobody: names are still imported */ }
  const byName = new Map(), byId = new Map(roster.map(r => [String(r.riderId), r]));
  for (const r of roster) { const k = nameKey(r.name); byName.set(k, byName.has(k) ? null : r); }   // two riders with one name: no safe match
  const out = new Map();
  for (const row of rows) {
    let name = String(row[col.name] || '').trim().replace(/\s+/g, ' ');
    if ((!name || /^\*?other\*?$/i.test(name)) && col.other) name = String(row[col.other] || '').trim().replace(/\s+/g, ' ');
    if (!name || name === '-' || /^\*?other\*?$/i.test(name) || /^(total|riders? left|team\b)/i.test(name) || name.length > 60) continue;
    const idText = String(col.zwid ? row[col.zwid] : '').replace(/\D/g, '');
    const idRider = idText.length >= 4 && idText.length <= 9 ? byId.get(idText) : null;
    const r = idRider || byName.get(nameKey(name)) || null;
    const zwid = idRider ? idText : r ? String(r.riderId) : (idText.length >= 4 && idText.length <= 9 ? idText : '');
    const sheetCat = String(col.cat ? row[col.cat] : '').trim().toUpperCase();
    const availText = String(col.avail ? row[col.avail] : '');
    const styleText = String(col.style ? row[col.style] : '');
    out.set(name.toLowerCase(), {
      name: r && r.name ? String(r.name).trim() : name,
      zwid,
      cat: CATS.includes(sheetCat) ? sheetCat : CATS.includes(r && r.zpCategory) ? r.zpCategory : '',
      available: !/\bnot\b|unavailable|can'?t|no\b/i.test(availText),
      style: /compet|race/i.test(styleText) && !/not bothered/i.test(styleText) ? 'race' : 'casual',
      doubleUp: /^\s*y/i.test(String(col.dbl ? row[col.dbl] : '')),
      region: String(col.region ? row[col.region] : '').replace(/^-$/, '').trim(),
      note: availText.trim().slice(0, 60),
      preferredNames: teamNamesOf(col.teams ? row[col.teams] : ''),
    });
  }
  return [...out.values()];
}

// The TEAM LIST tab publishes the teams as blocks across the sheet (DH, FV, GH ...). A block starts with a "Zwiftpower name tag" cell such as
// "(CRYO-GEN Snow Geese)" with the time zone above it and the pen below; the riders' names run down that column, and a Zwift ID may sit in the
// column to the right (some blocks show it, others leave it empty), followed by the stats. So blocks are found by their tag cell, not by fixed
// letters, and a rider without an ID beside them is matched to the club roster by name. Where a sheet has no tag cells, columns of Zwift IDs with a
// column of names beside them are read instead. The preview shows exactly which columns were read.
const colLetters = i => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const ID_CELL = /^\d{4,9}$/;
const NOT_A_RIDER = /^(chart|zp cat|w\/kg|cp w\/kg|average power|team total|makeup|spread|team overall|time zones?|pen [a-e]|zone \d+|n\/a|unavailable)\b/i;
const HEADER_WORD = /^(riders?|names?|id|zwift ?id|total|cat|category|captain|latte\+?|mocha|frappe|espresso)$/i;
const looksLikeName = v => /[a-z]/i.test(v) && !/^\d/.test(v) && v.length <= 60 && !NOT_A_RIDER.test(v) && !HEADER_WORD.test(v) && !/^\(.*\)$/.test(v);
const tagLabel = inner => String(inner).replace(/^(toyota\s+)?cryo[\s-]*(gen|rdt)\s*/i, '').trim() || String(inner).trim();
function readTeamBoard(grid){
  const cell = (r, c) => String((grid[r] || [])[c] || '').trim();
  const width = Math.max(0, ...grid.map(r => r.length)), blocks = [];
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    for (let c = 0; c < width; c++) {
      const m = /^\((.{2,40})\)$/.exec(cell(r, c));
      if (!m || !/cryo/i.test(m[1])) continue;
      const riders = [];
      for (let rr = r + 1, started = false; rr < grid.length; rr++) {
        const v = cell(rr, c).replace(/\s+/g, ' ');
        if (!v) { if (started) break; continue; }
        if (!looksLikeName(v)) { if (started) break; continue; }
        started = true;
        const id = cell(rr, c + 1);
        riders.push({ row: rr, name: v, zwid: ID_CELL.test(id) ? id : '', sheetId: ID_CELL.test(id) });
      }
      if (riders.length) blocks.push({ cols: `${colLetters(c)}:${colLetters(c + 1)}`, label: tagLabel(m[1]), zone: r > 0 ? cell(r - 1, c) : '', riders });
    }
  }
  if (blocks.length) return blocks;
  for (let c = 1; c < width; c++) {   // no tag cells: a column of IDs with a column of names beside it
    const rows = [];
    for (let r = 0; r < grid.length; r++) {
      const name = cell(r, c - 1).replace(/\s+/g, ' '), id = cell(r, c);
      if (ID_CELL.test(id) && looksLikeName(name)) rows.push({ row: r, name, zwid: id, sheetId: true });
    }
    if (rows.length < 2) continue;
    let label = '';
    for (let r = rows[0].row - 1; r >= Math.max(0, rows[0].row - 8) && !label; r--) for (const cc of [c - 1, c]) { const v = cell(r, cc); if (v && !ID_CELL.test(v) && looksLikeName(v)) { label = v; break; } }
    blocks.push({ cols: `${colLetters(c - 1)}:${colLetters(c)}`, label, zone: '', riders: rows });
  }
  return blocks;
}
async function readTttBoard(){
  const tab = SHEET_TABS['ttt-sheet'];
  const grid = await fetchGrid(tab);
  return { tab, blocks: readTeamBoard(grid) };
}

// The plan for placing the available riders who have no team, and a captain (the strongest volunteer) for every started team without one.
function tttAllocation(data, velo){
  const { placements, summary } = planTeams({ teams: data.week.teams, signups: data.signups, assign: data.assign, velo });
  const commands = Object.entries(placements).map(([key, ids]) => ['HSET', TTT_KEYS.assign, key, JSON.stringify(ids)]);
  const assign = { ...data.assign, ...placements };
  const captains = captainsOf({ week: data.week, assign }), newCaptains = {};
  summary.noCaptain = [];
  for (const t of data.week.teams){
    if (!Object.values(assign).some(ids => ids.includes(t.id)) || captains[t.id]) continue;
    const pick = pickCaptain(t.id, data.signups, assign, velo);
    if (pick){ captains[t.id] = pick; newCaptains[t.id] = pick; } else summary.noCaptain.push(t.name);
  }
  commands.push(['SET', TTT_KEYS.week, JSON.stringify({ ...data.week, captains })]);
  return { placements, summary, commands, newCaptains, assign };
}

async function tttRecognition(){
  const ids = (await redis([['HKEYS', TTT_KEYS.archive]]))[0] || [];
  const snaps = ids.length ? (await redis(ids.map(id => ['HGET', TTT_KEYS.archive, id]))).map(x => { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } }).filter(Boolean) : [];
  const cur = await loadTtt();
  if (cur.week && Object.keys(cur.week.results || {}).length) snaps.push({ week: cur.week, signups: cur.signups, assign: cur.assign });
  const seasons = await loadSeasons(), since = seasons.length ? seasons[seasons.length - 1].start : '';
  const weeks = snaps.filter(x => x.week && x.week.published && (!since || x.week.date >= since) && Object.keys(x.week.results || {}).length);
  if (!weeks.length) throw new HttpError(409, 'No TTT week has results yet, so there is nothing to recognise.');
  const wins = {}, riders = {};
  for (const w of weeks) {
    for (const t of w.week.teams) { const r = (w.week.results || {})[t.id]; if (r && r.position === 1) wins[t.name] = (wins[t.name] || 0) + 1; }
    for (const sg of w.signups || []) {
      const mine = ((w.assign || {})[sg.name.toLowerCase()] || []).filter(id => w.week.teams.some(t => t.id === id));
      if (!mine.length) continue;
      const r = riders[sg.name] = riders[sg.name] || { weeks: 0, podiums: 0 };
      r.weeks++;
      if (mine.some(id => { const x = (w.week.results || {})[id]; return x && x.position && x.position <= 3; })) r.podiums++;
    }
  }
  const sections = [`📊 **${weeks.length} week${weeks.length === 1 ? '' : 's'} of team time trials.**`];
  const winners = Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (winners.length) sections.push(`🏆 **Team wins**\n${winners.map(([n, c]) => `• ${discordEscape(n)}: ${c}`).join('\n')}`);
  const pod = Object.entries(riders).filter(([, r]) => r.podiums > 0).sort((a, b) => b[1].podiums - a[1].podiums || a[0].localeCompare(b[0])).slice(0, 5);
  if (pod.length) sections.push(`🥇 **On the podium with their team**\n${pod.map(([n, r]) => `• ${discordEscape(n)}: ${r.podiums} time${r.podiums === 1 ? '' : 's'}`).join('\n')}`);
  const most = Object.entries(riders).sort((a, b) => b[1].weeks - a[1].weeks || a[0].localeCompare(b[0])).slice(0, 5);
  if (most.length && weeks.length >= 2) sections.push(`🏁 **Most weeks ridden**\n${most.map(([n, r]) => `• ${discordEscape(n)}: ${r.weeks} of ${weeks.length}`).join('\n')}`);
  return { weeks: weeks.length, messages: [`🎉 **TTT recognition${seasons.length ? ': ' + discordEscape(seasons[seasons.length - 1].name) : ''}**\nThank you to everyone who rode, captained and filled the teams.\n\n${sections.join('\n\n')}\n\n${SITE_URL} → 🏁 TTT Season`] };
}

// The undo for an allocation: each rider's team places and the week (captains) as they were.
function recordTttAllocation(data, plan, by){
  const undo = Object.keys(plan.placements).map(key => (data.assign[key] && data.assign[key].length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(data.assign[key])] : ['HDEL', TTT_KEYS.assign, key]));
  undo.push(['SET', TTT_KEYS.week, JSON.stringify(data.week)]);
  return autoLog.record({ series: 'TTT', by, summary: `Allocated ${Object.keys(plan.placements).length} rider${Object.keys(plan.placements).length === 1 ? '' : 's'} to teams${Object.keys(plan.newCaptains).length ? ` and picked ${Object.keys(plan.newCaptains).length} captain${Object.keys(plan.newCaptains).length === 1 ? '' : 's'}` : ''}`, undo });
}

// ── Auto-assign planner ────────────────────────────────────
const TTT_MIN_TEAM = 4;                  // fewer than this can't really race a TTT
const EMPTY_TEAM_PENALTY = 250;          // vELO points: prefer filling a started team over opening a new one
const CAT_VELO = { 'A+': 2300, A: 1900, B: 1450, C: 1050, D: 650 }; // fallback when live vELO is unknown

// vELO per rider (lowercase name), from the live club roster where possible.
async function riderVelos(signups){
  let byId = {};
  try {
    const { riders } = await fetchRoster();
    byId = Object.fromEntries(riders.map(r => [String(r.riderId), r.race && r.race.current && r.race.current.rating]));
  } catch (e) { /* fall back to categories */ }
  return Object.fromEntries(signups.map(s => [s.name.toLowerCase(), Math.round(byId[s.zwid] || CAT_VELO[s.cat] || 1000)]));
}

// Places available, unplaced riders. Existing placements are never moved.
// Hardest-to-place riders go first; each goes to the preferred team with room whose average vELO
// is closest to theirs (empty teams count as EMPTY_TEAM_PENALTY away). Riders whose preferred
// teams are full, or who gave none, go to the closest team with room and are reported as "outside".
function planTeams({ teams, signups, assign, velo }){
  const members = Object.fromEntries(teams.map(t => [t.id, []]));
  for (const [key, ids] of Object.entries(assign)) for (const id of ids) if (members[id]) members[id].push(key);
  const max = Object.fromEntries(teams.map(t => [t.id, t.max]));
  const hasRoom = id => members[id] && members[id].length < max[id];
  const distance = (id, key) => {
    const m = members[id];
    if (!m.length) return EMPTY_TEAM_PENALTY;
    return Math.abs(m.reduce((sum, k) => sum + velo[k], 0) / m.length - velo[key]);
  };
  const pick = (key, ids) => ids.filter(hasRoom)
    .sort((a, b) => (distance(a, key) - distance(b, key)) || (members[b].length - members[a].length))[0];

  const todo = signups.filter(s => s.available && !(assign[s.name.toLowerCase()] || []).length);
  const options = s => s.preferred.filter(hasRoom).length || Infinity;
  todo.sort((a, b) => (options(a) - options(b)) || a.ts.localeCompare(b.ts));

  const placements = {};
  const summary = { placed: 0, preferred: 0, outside: [], unplaced: [], short: [] };
  for (const s of todo){
    const key = s.name.toLowerCase();
    const chosen = [];
    for (let i = 0; i < (s.doubleUp ? 2 : 1); i++){
      const preferredLeft = s.preferred.filter(id => !chosen.includes(id));
      let id = pick(key, preferredLeft);
      let outside = false;
      // Only fall back outside their choices for the first team; a double-up stays within preferences.
      if (!id && i === 0){ id = pick(key, teams.map(t => t.id)); outside = !!id; }
      if (!id) break;
      chosen.push(id);
      members[id].push(key);
      if (outside) summary.outside.push(`${s.name} → ${teams.find(t => t.id === id).name}`);
    }
    if (chosen.length){
      placements[key] = chosen;
      summary.placed++;
      if (chosen.some(id => s.preferred.includes(id))) summary.preferred++;
    } else {
      summary.unplaced.push(s.name);
    }
  }
  // A team this plan left with fewer than four riders is dissolved into the other started teams when every one of its riders was placed by
  // this plan (so nobody already settled is moved) and each has a team with room to go to.
  summary.merged = [];
  for (const t of teams){
    const mine = members[t.id].slice();
    if (!mine.length || mine.length >= TTT_MIN_TEAM) continue;
    if (!mine.every(k => placements[k] && placements[k].length === 1)) continue;
    const spare = Object.fromEntries(teams.map(o => [o.id, max[o.id] - members[o.id].length]));
    const moves = [];
    for (const k of mine){
      const signup = signups.find(x => x.name.toLowerCase() === k);
      const dest = teams.filter(o => o.id !== t.id && members[o.id].length >= TTT_MIN_TEAM - 1 && spare[o.id] > 0)
        .sort((a, b) => (signup.preferred.includes(b.id) - signup.preferred.includes(a.id)) || (distance(a.id, k) - distance(b.id, k)))[0];
      if (!dest){ moves.length = 0; break; }
      spare[dest.id]--; moves.push([k, dest.id]);
    }
    if (!moves.length) continue;
    for (const [k, id] of moves){
      members[t.id] = members[t.id].filter(x => x !== k);
      members[id].push(k); placements[k] = [id];
      const signup = signups.find(x => x.name.toLowerCase() === k);
      summary.merged.push(`${signup.name} → ${teams.find(o => o.id === id).name}`);
      if (signup.preferred.length && !signup.preferred.includes(id)) summary.outside.push(`${signup.name} → ${teams.find(o => o.id === id).name}`);
    }
  }
  for (const t of teams){
    const n = members[t.id].length;
    if (n > 0 && n < TTT_MIN_TEAM) summary.short.push(`${t.name} (${n})`);
  }
  return { placements, summary };
}

// ── Captains ───────────────────────────────────────────────
// Stored on the week as {teamId: riderKey}. A captain only counts while they're still in that team.
function captainsOf(data){
  const out = {};
  for (const [id, key] of Object.entries((data.week && data.week.captains) || {})){
    if ((data.assign[key] || []).includes(id)) out[id] = key;
  }
  return out;
}

// The volunteer with the highest vELO in a team, or null.
function pickCaptain(teamId, signups, assign, velo, excludeKey){
  return signups
    .filter(s => s.captain && s.name.toLowerCase() !== excludeKey && (assign[s.name.toLowerCase()] || []).includes(teamId))
    .sort((a, b) => (velo[b.name.toLowerCase()] || 0) - (velo[a.name.toLowerCase()] || 0))
    .map(s => s.name.toLowerCase())[0] || null;
}

// ── Waitlist ───────────────────────────────────────────────
// Once line-ups are published, available riders without a team are on the waitlist, in
// sign-up order. Freed places go to the first waitlisted rider who picked that team, else
// the first rider waiting.
function waitlistOf(data){
  return data.signups
    .filter(s => s.available && !(data.assign[s.name.toLowerCase()] || []).length)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

// One rider's own view of the TTT: this week's sign-up, and (once line-ups are published) their team(s),
// teammates, captain, waitlist place and result, plus the weeks they rode before. `snapshots` are archived weeks.
const MY_TTT_HISTORY = 10;
function myTttStatus(data, key, snapshots){
  const week = data.week;
  const names = new Map(data.signups.map(s => [s.name.toLowerCase(), s.name]));
  const teamName = id => ((week && week.teams.find(t => t.id === id)) || { name: id }).name;
  const mine = data.signups.find(s => s.name.toLowerCase() === key) || null;
  const out = {
    week: week && { id: week.id, title: week.title, date: week.date, open: week.open, published: week.published, closesAt: week.closesAt || null },
    signup: mine && {
      available: mine.available, style: mine.style, doubleUp: mine.doubleUp, captain: mine.captain,
      preferred: (mine.preferred || []).map(teamName),
    },
    teams: [],
    waitlist: 0,
    history: [],
  };
  if (week && week.published){
    const captains = captainsOf(data);
    out.teams = (data.assign[key] || []).filter(id => week.teams.some(t => t.id === id)).map(id => {
      const team = week.teams.find(t => t.id === id);
      return {
        name: team.name, level: team.level, zone: team.zone,
        captain: captains[id] ? names.get(captains[id]) || captains[id] : null,
        iAmCaptain: captains[id] === key,
        mates: Object.entries(data.assign).filter(([k, ids]) => k !== key && ids.includes(id)).map(([k]) => names.get(k) || k),
        result: (week.results || {})[id] || null,
      };
    });
    out.waitlist = waitlistOf(data).findIndex(s => s.name.toLowerCase() === key) + 1;
  }
  for (const snap of snapshots){
    const w = snap && snap.week;
    if (!w || !w.published) continue;
    const ids = ((snap.assign || {})[key] || []).filter(id => w.teams.some(t => t.id === id));
    if (!ids.length) continue;
    out.history.push({
      id: w.id, title: w.title, date: w.date,
      teams: ids.map(id => ({ name: w.teams.find(t => t.id === id).name, result: (w.results || {})[id] || null })),
    });
  }
  return out;
}

// The Season page: totals, per-team results, a rider leaderboard and a week-by-week list, built from
// the archived weeks (and the current week once it has results). `snapshots` are { week, signups, assign }.
const SEASON_MAX_WEEKS = 60;

// Seasons are a name and a start date; each runs until the next one starts. Until the first is
// defined the page covers every week ("All weeks"); weeks before the first start are "Earlier weeks".
const SEASONS_KEY = 'cg:ttt:seasons';   // JSON [{ id: <start date>, name, start }] in start order

async function loadSeasons(){
  const [raw] = await redis([['GET', SEASONS_KEY]]);
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.sort((a, b) => a.start.localeCompare(b.start)) : [];
  } catch (e) { return []; }
}

function seasonChoices(seasons, archiveIds){
  if (!seasons.length) return [{ id: 'all', name: 'All weeks', start: null, end: null }];
  const out = seasons.map((x, i) => ({ id: x.start, name: x.name, start: x.start, end: seasons[i + 1] ? seasons[i + 1].start : null }));
  if (archiveIds.some(id => id < seasons[0].start)) out.unshift({ id: 'before', name: 'Earlier weeks', start: null, end: seasons[0].start });
  return out;
}

const inSeason = (date, c) => (!c.start || date >= c.start) && (!c.end || date < c.end);
// A real calendar date as YYYY-MM-DD. (A month like 13 makes Date throw, so it is checked, not trusted.)
const validDate = d => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
function seasonSummary(snapshots, full = false){
  const weeks = [];
  const teams = new Map();   // team name -> stats
  const riders = new Map();  // lowercase name -> stats
  for (const snap of snapshots){
    const w = snap && snap.week;
    if (!w) continue;
    const assign = snap.assign || {};
    const names = new Map((snap.signups || []).map(s => [s.name.toLowerCase(), s.name]));
    const nameOf = k => names.get(k) || k;
    const rows = [];
    for (const t of w.teams || []){
      const members = Object.entries(assign).filter(([, ids]) => ids.includes(t.id)).map(([k]) => k);
      const result = (w.results || {})[t.id] || null;
      if (!members.length && !result) continue;
      const capKey = (w.captains || {})[t.id];
      const captain = capKey && members.includes(capKey) ? capKey : null;
      rows.push({ name: t.name, level: t.level, zone: t.zone, result, riders: members.map(nameOf).sort((a, b) => a.localeCompare(b)), captain: captain && nameOf(captain) });

      const stat = teams.get(t.name) || { name: t.name, weeks: 0, positions: [], best: null, podiums: 0, dnfs: 0 };
      stat.weeks++;
      const placed = result && !result.dnf && result.position ? result.position : null;
      if (result && result.dnf) stat.dnfs++;
      if (placed){
        stat.positions.push(placed);
        stat.best = stat.best == null ? placed : Math.min(stat.best, placed);
        if (placed <= 3) stat.podiums++;
      }
      teams.set(t.name, stat);

      for (const k of members){
        const r = riders.get(k) || { name: nameOf(k), weeks: new Set(), captain: 0, podiums: 0 };
        r.weeks.add(w.id);
        if (k === captain) r.captain++;
        if (placed && placed <= 3) r.podiums++;
        riders.set(k, r);
      }
    }
    if (rows.length) weeks.push({ id: w.id, title: w.title, date: w.date, teams: rows });
  }
  weeks.sort((a, b) => b.date.localeCompare(a.date));
  const teamList = [...teams.values()].map(({ positions, ...t }) => ({
    ...t,
    raced: positions.length,
    avgPosition: positions.length ? Math.round(positions.reduce((a, b) => a + b, 0) / positions.length * 10) / 10 : null,
  })).sort((a, b) => (b.podiums - a.podiums) || ((a.avgPosition ?? 999) - (b.avgPosition ?? 999)) || (b.weeks - a.weeks) || a.name.localeCompare(b.name));
  const riderList = [...riders.values()].map(r => ({ name: r.name, weeks: r.weeks.size, captain: r.captain, podiums: r.podiums }))
    .sort((a, b) => (b.weeks - a.weeks) || (b.podiums - a.podiums) || a.name.localeCompare(b.name));
  const riderWeeks = riderList.reduce((n, r) => n + r.weeks, 0);
  return {
    totals: {
      weeks: weeks.length,
      riders: riderList.length,
      avgPerWeek: weeks.length ? Math.round(riderWeeks / weeks.length * 10) / 10 : 0,
      podiums: teamList.reduce((n, t) => n + t.podiums, 0),
    },
    teams: teamList,
    riders: riderList.slice(0, 25),
    ...(full ? { everyRider: riderList } : {}),
    weeks,
  };
}

// Removes a rider from their teams and refills each freed place from the waitlist.
// Returns the Discord-ready story of what happened.
async function freePlaces(data, key, riderName, reason){
  const week = data.week;
  const freed = (data.assign[key] || []).filter(id => week.teams.some(t => t.id === id));
  const wasCaptainOf = freed.filter(id => captainsOf(data)[id] === key);
  const assign = { ...data.assign };
  delete assign[key];
  const commands = [['HDEL', TTT_KEYS.assign, key]];
  const promoted = [];
  if (week.published){
    for (const id of freed){
      const waiting = waitlistOf({ ...data, signups: data.signups.filter(s => s.name.toLowerCase() !== key), assign });
      const next = waiting.find(s => s.preferred.includes(id)) || waiting[0];
      if (!next) continue;
      const nk = next.name.toLowerCase();
      assign[nk] = [...(assign[nk] || []), id];
      commands.push(['HSET', TTT_KEYS.assign, nk, JSON.stringify(assign[nk])]);
      promoted.push({ rider: next, team: week.teams.find(t => t.id === id) });
    }
  }
  // A departing captain is replaced by another volunteer in that team, if there is one.
  const captainNews = [];
  if (wasCaptainOf.length){
    const velo = await riderVelos(data.signups);
    const captains = { ...(week.captains || {}) };
    for (const id of wasCaptainOf){
      const next = pickCaptain(id, data.signups, assign, velo, key);
      const team = week.teams.find(t => t.id === id).name;
      if (next){ captains[id] = next; captainNews.push(`⭐ **${discordEscape(data.signups.find(s => s.name.toLowerCase() === next).name)}** is now captain of **${discordEscape(team)}**`); }
      else { delete captains[id]; captainNews.push(`⭐ **${discordEscape(team)}** has no captain — please pick one`); }
    }
    commands.push(['SET', TTT_KEYS.week, JSON.stringify({ ...week, captains })]);
  }
  await redis(commands);
  if (week.published && freed.length){
    const teamNames = freed.map(id => week.teams.find(t => t.id === id).name).join(' and ');
    const outcome = promoted.length
      ? promoted.map(p => `**${discordEscape(p.rider.name)}** promoted from the waitlist into **${discordEscape(p.team.name)}**`).join(', ')
      : 'nobody on the waitlist — a place is open';
    await discord('admin', { content: `⚠️ **${discordEscape(riderName)}** ${reason} **${discordEscape(teamNames)}** — ${discordEscape(week.title)}. ${outcome}.${captainNews.length ? '\n' + captainNews.join('\n') : ''}` });
    for (const p of promoted){
      await discord('public', { content: `🎉 **${discordEscape(p.rider.name)}** moves up from the waitlist into **${discordEscape(p.team.name)}** for ${discordEscape(week.title)}.` });
    }
  }
  return promoted;
}

async function startWeek(date, title){
  const current = await loadTtt();
  if (current.week && current.week.id === date) throw new HttpError(409, 'A week with that date is already running.');
  const commands = [];
  if (current.week){
    // Archive the finished week (with its line-ups) before starting the new one.
    const snapshot = { week: { ...current.week, published: true, open: false }, signups: current.signups, assign: current.assign };
    commands.push(['HSET', TTT_KEYS.archive, current.week.id, JSON.stringify(snapshot)]);
  }
  const teams = current.week ? current.week.teams : DEFAULT_TTT_TEAMS;
  // Sign-ups close automatically, unless that time has already passed (a week started late).
  const closesAt = ukTime(addDays(date, -TTT_CLOSE_DAYS_BEFORE), TTT_CLOSE_HOUR);
  const week = { id: date, title, date, open: true, published: false, teams, closesAt: closesAt > Date.now() ? new Date(closesAt).toISOString() : null };
  commands.push(['SET', TTT_KEYS.week, JSON.stringify(week)], ['DEL', TTT_KEYS.signups], ['DEL', TTT_KEYS.assign]);
  await redis(commands);
  await postSignupsOpen(week);
  return week;
}

// Runs whatever is due (reminder, auto-close, next week). Each event is claimed with HSETNX,
// so it fires exactly once even if the scheduler and page visits overlap.
async function runTttSchedule(now = Date.now()){
  const data = await loadTtt();
  const week = data.week;
  if (!week) return [];
  const { closesAt, remindAt, nextWeekAt } = scheduleFor(week);
  const due = [];
  if (closesAt && now >= remindAt && now < closesAt) due.push('reminder');
  if (closesAt && now >= closesAt) due.push('close');
  if (now >= nextWeekAt) due.push('next-week');
  const raceDay = Date.parse(`${week.date}T00:00:00Z`);
  if (now >= raceDay && now < raceDay + DAY_MS && now < nextWeekAt) due.push('digest');
  const done = [];
  for (const event of due){
    const [claimed] = await redis([['HSETNX', TTT_KEYS.sent, `${week.id}:${event}`, new Date(now).toISOString()]]);
    if (!claimed) continue;
    if (event === 'reminder') await postReminder(week, data.signups);
    if (event === 'digest') await postTttDigest(week, data.signups, data.assign);
    if (event === 'close'){
      if (week.open) await redis([['SET', TTT_KEYS.week, JSON.stringify({ ...week, open: false })]]);
      // Teams are suggested straight away (riders already in a team stay put); the staff check it and publish.
      let auto = null, assign = data.assign;
      if (week.autoAllocate !== false && !week.published){
        try {
          const fresh = await loadTtt();
          const plan = tttAllocation({ ...fresh, week: { ...fresh.week, open: false } }, await riderVelos(fresh.signups));
          if (Object.keys(plan.placements).length || Object.keys(plan.newCaptains).length){ await redis(plan.commands); await recordTttAllocation(fresh, plan, 'automatic').catch(e => console.error('Auto log:', e.message)); auto = plan.summary; assign = plan.assign; }
        } catch (e) { console.error('TTT auto-allocate:', e.message); }
      }
      await postClosed(week, data.signups, assign, auto);
    }
    if (event === 'next-week'){
      const date = addDays(week.date, 7);
      await startWeek(date, weekTitle(date));
    }
    done.push(event);
  }
  return done;
}

const CRON_LAST_KEY = 'cg:cron:last';
const CRON_FAILING_KEY = 'cg:cron:failing', CRON_FAILED_KEY = 'cg:cron:failed', CRON_ALERT_KEY = 'cg:cron:alerts';

async function handleCron(req, res){
  const secret = process.env.CRON_SECRET;
  if (!secret) return sendJSON(res, 503, { error: 'CRON_SECRET is not set' });
  const given = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1] || '';
  if (!passwordMatches(given, secret)) return sendJSON(res, 401, { error: 'unauthorized' });
  // Each job runs on its own, so one broken job cannot stop the others. A failure is told to the admin channel (once per job every six hours)
  // and shown in the health panel; the backup is otherwise quiet: not an event anyone needs to be told about.
  const ran = [], failed = [];
  const jobs = [['TTT', runTttSchedule], ['ZRL', () => zrl.runSchedule()], ['Rides', runRidesSchedule], ['Ride cover', () => cover.runSchedule()], ['Ladder', () => ladder.runSchedule()], ['DIRT series', () => drs.runSchedule()], ['Associates', () => assoc.runSchedule()], ['Comms', () => comms.runSchedule()], ['Race day', () => live.runSchedule()], ['Onboarding', () => onboarding.runSchedule()], ['Win-back', () => lifecycle.runSchedule()], ['Digest', () => runDigest()], ['Outbox', () => flushOutbox()], ['Usage', () => flushUsage()], ['Trend', () => trend.runSchedule()], ['Fair play', () => fairplay.runSchedule()], ['Sheet sync', () => sheetSync.runSchedule()], ['Backup', async () => { await backup.runBackup(); await backup.verify(); return []; }]];
  // A job that fails is tried once more at the end of the same run (most failures are a service having a bad moment). The jobs that were
  // failing on earlier runs are remembered, so the admin channel hears once when one has fixed itself.
  const retry = [];
  for (const [name, job] of jobs){
    try { ran.push(...await job()); }
    catch (e){ console.error(`Scheduled ${name}:`, e.message); retry.push([name, job, e]); }
  }
  for (const [name, job, first] of retry){
    try { ran.push(...await job()); }
    catch (e){ console.error(`Scheduled ${name} (retry):`, e.message); failed.push({ job: name, error: String(e.message || first.message || e).slice(0, 200) }); }
  }
  try {
    const [raw] = await redis([['HGETALL', CRON_FAILING_KEY]]);
    const before = new Set(pairs(raw).map(([k]) => k)), now = new Set(failed.map(f => f.job));
    const fixed = [...before].filter(j => !now.has(j));
    const cmds = [...failed.filter(f => !before.has(f.job)).map(f => ['HSET', CRON_FAILING_KEY, f.job, new Date().toISOString()]), ...fixed.map(j => ['HDEL', CRON_FAILING_KEY, j])];
    if (cmds.length) await redis(cmds);
    if (fixed.length) await discord('zrl-admin', { content: `✅ **Fixed itself:** the scheduled ${fixed.join(', ')} job ${fixed.length === 1 ? 'is' : 'are'} working again.` });
  } catch (e) { console.error('Cron recovery notes:', e.message); }
  for (const f of failed){
    const [claimed] = await redis([['HSETNX', CRON_ALERT_KEY, `${f.job}:${Math.floor(Date.now() / 21600000)}`, new Date().toISOString()]]).catch(() => [0]);
    if (claimed) await discord('zrl-admin', { content: `⚠️ **The scheduled ${f.job} job failed:** ${discordEscape(f.error)}\nIts reminders, posts or backups did not run this time. Check the health panel at ${SITE_URL}.` });
  }
  // The health panel reads these to show whether the scheduled workflow is really running, and whether a job is failing.
  await redis([['SET', CRON_LAST_KEY, new Date().toISOString()], failed.length ? ['SET', CRON_FAILED_KEY, JSON.stringify({ at: new Date().toISOString(), failed })] : ['DEL', CRON_FAILED_KEY]]).catch(() => {});
  sendJSON(res, 200, failed.length ? { ran, failed } : { ran });
}

// Earlier versions keyed sign-ups by name alone, so one rider could end up with two (a guest and a signed-in sign-up, or two
// spellings). Sign-ups with the same Zwift ID are merged: the earliest keeps its name and place in the queue, the latest answers
// win, team places are combined (at most 2) and a captaincy follows the merge.
async function mergeDuplicateSignups(){
  const data = await loadTtt();
  const groups = new Map();
  for (const s of data.signups) if (s.zwid) groups.set(s.zwid, [...(groups.get(s.zwid) || []), s]);
  const commands = [];
  let captains = data.week && data.week.captains ? { ...data.week.captains } : null;
  for (const group of groups.values()){
    if (group.length < 2) continue;
    const keep = group[0], latest = group[group.length - 1];   // loadTtt sorts by sign-up time
    const keepKey = keep.name.toLowerCase();
    const places = [...new Set(group.flatMap(s => data.assign[s.name.toLowerCase()] || []))].slice(0, 2);
    commands.push(['HSET', TTT_KEYS.signups, keepKey, JSON.stringify({ ...latest, name: keep.name, ts: keep.ts, captain: latest.captain })]);
    if (places.length) commands.push(['HSET', TTT_KEYS.assign, keepKey, JSON.stringify(places)]);
    for (const extra of group.slice(1)){
      const k = extra.name.toLowerCase();
      commands.push(['HDEL', TTT_KEYS.signups, k], ['HDEL', TTT_KEYS.assign, k]);
      if (captains) for (const [id, who] of Object.entries(captains)) if (who === k) captains[id] = keepKey;
    }
  }
  if (!commands.length) return false;
  if (captains) commands.push(['SET', TTT_KEYS.week, JSON.stringify({ ...data.week, captains })]);
  await redis(commands);
  return true;
}

async function handleTtt(tttRoute, req, res){
  if (req.method === 'GET'){
    await runTttSchedule().catch(e => console.error('TTT schedule:', e.message));
    await mergeDuplicateSignups().catch(e => console.error('TTT merge duplicates:', e.message));
  }
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await tttRoute(req, body);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result || tttView(await loadTtt(), roleFromRequest(req)));
}

// A club-created ride that is today or tomorrow (UTC date) is announced once in the club channel: when, where, how many are riding and how many
// places are left. Rides copied in from the club sheet have no RSVPs here, so they are not announced.
async function runRidesSchedule(now = Date.now()){
  const state = await loadState();
  const today = new Date(now).toISOString().slice(0, 10), tomorrow = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const done = [];
  for (const ride of state.rides){
    if (ride.date !== today && ride.date !== tomorrow) continue;
    const [claimed] = await redis([['HSETNX', KEYS.rideSent, `${ride.id}:reminder`, new Date(now).toISOString()]]);
    if (!claimed) continue;
    const going = (state.rsvps[ride.id] || []).length, max = parseInt(ride.max, 10) || 25;
    const details = [ride.route && `📍 ${ride.route}`, ride.dist && `📏 ${ride.dist}`, ride.pace && `⚡ ${ride.pace}`].filter(Boolean).map(discordEscape).join(' · ');
    const link = ride.link && !/[<>\s]/.test(ride.link) ? `\nZwift event: <${ride.link}>` : '';
    await discord('public', { content: `🚴 **${discordEscape(ride.title)}** is ${ride.date === today ? 'today' : 'tomorrow'}${ride.time ? ` at ${discordEscape(ride.time)}` : ''}.${details ? `\n${details}` : ''}\n${going} riding, ${Math.max(0, max - going)} place${max - going === 1 ? '' : 's'} left. RSVP: ${SITE_URL} → 🚴 Social Rides${link}` });
    done.push('ride-reminder');
  }
  return done;
}

async function handleData(dataRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await dataRoute(req, body);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result || await loadState());
}

// ── Live roster (WordPress plugin on cryogen.team) ─────────
// Fetched here rather than in the browser: no cross-site issues, and the WordPress
// credentials (needed for the member records) never reach the page.
const WP_API = process.env.WP_API_URL || 'https://cryogen.team/wp-json/cryogen/v1';
const ZWIFT_CLUB_ID = process.env.ZWIFT_CLUB_ID || '2740';
const ROSTER_TTL_MS = 5 * 60 * 1000;
let rosterCache = null; // { at, riders, members, membersError }

async function wpGet(pathname, auth){
  const headers = { 'User-Agent': 'cryogen-proxy/2.0', Accept: 'application/json' };
  let query = '';
  if (auth){
    headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    // Member records change when staff edit them; don't let a page cache on the WordPress side serve an old copy.
    headers['Cache-Control'] = 'no-cache';
    query = `${pathname.includes('?') ? '&' : '?'}_cb=${Date.now()}`;
  }
  const r = await fetch(`${WP_API}${pathname}${query}`, { headers });
  if (!r.ok) throw new HttpError(502, `cryogen.team returned ${r.status} for ${pathname}`);
  return r.json();
}

// Keep only what the dashboard shows. The upstream roster also has age, gender, height and
// weight, which shouldn't be republished, and is ~10x bigger.
const pick = (o, keys) => (o ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : undefined);
function slimRider(r){
  const race = r.race || {};
  return {
    riderId: r.riderId,
    name: r.name,
    country: r.country,
    zpCategory: r.zpCategory,
    zpFTP: r.zpFTP,
    club: r.club ? { name: r.club.name } : undefined,
    power: pick(r.power, ['wkg5', 'wkg15', 'wkg30', 'wkg60', 'wkg120', 'wkg300', 'wkg1200', 'w5', 'w60', 'w300', 'w1200', 'CP', 'AWC']),
    race: {
      ...pick(race, ['finishes', 'dnfs', 'wins', 'podiums']),
      last: race.last && race.last.date ? { date: race.last.date } : undefined,
      current: race.current ? { rating: race.current.rating, mixed: race.current.mixed ? { category: race.current.mixed.category } : undefined } : undefined,
      max30: race.max30 ? { rating: race.max30.rating } : undefined,
      max90: race.max90 ? { rating: race.max90.rating } : undefined,
    },
    phenotype: r.phenotype ? { value: r.phenotype.value, scores: r.phenotype.scores } : undefined,
    handicaps: r.handicaps && r.handicaps.profile ? { profile: r.handicaps.profile } : undefined,
  };
}

// The club roster comes from ZwiftRacing.app through the WordPress plugin, which throttles
// (HTTP 429) when asked often. Every server instance asks separately, so one copy is kept in
// shared storage: fresh for RIDERS_FRESH_MS, and the last good copy is used if the source fails.
const RIDERS_KEY = 'cg:roster:riders';
const RIDERS_FRESH_MS = 10 * 60 * 1000;

async function loadRiders(){
  let saved = null;
  try {
    const [raw] = await redis([['GET', RIDERS_KEY]]);
    saved = raw ? JSON.parse(raw) : null;
  } catch (e) { /* shared storage unavailable: ask the source directly */ }
  if (saved && Date.now() - saved.at < RIDERS_FRESH_MS) return { riders: saved.riders, updatedAt: saved.at, stale: false };
  try {
    const club = await wpGet(`/zwift/public/clubs/${encodeURIComponent(ZWIFT_CLUB_ID)}/0`);
    const riders = Array.isArray(club.riders) ? club.riders.map(slimRider) : [];
    // Registered weight is kept out of the roster that members can fetch. The fair-play check (staff only) reads it from its own private store.
    const kg = (Array.isArray(club.riders) ? club.riders : []).filter(r => Number(r.weight) > 0).map(r => ['HSET', 'cg:fair:weights', String(r.riderId), String(Math.round(Number(r.weight) * 10) / 10)]);
    if (kg.length) await redis(kg).catch(() => {});
    const updatedAt = Date.now();
    await redis([['SET', RIDERS_KEY, JSON.stringify({ at: updatedAt, riders }), 'EX', '604800']]).catch(() => {});
    return { riders, updatedAt, stale: false };
  } catch (e) {
    if (saved) return { riders: saved.riders, updatedAt: saved.at, stale: true };
    throw e;
  }
}

async function fetchRoster(){
  if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache;
  const auth = process.env.WP_API_USER && process.env.WP_API_APP_PASSWORD
    ? `${process.env.WP_API_USER}:${process.env.WP_API_APP_PASSWORD}` : null;
  const [club, members] = await Promise.allSettled([
    loadRiders(),
    auth ? wpGet('/members', auth) : Promise.reject(new Error('not configured')),
  ]);
  if (club.status === 'rejected') throw club.reason;
  const roster = club.value;
  rosterCache = {
    at: Date.now(),
    riders: roster.riders,
    ridersUpdatedAt: roster.updatedAt,
    ridersStale: roster.stale,
    members: members.status === 'fulfilled' && Array.isArray(members.value) ? members.value : null,
    membersError: members.status === 'rejected' ? members.reason.message : null,
  };
  return rosterCache;
}

// WordPress can hold several records for one Zwift ID (test entries, re-registrations).
// Everything here uses the last one, so what the page shows is what a save changes.
// "Half" and "associate" are the same membership: WordPress records still saying half are read as associate everywhere in the app.
const normTier = t => (String(t || '').toLowerCase() === 'half' ? 'associate' : t);

function uniqueMembers(list){
  const byId = new Map();
  for (const m of Array.isArray(list) ? list : []){
    if (/^\d+$/.test(String(m.zwift_id))) byId.set(String(m.zwift_id), m);
  }
  return [...byId.values()];
}

async function handleRoster(req, res){
  const { riders, ridersUpdatedAt, ridersStale, members: allMembers, membersError } = await fetchRoster();
  const members = allMembers && uniqueMembers(allMembers);
  const staff = ['admin', 'mod'].includes(roleFromRequest(req));
  const stale = ridersStale || Date.now() - ridersUpdatedAt >= RIDERS_FRESH_MS;
  // Everyone sees name/status/tier; off-boarding progress is staff-only.
  const memberView = members && members.map(m => ({
    zwift_id: m.zwift_id, name: m.name, status: m.status, tier: normTier(m.tier),
    ...(staff ? { offboard_discord: m.offboard_discord, offboard_fb: m.offboard_fb, offboard_zp: m.offboard_zp } : {}),
  }));
  sendJSON(res, 200, {
    riders,
    members: memberView,
    membersAvailable: Array.isArray(allMembers),
    membersError: staff ? membersError : undefined,
    roster: { updatedAt: new Date(ridersUpdatedAt).toISOString(), stale },
  });
}

// Staff edits to a member record, saved to WordPress with the server's credentials.
const MEMBER_FIELDS = {
  tier: ['full', 'associate'],   // 'half' is accepted from older callers and saved as 'associate'
  status: ['active', 'suspended', 'left'],
  offboard_discord: ['0', '1'],
  offboard_fb: ['0', '1'],
  offboard_zp: ['0', '1'],
};
const MEMBER_VIEW_KEYS = ['zwift_id', 'name', 'status', 'tier', 'offboard_discord', 'offboard_fb', 'offboard_zp'];

// The fields staff may change on a member record, checked against what each may hold.
function memberChanges(body){
  const changes = {};
  if (body.tier === 'half') body.tier = 'associate';
  for (const [k, allowed] of Object.entries(MEMBER_FIELDS)){
    if (body[k] === undefined) continue;
    if (!allowed.includes(String(body[k]))) throw new HttpError(400, `invalid ${k}`);
    changes[k] = String(body[k]);
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'nothing to change');
  return changes;
}

// Staff change the same fields on many members at once (tier, status, off-boarding ticks). The member list is read once, the records are
// saved a few at a time, and each is checked afterwards from WordPress's own reply or a re-read, as for a single save. Anything that
// could not be saved is listed by Zwift ID with the reason; running out of time reports the rest as not attempted.
const BULK_MEMBERS_MAX = 100;
async function handleMemberBulk(req, res){
  requireRole(req, ['admin', 'mod']);
  const body = await readJSONBody(req);
  const zwids = [...new Set((Array.isArray(body.zwids) ? body.zwids : []).map(String))];
  if (!zwids.length) throw new HttpError(400, 'Pick at least one member.');
  if (zwids.length > BULK_MEMBERS_MAX) throw new HttpError(400, `Change at most ${BULK_MEMBERS_MAX} members at a time.`);
  if (!zwids.every(z => /^\d+$/.test(z))) throw new HttpError(400, 'Zwift IDs are numbers only.');
  const changes = memberChanges(body.changes && typeof body.changes === 'object' ? { ...body.changes } : {});
  const auth = wpAuth();
  if (!auth) throw new HttpError(503, 'WordPress member records are not configured on the server.');
  const started = Date.now();
  const byId = new Map(uniqueMembers(await wpGet('/members', auth)).map(m => [String(m.zwift_id), m]));
  const results = [], echoed = new Map();
  const todo = zwids.filter(z => { if (byId.has(z)) return true; results.push({ zwid: z, ok: false, error: 'no member record in WordPress' }); return false; });
  for (let i = 0; i < todo.length; i += 5){
    if (Date.now() - started > 7000){ for (const z of todo.slice(i)) results.push({ zwid: z, ok: false, error: 'not attempted (out of time): select these again and re-run' }); break; }
    await Promise.all(todo.slice(i, i + 5).map(async z => {
      try {
        const rec = byId.get(z);
        const r = await fetch(`${WP_API}/members/${encodeURIComponent(rec.id ?? z)}`, {
          method: 'PATCH',
          headers: { 'User-Agent': 'cryogen-proxy/2.0', Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
          body: JSON.stringify(changes),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`WordPress refused the change (${r.status})`);
        try { echoed.set(z, JSON.parse(text) || {}); } catch (e) { /* not JSON */ }
        results.push({ zwid: z, ok: true });
      } catch (e) { results.push({ zwid: z, ok: false, error: e.message }); }
    }));
  }
  rosterCache = null;
  if (results.some(r => r.ok)){
    const after = new Map(uniqueMembers(await wpGet('/members', auth)).map(m => [String(m.zwift_id), m]));
    for (const r of results) {
      if (!r.ok) continue;
      const missed = Object.keys(changes).filter(k => String(after.get(r.zwid)?.[k]) !== changes[k] && String((echoed.get(r.zwid) || {})[k]) !== changes[k]);
      if (missed.length){ r.ok = false; r.error = `WordPress did not keep the change (${missed.join(', ')})`; }
    }
  }
  const order = new Map(zwids.map((z, i) => [z, i]));
  results.sort((a, b) => order.get(a.zwid) - order.get(b.zwid));
  await zrl.logChange(req, '/api/members/bulk', { changes, count: zwids.length, saved: results.filter(r => r.ok).length }, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, { changes, results, saved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
}

async function handleMemberUpdate(req, res, zwiftId){
  requireRole(req, ['admin', 'mod']);
  const body = await readJSONBody(req);
  const changes = memberChanges(body);
  const auth = process.env.WP_API_USER && process.env.WP_API_APP_PASSWORD
    ? `${process.env.WP_API_USER}:${process.env.WP_API_APP_PASSWORD}` : null;
  if (!auth) throw new HttpError(503, 'WordPress member records are not configured on the server.');

  const find = list => uniqueMembers(list).find(m => String(m.zwift_id) === String(zwiftId));
  const record = find(await wpGet('/members', auth));
  if (!record) throw new HttpError(404, 'This rider has no member record in WordPress.');
  const recordId = record.id ?? zwiftId;
  const r = await fetch(`${WP_API}/members/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: {
      'User-Agent': 'cryogen-proxy/2.0', Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
    },
    body: JSON.stringify(changes),
  });
  const replyText = await r.text();
  if (!r.ok){
    let message = '';
    try { message = JSON.parse(replyText).message || ''; } catch (e) { /* not JSON */ }
    throw new HttpError(502, `WordPress refused the change (${r.status}${message ? `: ${message}` : ''}).`);
  }
  // The plugin doesn't document its fields, so read the record back rather than trust the 200.
  const after = find(await wpGet('/members', auth));
  // WordPress echoes the fields it applied (e.g. {"ok":true,"id":1,"tier":"half"}); that counts as saved too.
  let echoed = {};
  try { echoed = JSON.parse(replyText) || {}; } catch (e) { /* not JSON */ }
  const missed = Object.keys(changes).filter(k => String(after?.[k]) !== changes[k] && String(echoed[k]) !== changes[k]);
  if (missed.length){
    // The plugin's fields aren't documented, so say what was sent and what came back (no secrets in any of it).
    throw new HttpError(502, `WordPress accepted the request but didn't save: ${missed.join(', ')}. ` +
      `Patched /members/${recordId} with ${JSON.stringify(changes)}; WordPress replied ${replyText.slice(0, 200)}; ` +
      `record fields: ${Object.keys(record).join(', ')}.`);
  }
  rosterCache = null;
  sendJSON(res, 200, { member: { ...pick(after, MEMBER_VIEW_KEYS), ...changes } });
}

// ── Member sign-in (cryogen.team account) ──────────────────
// A small snippet on cryogen.team sends a logged-in member back here with a short-lived token:
//   base64url(JSON {zwid, name, exp, n}) + '.' + base64url(HMAC-SHA256(WP_SSO_SECRET, that first part))
// We check the signature, accept each token once, and hand the browser a member session.
const SSO_MAX_AGE_MS = 10 * 60 * 1000;
const WP_SSO_LOGIN_URL = process.env.WP_SSO_LOGIN_URL || 'https://cryogen.team/club-login';

function ssoRedirect(res, fragment){
  res.writeHead(302, { Location: `/#${fragment}`, 'Cache-Control': 'no-store' });
  res.end();
}

function readSsoToken(token){
  const secret = process.env.WP_SSO_SECRET;
  if (!secret) throw new HttpError(503, 'Sign-in with cryogen.team is not set up yet.');
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new HttpError(400, 'That sign-in link is not valid.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))){
    throw new HttpError(400, 'That sign-in link is not valid.');
  }
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { data = null; }
  if (!data || !/^\d{1,12}$/.test(String(data.zwid)) || !/^[\w-]{8,64}$/.test(String(data.n))){
    throw new HttpError(400, 'That sign-in link is not valid.');
  }
  const now = Date.now();
  if (!(data.exp > now) || data.exp > now + SSO_MAX_AGE_MS) throw new HttpError(400, 'That sign-in link has expired. Please try again.');
  return { zwid: String(data.zwid), name: String(data.name || ''), n: String(data.n) };
}

async function handleWpSso(req, res, token){
  try {
    const t = readSsoToken(token);
    const [fresh] = await redis([['SET', `cg:sso:${t.n}`, '1', 'NX', 'EX', '900']]);
    if (fresh !== 'OK') throw new HttpError(400, 'That sign-in link was already used. Please try again.');
    const lookup = async () => {
      const { riders, members } = await fetchRoster();
      return { record: members && uniqueMembers(members).find(m => String(m.zwift_id) === t.zwid), rider: riders.find(r => String(r.riderId) === t.zwid) };
    };
    let { record, rider } = await lookup();
    if (record && record.status === 'left') throw new HttpError(403, 'Your membership is no longer active.');
    // Not a full member yet (or marked as an associate): a signed session that is limited until staff approve the upgrade. Before limiting
    // anyone, look again with fresh data: someone who joined in the last few minutes must not be called an associate by an old copy.
    let associate = await assoc.classify({ zwid: t.zwid, record, rider });
    if (associate) {
      rosterCache = null;
      ({ record, rider } = await lookup());
      if (record && record.status === 'left') throw new HttpError(403, 'Your membership is no longer active.');
      associate = await assoc.classify({ zwid: t.zwid, record, rider });
    }
    const name = (rider && rider.name) || t.name;
    if (!name) throw new HttpError(403, 'Your Zwift ID is not in the club roster yet. Ask a moderator.');
    if (associate) await assoc.noteFirstSeen(t.zwid, name);
    ssoRedirect(res, `sso=${signToken('member', { zwid: t.zwid, name, ...(associate ? { assoc: true } : {}) })}`);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    ssoRedirect(res, `sso_error=${encodeURIComponent(e.message)}`);
  }
}

// "Your season": one rider's ZRL, TTT, social-ride and ride-cover record in a single answer, for the card on their profile.
async function handleMeSeason(req, res){
  const member = memberFromRequest(req);
  if (!member) return sendJSON(res, 401, { error: 'Sign in with your cryogen.team account.' });
  sendJSON(res, 200, await seasonOf(member));
}

// A rider's own season recap, shared to the club channel only when they press the button (once a day).
async function handleMeSeasonShare(req, res){
  const member = memberFromRequest(req);
  if (!member) return sendJSON(res, 401, { error: 'Sign in with your cryogen.team account.' });
  if (!process.env.DISCORD_WEBHOOK_PUBLIC) return sendJSON(res, 409, { error: 'The club channel is not set up yet.' });
  const [fresh] = await redis([['HSETNX', 'cg:season:shared', `${member.zwid}:${new Date().toISOString().slice(0, 10)}`, '1']]);
  if (!fresh) return sendJSON(res, 429, { error: 'You already shared your season today.' });
  const d = await seasonOf(member), lines = [];
  if (d.zrl && d.zrl.placed) lines.push(`🚀 ZRL: picked for ${d.zrl.picked} of ${d.zrl.races} races${d.zrl.podiums ? `, ${d.zrl.podiums} podium${d.zrl.podiums === 1 ? '' : 's'}` : ''}`);
  if (d.ttt && d.ttt.weeks) lines.push(`🏁 TTT: ${d.ttt.weeks} week${d.ttt.weeks === 1 ? '' : 's'} raced${d.ttt.podiums ? `, ${d.ttt.podiums} podium${d.ttt.podiums === 1 ? '' : 's'}` : ''}`);
  if (d.rides && d.rides.attended) lines.push(`🚴 ${d.rides.attended} social ride${d.rides.attended === 1 ? '' : 's'}`);
  if (d.cover && d.cover.past) lines.push(`🧭 Ride cover: ${d.cover.led} led, ${d.cover.swept} swept`);
  if (!lines.length) { await redis([['HDEL', 'cg:season:shared', `${member.zwid}:${new Date().toISOString().slice(0, 10)}`]]); return sendJSON(res, 409, { error: 'There is nothing to share yet: race, ride or lead a ride first.' }); }
  const ok = await discord('public', { content: `⭐ **${discordEscape(member.name)}'s season**\n${lines.join('\n')}${d.highlights.length ? '\n' + d.highlights.join(' · ') : ''}` });
  sendJSON(res, 200, { ok });
}

async function seasonOf(member){
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  const names = new Set([member.name.toLowerCase()]);
  const part = async (label, fn) => { try { return await fn(); } catch (e) { console.error(`Season ${label}:`, e.message); return null; } };

  const zrlPart = await part('zrl', async () => {
    const data = await zrl.load();
    if (!data.round) return null;
    const my = zrl.myZrl(data, member, data.weekly, await zrl.loadResults());
    if (!my.team && !my.captainOf.length) return { round: data.round.name, placed: false };
    const past = my.weeks.filter(w => w.date <= today), picked = past.filter(w => w.picked);
    const scored = picked.filter(w => w.result && w.result.pts !== null);
    return { round: data.round.name, placed: true, team: my.team && my.team.name, races: past.length, picked: picked.length, answered: my.weeks.filter(w => w.mine).length, yes: my.weeks.filter(w => w.mine === 'yes').length,
      weeks: my.weeks.length, points: scored.reduce((n, w) => n + w.result.pts, 0), podiums: picked.filter(w => w.result && w.result.pos && w.result.pos <= 3).length };
  });

  const tttPart = await part('ttt', async () => {
    const [data, seasons] = await Promise.all([loadTtt(), loadSeasons()]);
    const choices = seasonChoices(seasons, data.archive), choice = choices[choices.length - 1];
    const ids = data.archive.filter(id => inSeason(id, choice)).slice(0, SEASON_MAX_WEEKS);
    const snaps = ids.length ? (await redis(ids.map(id => ['HGET', TTT_KEYS.archive, id]))).map(x => (x ? JSON.parse(x) : null)) : [];
    if (data.week && inSeason(data.week.date, choice) && Object.keys(data.week.results || {}).length) snaps.unshift({ week: data.week, signups: data.signups, assign: data.assign });
    const me = (seasonSummary(snaps, true).everyRider || []).find(r => names.has(r.name.toLowerCase()));
    return { season: choice.name, weeks: me ? me.weeks : 0, captain: me ? me.captain : 0, podiums: me ? me.podiums : 0 };
  });

  const ridesPart = await part('rides', async () => {
    const [rsvpRaw, rideRaw] = await redis([['HGETALL', KEYS.rsvps], ['HGETALL', KEYS.rides]]);
    const dates = new Map();
    for (let i = 0; i < (rideRaw || []).length; i += 2) { try { dates.set(rideRaw[i], JSON.parse(rideRaw[i + 1]).date); } catch (e) { /* skip */ } }
    let total = 0, past = 0;
    for (let i = 0; i < (rsvpRaw || []).length; i += 2) {
      let who = ''; try { who = String(JSON.parse(rsvpRaw[i + 1]).name || '').toLowerCase(); } catch (e) { /* skip */ }
      if (!names.has(who)) continue;
      total++;
      const d = dates.get(rsvpRaw[i].split('|')[0]);
      if (d && d < today) past++;
    }
    return { rsvps: total, attended: past };
  });

  const coverPart = await part('cover', () => cover.statsFor(member.zwid, now));

  const highlights = [];
  if (zrlPart && zrlPart.races >= 2 && zrlPart.picked === zrlPart.races) highlights.push('🏁 Raced every ZRL race so far');
  if (zrlPart && zrlPart.weeks && zrlPart.answered === zrlPart.weeks) highlights.push('✅ Answered availability for every ZRL race');
  if (zrlPart && zrlPart.podiums) highlights.push(`🥇 ${zrlPart.podiums} ZRL podium${zrlPart.podiums === 1 ? '' : 's'} with your team`);
  if (tttPart && tttPart.podiums) highlights.push(`🥇 ${tttPart.podiums} TTT podium${tttPart.podiums === 1 ? '' : 's'}`);
  if (coverPart && coverPart.past >= 5) highlights.push('🧭 Ride-cover regular');
  if (ridesPart && ridesPart.attended >= 10) highlights.push('🚴 Regular on the social rides');
  return { name: member.name, zrl: zrlPart, ttt: tttPart, rides: ridesPart, cover: coverPart, highlights };
}

async function handleMe(req, res){
  const member = memberFromRequest(req);
  if (!member) return sendJSON(res, 401, { error: 'Not signed in as a member.' });
  const { members } = await fetchRoster();
  const record = members && uniqueMembers(members).find(m => String(m.zwift_id) === member.zwid);
  const associate = member.assoc && await assoc.stillAssociate(member.zwid);
  sendJSON(res, 200, { zwid: member.zwid, name: member.name, tier: record && normTier(record.tier), status: record && record.status, associate: !!associate });
}

// ── "Is everything working?" ───────────────────────────────
// Runs the real thing for each service the club relies on, one step at a time, and says what each gave back. It posts one short line to
// the admin channel and contacts Discord, Google and the database; it sends nothing to riders and writes no club data.
async function selfCheck(){
  const steps = [];
  const step = async (id, label, fn) => {
    const started = Date.now();
    try { const [status, detail] = await withTimeout(Promise.resolve().then(fn), 10000); steps.push({ id, label, status, detail, ms: Date.now() - started }); }
    catch (e) { steps.push({ id, label, status: 'fail', detail: String(e.message || e).slice(0, 200), ms: Date.now() - started }); }
  };
  await step('db', 'Database', async () => { await redis([['GET', TTT_KEYS.week]]); return ['ok', 'Answered.']; });
  await step('admin', 'Admin channel post', async () => {
    if (!(DISCORD_HOOKS.admin || []).some(k => process.env[k])) return ['fail', 'DISCORD_WEBHOOK_ADMIN is not set.'];
    const ok = await discord('admin', { content: '🧪 Self-check from the dashboard: if you can read this, the admin channel works.' }, { noQueue: true });
    return ok ? ['ok', 'Posted (look for the 🧪 message in Discord).'] : ['fail', 'Discord did not accept the post. The webhook may be deleted or wrong.'];
  });
  await step('bot', 'Discord bot sign-in', async () => {
    if (!process.env.DISCORD_BOT_TOKEN) return ['skip', 'No bot token: reminders go to the channel only.'];
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'User-Agent': 'cryogen-proxy/2.0' }, signal: AbortSignal.timeout(8000) });
    return r.ok ? ['ok', 'The bot token is accepted.'] : ['fail', `Discord answered ${r.status}: the bot token is wrong or was reset.`];
  });
  await step('buttons', 'Discord buttons key', async () => {
    const k = process.env.DISCORD_PUBLIC_KEY || '';
    if (!k) return ['skip', 'Not set: the Yes / Maybe / No buttons are off.'];
    return /^[0-9a-f]{64}$/i.test(k.trim()) ? ['ok', 'The key looks right. The Developer Portal does the real check when you save the endpoint URL.'] : ['fail', 'The key should be 64 letters and numbers (copy "Public Key" from General Information).'];
  });
  await step('push', 'Push notifications', async () => {
    if (!push.configured()) return ['skip', 'Not switched on (VAPID keys).'];
    const [n] = await redis([['HLEN', push.KEY]]);
    return ['ok', `Keys are valid; ${n} device${n === 1 ? '' : 's'} registered.`];
  });
  await step('sheets', 'Google sign-in', async () => {
    const st = gsheets.status();
    if (!st.configured) return ['skip', st.error || 'GOOGLE_SERVICE_ACCOUNT_JSON is not set.'];
    await gsheets.accessToken();
    return ['ok', `Google accepted ${st.email}. Share each sheet with that address.`];
  });
  await step('backup', 'Backup copy restores', async () => {
    const v = await backup.verify(Date.now(), true);
    return v.ok ? ['ok', `The copy ${v.id} was read back correctly.`] : ['fail', (v.problems || []).join(' ') || 'The test restore failed.'];
  });
  await step('assistant', 'Assistant key', async () => process.env.ANTHROPIC_API_KEY ? ['ok', 'Set (not called, to save cost).'] : ['skip', 'Not set: the assistant is off.']);
  return { at: new Date().toISOString(), steps, ok: steps.every(x => x.status !== 'fail'), failing: steps.filter(x => x.status === 'fail').length };
}

// ── System health (admin) ──────────────────────────────────
// Reports what is configured and reachable, never any secret values. Nothing here posts to
// Discord or calls the (rate-limited) club roster source.
const withTimeout = (promise, ms = 8000) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
const ago = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const ukWhen = ms => `${new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} UK`;
const wpAuth = () => (process.env.WP_API_USER && process.env.WP_API_APP_PASSWORD ? `${process.env.WP_API_USER}:${process.env.WP_API_APP_PASSWORD}` : null);

async function healthChecks(){
  const run = (id, label, fn) => withTimeout(Promise.resolve().then(fn))
    .then(([status, detail]) => ({ id, label, status, detail }))
    .catch(e => ({ id, label, status: 'fail', detail: e.message }));
  return Promise.all([
    run('usage', 'Daily usage', async () => {
      const [raw] = await redis([['HGETALL', USAGE_KEY]]);
      const day = usageDay(), get = k => Number(pairs(raw).find(([f]) => f === `${day}:${k}`)?.[1]) || 0;
      const r = get('redis') + usage.redis, d = get('discord') + usage.discord, limit = REDIS_DAILY_LIMIT();
      const detail = `Today so far: about ${r} storage commands (alert at ${Math.round(limit * 0.8)} of ${limit}), ${d} Discord posts. Counts are a floor.`;
      return [r >= limit * 0.8 ? 'warn' : 'ok', r >= limit * 0.8 ? `${detail} Close to the daily limit: check the Upstash plan or what is polling.` : detail];
    }),
    run('outbox', 'Discord messages waiting to send', async () => {
      const [n] = await redis([['HLEN', OUTBOX_KEY]]);
      return n ? ['warn', `${n} message${n === 1 ? ' is' : 's are'} waiting to be retried (Discord was busy or refused them). They are retried every 15 minutes for a day.`] : ['ok', 'None waiting.'];
    }),
    run('storage', 'Shared storage (Redis)', async () => {
      const started = Date.now();
      await redis([['GET', TTT_KEYS.week]]);
      return ['ok', `Reachable (${Date.now() - started} ms)`];
    }),
    run('members', 'WordPress member records', async () => {
      const auth = wpAuth();
      if (!auth) return ['warn', 'Not configured (WP_API_USER / WP_API_APP_PASSWORD): everyone shows as active and member edits are unavailable.'];
      const list = await wpGet('/members', auth);
      const unique = uniqueMembers(list);
      return ['ok', `${unique.length} members read; ${list.length - unique.length} duplicate or placeholder rows ignored.`];
    }),
    run('roster', 'Club roster (ZwiftRacing.app)', async () => {
      const [raw] = await redis([['GET', RIDERS_KEY]]);
      if (!raw) return ['warn', 'No saved copy yet. It is fetched the first time someone opens the dashboard.'];
      const saved = JSON.parse(raw);
      const age = Date.now() - saved.at;
      return [age > 24 * 3600 * 1000 ? 'warn' : 'ok', `${saved.riders.length} riders; shared copy refreshed ${ago(age)}.`];
    }),
    // Google's sheet endpoint is sometimes slow for a few seconds. The check gets two short tries inside its own time limit, and a slow
    // answer after a recent good one is a warning (it passes again by itself), not a failure.
    run('sheet', 'Google Sheet (TEAM LIST)', async () => {
      const tab = SHEET_TABS['ttt-sheet'], half = Math.min(sheetTimeoutMs(), 3500);
      let body, last;
      for (let i = 0; i < 2 && body === undefined; i++) {
        try { body = await fetchTab(tab, 1, SHEET_ID, half); } catch (e) { last = e; }
      }
      if (body === undefined) {
        const [saved] = await redis([['GET', 'cg:health:sheet-ok']]).catch(() => [null]);
        const age = saved ? Date.now() - Number(saved) : Infinity;
        if (last && last.status === 504 && age < 24 * 3600 * 1000) return ['warn', `Google Sheets is slow to answer right now. It last answered ${ago(age)}; this clears by itself.`];
        throw last;
      }
      await redis([['SET', 'cg:health:sheet-ok', String(Date.now())]]).catch(() => {});
      return ['ok', `Reachable; ${parseGviz(body).rows.length} rows.`];
    }),
    run('discord', 'Discord webhooks', async () => {
      const pub = Boolean(process.env.DISCORD_WEBHOOK_PUBLIC), adm = Boolean(process.env.DISCORD_WEBHOOK_ADMIN);
      const zp = Boolean(process.env.DISCORD_WEBHOOK_ZRL_PUBLIC), za = Boolean(process.env.DISCORD_WEBHOOK_ZRL_ADMIN);
      const zrl = `ZRL club channel: ${zp ? 'own channel' : pub ? 'shares the TTT club channel' : 'NOT set'} · ZRL admin channel: ${za ? 'own channel' : adm ? 'shares the TTT admin channel' : 'NOT set'}`;
      return [pub && adm ? 'ok' : 'warn', `Club channel: ${pub ? 'set' : 'NOT set'} · Admin channel: ${adm ? 'set' : 'NOT set'} · ${zrl}. (Not tested here, to avoid posting.)`];
    }),
    run('week', 'TTT week', async () => {
      const { week } = await loadTtt();
      if (!week) return ['warn', 'No TTT week is running.'];
      const sch = scheduleFor(week);
      const state = `${week.title}: sign-ups ${week.open ? 'open' : 'closed'}${week.published ? ', line-ups published' : ''}.`;
      if (week.open && !sch.closesAt) return ['warn', `${state} No close time is set, so it won't close by itself.`];
      return ['ok', `${state}${week.open && sch.closesAt ? ` Closes ${ukWhen(sch.closesAt)}.` : ''} Next week starts ${ukWhen(sch.nextWeekAt)}.`];
    }),
    run('zrl', 'ZRL round', async () => zrl.healthRow(await zrl.load())),
    run('backup', 'Backups', async () => backup.healthRow()),
    run('cover', 'Ride cover (leaders and sweepers)', async () => cover.healthRow(await cover.load())),
    run('ladder', 'Zwift Club Ladder', async () => ladder.healthRow()),
    run('drs', 'DIRT Racing Series', async () => drs.healthRow()),
    run('assoc', 'Associate members', async () => assoc.healthRow()),
    run('sheetsync', 'Google Sheet sync', () => sheetSync.healthRow()),
    run('comms', 'Discord messages (Comms)', async () => {
      const auth = wpAuth();   // member records only: this check never calls the rate-limited roster source
      const [s, list, auto] = await Promise.all([comms.stats(), auth ? wpGet('/members', auth).catch(() => null) : null, comms.getSettings()]);
      const total = list ? uniqueMembers(list).filter(m => m.status === 'active').length : null;
      const bot = !!process.env.DISCORD_BOT_TOKEN, parts = [`${s.linked}${total === null ? '' : ` of ${total}`} members have a Discord ID saved (${s.verified} verified)`, bot ? 'direct messages on' : 'direct messages off (no bot token)', comms.oauthOn() ? 'sign in with Discord on' : 'sign in with Discord off', auto.autoNudge ? 'automatic reminders on' : 'automatic reminders off'];
      return [bot || !auto.autoNudge ? 'ok' : 'warn', `${parts.join(' · ')}.`];
    }),
    run('cron', 'Scheduled runs (GitHub workflow)', async () => {
      if (!process.env.CRON_SECRET) return ['fail', 'CRON_SECRET is not set, so reminders, closing and rollover only run when someone opens the TTT page.'];
      const [last] = await redis([['GET', CRON_LAST_KEY]]);
      if (!last) return ['warn', 'CRON_SECRET is set but no scheduled run has been recorded yet (the workflow runs every 15 minutes).'];
      const age = Date.now() - Date.parse(last);
      const [bad] = await redis([['GET', CRON_FAILED_KEY]]);
      if (bad) { const b = JSON.parse(bad); return ['fail', `Last scheduled run ${ago(age)}, but ${b.failed.map(f => `the ${f.job} job failed (${f.error})`).join('; ')}.`]; }
      if (age <= 45 * 60000) return ['ok', `Last scheduled run ${ago(age)}.`];
      // GitHub's own schedule often runs hours apart, so a gap alone is a warning; a day of silence is a failure.
      return [age <= 26 * 3600000 ? 'warn' : 'fail', `Last scheduled run ${ago(age)}. Expected every 15 minutes: without a QStash schedule (see README) the TTT only runs on time when someone opens the page.`];
    }),
    run('signin', 'Member sign-in (cryogen.team)', async () => process.env.WP_SSO_SECRET
      ? ['ok', 'On. Riders can sign in with their cryogen.team account.']
      : ['warn', 'WP_SSO_SECRET is not set, so the sign-in button is hidden.']),
    run('guests', 'Guest sign-ups', async () => memberLoginRequired()
      ? ['ok', 'Blocked: only signed-in members and staff can sign up, withdraw or RSVP.']
      : ['info', 'Allowed: anyone using the name-picker can sign up as anyone. Set REQUIRE_MEMBER_LOGIN=1 to block this.']),
    run('staff', 'Staff passwords and sessions', async () => {
      const missing = ['ADMIN_PASSWORD', 'MOD_PASSWORD'].filter(k => !process.env[k]);
      if (missing.length) return ['fail', `${missing.join(' and ')} not set, so that login is unavailable.`];
      return process.env.SESSION_SECRET
        ? ['ok', 'Both passwords set; sessions use SESSION_SECRET.']
        : ['info', 'Both passwords set. SESSION_SECRET is not set, so sessions are derived from the passwords (changing a password signs everyone out).'];
    }),
    run('deploy', 'Deployment', async () => ['info', `${process.env.VERCEL_ENV || 'local'}${process.env.VERCEL_GIT_COMMIT_SHA ? `, commit ${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}` : ''}.`]),
  ]);
}

// ── Sheet proxy ────────────────────────────────────────────
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function gvizCell(cell){
  if (!cell || cell.v == null) return '';
  // Dates arrive as "Date(2026,9,16)" with a zero-based month; return YYYY-MM-DD.
  const d = typeof cell.v === 'string' && /^Date\((\d+),(\d+),(\d+)\)$/.exec(cell.v);
  if (d) return `${d[1]}-${String(+d[2] + 1).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
  return cell.f != null ? String(cell.f) : String(cell.v);
}

function parseGviz(textBody){
  const start = textBody.indexOf('{');
  const end = textBody.lastIndexOf('}');
  if (start < 0 || end < start) throw new HttpError(502, 'Unexpected response from Google Sheets.');
  const data = JSON.parse(textBody.slice(start, end + 1));
  if (data.status === 'error'){
    const msg = (data.errors || []).map(e => e.detailed_message || e.message).join('; ');
    throw new HttpError(502, `Google Sheets: ${msg || 'error'}`);
  }
  const cols = data.table.cols;
  let rows = data.table.rows.map(r => cols.map((c, i) => gvizCell((r.c || [])[i])));
  let headers = cols.map(c => (c.label || '').trim().replace(/^#(REF!|N\/A|VALUE!|NAME\?|ERROR!)$/, ''));
  // If Google didn't detect a usable header row (e.g. a laid-out sheet with titles a few rows
  // down and other blocks further right), take the leftmost block of filled columns, use its
  // first row with at least 3 filled cells as the headers, and keep only those columns.
  if (headers.filter(Boolean).length < 2 && rows.length){
    const used = cols.map((c, i) => rows.some(r => r[i] !== ''));
    const start = used.indexOf(true);
    let end = start;
    while (end + 1 < used.length && used[end + 1]) end++;
    const inBlock = i => i >= start && i <= end;
    const at = start < 0 ? -1 : rows.findIndex(r => r.filter((v, i) => inBlock(i) && v !== '').length >= 3);
    if (at >= 0){
      const keepCols = rows[at].map((v, i) => (inBlock(i) && v !== '' ? i : -1)).filter(i => i >= 0);
      headers = keepCols.map(i => rows[at][i]);
      rows = rows.slice(at + 1).map(r => keepCols.map(i => r[i]));
    }
  }
  headers = headers.map((h, i) => h || `Column ${i + 1}`);
  // This data is public, so never pass on email columns or email-looking values, nor the
  // personal columns (gender, free-text comments) that the dashboard doesn't use.
  const keep = headers.map((h, i) => !/e-?mail|^\s*(gender|sex|comments?|notes?)\s*$/i.test(h) && !rows.some(r => EMAIL_RE.test(r[i])));
  headers = headers.filter((h, i) => keep[i]);
  rows = rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(r.filter((v, i) => keep[i]).map((v, i) => [headers[i], v])));
  return { headers, rows };
}

// Google can be slow; without a limit the request would hang until Vercel cuts the function off with no message.
const sheetTimeoutMs = () => Number(process.env.SHEET_TIMEOUT_MS) || 6000;

async function fetchTab(tab, headerRows = 1, sheetId = SHEET_ID, timeoutMs = sheetTimeoutMs()){
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json&headers=${headerRows}&sheet=${encodeURIComponent(tab)}`;
  let r, body;
  try {
    r = await fetch(sheetUrl, { headers: { 'User-Agent': 'cryogen-proxy/2.0' }, signal: AbortSignal.timeout(timeoutMs) });
    body = await r.text();
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new HttpError(504, 'Google Sheets did not answer in time. Try again in a moment.');
    throw new HttpError(502, 'Google Sheets could not be reached.');
  }
  if (!r.ok) throw new HttpError(502, `Google Sheets returned ${r.status} for tab "${tab}".`);
  if (/^\s*</.test(body)) throw new HttpError(502, 'The Google Sheet is not shared publicly ("Anyone with the link can view").');
  return body;
}

// Every cell of a tab as plain strings (no header row), for tabs laid out as a board rather than a table.
// Google answers an unknown tab name with the first tab, so a wrong name cannot be told apart from the first
// tab here: callers check that what came back is the layout they expect.
async function fetchGrid(tab, sheetId = SHEET_ID){
  const body = await fetchTab(tab, 0, sheetId);
  const table = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)).table || {};
  return (table.rows || []).map(r => (r.c || []).map(c => (c && c.v !== null && c.v !== undefined ? String(c.v) : (c && c.f) || '').trim()));
}

async function handleSheet(endpoint, res){
  const tab = SHEET_TABS[endpoint];
  // Google silently returns the first tab when the named one doesn't exist. Detect that by
  // comparing with what a tab name that can't exist returns.
  const [body, fallback] = await Promise.all([fetchTab(tab), fetchTab(`__no_such_tab_${Date.now()}`)]);
  const columns = b => JSON.stringify(JSON.parse(b.slice(b.indexOf('{'), b.lastIndexOf('}') + 1)).table?.cols || null);
  const cols = columns(body);
  if (cols !== 'null' && cols === columns(fallback)){
    throw new HttpError(404, `The Google Sheet has no tab named "${tab}".`);
  }
  const { headers, rows } = parseGviz(body);
  // Google silently falls back to the first tab when the named tab doesn't exist,
  // so make sure this really looks like a rides tab before showing it as rides.
  if (endpoint === 'rides' && !headers.some(h => /^(title|date)$/i.test(h))){
    throw new HttpError(404, `No "${tab}" tab with Title and Date columns was found in the Google Sheet.`);
  }
  const updated = new Date().toISOString();
  sendJSON(res, 200, endpoint === 'rides' ? { rides: rows, headers, updated } : { headers, rows, updated });
}

// ── Static files (local dev) ───────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serveStatic(res, reqPath){
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath === '/' ? '/index.html' : reqPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()){
    return sendJSON(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── ZRL (Zwift Racing League) ──────────────────────────────
// Round sign-up, time-zone demand and team setup live in lib/zrl.js (not in api/, where every file becomes a public function).
const staff = require('../lib/staff')({ redis, HttpError, requireRole, text });   // personal staff accounts

// What the automation changed, with an undo (lib/autolog.js).
const autoLog = require('../lib/autolog')({ redis, HttpError, requireRole });
const zrl = require('../lib/zrl')({
  staffNameOf: req => String((sessionFromRequest(req) || {}).staffName || ''),
  autoLog, notify: (...a) => comms.notify(...a),   // comms is created further down
  redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, identify, discord, discordEscape, fetchRoster,
  validDate, ukTime, ukLabel, teamId, fetchGrid, siteUrl: SITE_URL,
  coverHonours: (since, now) => cover.honours(since, now),   // ride cover is created further down
});

// Ride cover (lib/cover.js): leaders and sweepers for the weekly social rides.
const cover = require('../lib/cover')({
  redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, teamId, siteUrl: SITE_URL,
});
async function handleCover(coverRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await coverRoute(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, { ...body, rows: undefined }, { staffOnly: false }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// One event's finishers from ZwiftRacing.app (the organizer key stays on the server). Returns { results: [{ riderId, position, ... }], time, title }.
// The API allows one results request a minute, so callers ask once per event and treat a 404 as "not published yet".
async function fetchZrResults(id){
  const key = process.env.ZWIFTRACING_API_KEY;
  if (!key) throw new HttpError(503, 'ZWIFTRACING_API_KEY is not set in Vercel yet.');
  if (!/^\d{1,12}$/.test(String(id || ''))) throw new HttpError(400, 'The event id is a number (the end of the Zwift event link).');
  let r, data;
  try {
    r = await fetch(`https://api.zwiftracing.app/api/public/results/${id}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
    try { data = JSON.parse(await r.text()); } catch (e) { data = null; }
  } catch (e) {
    throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, e && e.name === 'TimeoutError' ? 'ZwiftRacing.app did not answer in time.' : 'ZwiftRacing.app could not be reached.');
  }
  if (r.status === 429) throw new HttpError(429, `ZwiftRacing.app allows one results request a minute. Try again${data && data.retryAfter ? ` in ${data.retryAfter} seconds` : ' in a minute'}.`);
  if (r.status === 401) throw new HttpError(502, 'ZwiftRacing.app did not accept the key (401).');
  if (!r.ok || !data || !Array.isArray(data.results)) throw new HttpError(404, 'ZwiftRacing.app has no results for that event id yet.');
  return data;
}

// Zwift Club Ladder (lib/ladder.js): the 5v5 head-to-head ladder, roster of 15, three-rank line-ups.
const ladder = require('../lib/ladder')({
  autoLog, notify: (...a) => comms.notify(...a), fetchZrResults, redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, getRiders: async () => (await fetchRoster()).riders, siteUrl: SITE_URL,
});
async function handleLadder(ladderRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await ladderRoute(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// DIRT Racing Series (lib/drs.js): a squad of eight in a vELO division, a fixed Tuesday calendar, the best four finishers score.
const drs = require('../lib/drs')({
  autoLog, notify: (...a) => comms.notify(...a), fetchZrResults, redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, siteUrl: SITE_URL,
  // Raw vELO ratings from the club roster the dashboard already caches: no ZwiftRacing.app calls of its own, so no rate limits to respect.
  getRatings: async () => Object.fromEntries((await fetchRoster()).riders.map(r => [String(r.riderId), { name: r.name, rating: Math.round((r.race && r.race.current && r.race.current.rating) || 0), cat: (r.race && r.race.current && r.race.current.mixed && r.race.current.mixed.category) || '' }])),
});
async function handleDrs(drsRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await drsRoute(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// Associate members (lib/assoc.js): a limited sign-in with a route to full membership.
async function wpSaveMember(zwiftId, changes){
  const auth = process.env.WP_API_USER && process.env.WP_API_APP_PASSWORD ? `${process.env.WP_API_USER}:${process.env.WP_API_APP_PASSWORD}` : null;
  if (!auth) return false;
  const record = uniqueMembers(await wpGet('/members', auth)).find(m => String(m.zwift_id) === String(zwiftId));
  if (!record) return false;
  const r = await fetch(`${WP_API}/members/${encodeURIComponent(record.id ?? zwiftId)}`, {
    method: 'PATCH',
    headers: { 'User-Agent': 'cryogen-proxy/2.0', Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new HttpError(502, `WordPress refused the change (${r.status}).`);
  rosterCache = null;
  return true;
}
const assoc = require('../lib/assoc')({
  redis, HttpError, text, requireRole, memberFromRequest, discord, discordEscape, siteUrl: SITE_URL,
  // What an associate has done: social rides joined (RSVPs under their name) and team events (a TTT or ZRL sign-up).
  activityOf: async (zwid, name) => {
    const [rsvps, last, zrlSignup] = await redis([['HGETALL', KEYS.rsvps], ['HGET', TTT_KEYS.last, zwid], ['HGET', zrl.KEYS.signups, zwid]]);
    const mine = String(name || '').toLowerCase();
    let n = 0;
    for (let i = 0; i < (rsvps || []).length; i += 2) { try { if (String(JSON.parse(rsvps[i + 1]).name || '').toLowerCase() === mine) n++; } catch (e) { /* skip */ } }
    return { rsvps: n, teamEvents: (last ? 1 : 0) + (zrlSignup ? 1 : 0) };
  },
  inClub: async zwid => { try { return (await fetchRoster()).riders.some(r => String(r.riderId) === String(zwid)); } catch (e) { return false; } },
  setWpTier: zwid => wpSaveMember(zwid, { tier: 'full' }),
  discordLinked: zwid => comms.linkedVerified(zwid),
});
// What a signed-in associate may call: the weekly TTT and ZRL sign-up, the other race sign-ups and the social-ride RSVPs, plus what the pages
// read and their own upgrade journey. Everything else answers "for full members".
const ASSOCIATE_ALLOWED = new Set(['GET /api/me', 'GET /api/state', 'GET /api/roster', 'GET /api/proxy',
  'GET /api/ttt', 'GET /api/ttt/mine', 'GET /api/ttt/season', 'GET /api/ttt/archive', 'POST /api/ttt/signup', 'POST /api/ttt/withdraw', 'POST /api/ttt/repeat',
  'GET /api/zrl', 'GET /api/zrl/mine', 'GET /api/zrl/standings', 'POST /api/zrl/signup', 'POST /api/zrl/withdraw', 'POST /api/zrl/availability',
  'POST /api/signups', 'POST /api/rsvps', 'POST /api/rsvps/cancel',
  'GET /api/me/week', 'GET /api/me/tz', 'POST /api/me/tz', 'GET /api/me/calendar', 'POST /api/me/calendar', 'POST /api/me/calendar/remove', 'GET /api/me/discord', 'GET /api/me/discord/start', 'POST /api/me/discord', 'POST /api/me/discord/verify', 'POST /api/me/discord/prefs', 'POST /api/me/discord/remove', 'POST /api/me/discord/test', 'GET /api/assoc/status', 'POST /api/assoc/discord', 'POST /api/assoc/request']);
async function handleAssoc(assocRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await assocRoute(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body, { staffOnly: false }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// Staff messages to Discord (lib/comms.js): everyone in the club channel, or chosen members by DM (with a bot) or @mention.
const push = require('../lib/webpush')({ redis, HttpError, requireRole, memberFromRequest, siteUrl: SITE_URL });
const comms = require('../lib/comms')({
  push,
  buttonsFor: (series, id) => discordInteractions.buttons(series, id),   // created just below
  redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord,
  templates: req => commsTemplates.build(req),
  nudges: now => commsTemplates.nudges(now),
  siteUrl: SITE_URL,
  signState: payload => signToken('discord-state', payload),
  readState: token => { const sess = sessionFromRequest({ headers: { authorization: `Bearer ${token}` } }); return sess && sess.role === 'discord-state' ? sess : null; },
  candidates: async () => {
    const out = new Map();
    try {
      const { riders, members } = await fetchRoster();
      for (const r of riders) out.set(String(r.riderId), r.name);
      for (const m of uniqueMembers(members || [])) if (m.name) out.set(String(m.zwift_id), m.name);
    } catch (e) { /* nothing to match against */ }
    return [...out].map(([zwid, name]) => ({ zwid, name }));
  },
  namesFor: async zwids => {
    const out = {};
    try {
      const { riders, members } = await fetchRoster();
      for (const r of riders) out[String(r.riderId)] = r.name;
      for (const m of uniqueMembers(members || [])) out[String(m.zwift_id)] = m.name || out[String(m.zwift_id)];
    } catch (e) { /* ids are shown instead */ }
    return Object.fromEntries(zwids.map(z => [z, out[z] || z]));
  },
});
// The ready-made reminders in Comms (lib/comms-templates.js), worked out from the live data.
const activeMembers = async () => {
  const { riders, members } = await fetchRoster();
  const db = members && uniqueMembers(members);
  return db ? db.filter(m => m.status === 'active').map(m => String(m.zwift_id)) : riders.map(r => String(r.riderId));
};
const commsTemplates = require('../lib/comms-templates')({
  zrl, ladder, drs, activeMembers, siteUrl: SITE_URL,
  assocList: req => assoc.routes['GET /api/assoc/list'](req),
  reach: async () => { const [ids, s] = await Promise.all([activeMembers(), comms.stats()]); return { members: ids.length, ...s }; },
  tttCandidates: async () => {
    const data = await loadTtt();
    if (!data.week || !data.week.open) return { open: false };
    const [last] = await redis([['HKEYS', TTT_KEYS.last]]);
    const have = new Set(data.signups.map(s => s.zwid).filter(Boolean)), active = new Set(await activeMembers());
    return { open: true, title: data.week.title, zwids: (last || []).filter(k => /^\d+$/.test(k) && !have.has(k) && active.has(k)) };
  },
});
// Discord sends a rider back here after "Sign in with Discord"; we link the account and return them to the page.
async function handleDiscordCallback(req, res){
  const outcome = await comms.callback(parseRequestUrl(req).query).catch(() => 'failed');
  res.writeHead(302, { Location: `/#discord=${outcome}`, 'Cache-Control': 'no-store' });
  res.end();
}
// The Discord import posts whole member lists (a few hundred KB), so those two routes read a larger body, and only for staff.
const COMMS_BIG_BODY = new Set(['/api/comms/import', '/api/comms/discord-match']);
async function handleComms(route, req, res){
  const big = req.method === 'POST' && COMMS_BIG_BODY.has(parseRequestUrl(req).pathname);
  if (big) requireRole(req, ['admin', 'mod']);
  const body = req.method === 'POST' ? await readJSONBody(req, big ? 800000 : 20000) : {};
  const result = await route(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST' && !parseRequestUrl(req).pathname.startsWith('/api/me/')) await zrl.logChange(req, parseRequestUrl(req).pathname, { audience: body.audience, count: Array.isArray(body.zwids) ? body.zwids.length : undefined }, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// The staff rider profile (lib/profile.js): teams across the club, Discord link, and staff notes and details.
const profile = require('../lib/profile')({ redis, HttpError, requireRole, memberFromRequest, text, zrl, ladder, drs, comms, tttArchive: TTT_KEYS.archive });
async function handleProfile(route, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await route(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST' && !parseRequestUrl(req).pathname.startsWith('/api/me/')) await zrl.logChange(req, parseRequestUrl(req).pathname, { zwid: body.zwid }, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// Duplicate and inactive members (lib/tidy.js): finds them; staff act with the member tools that already exist.
const tidy = require('../lib/tidy')({ requireRole, fetchRoster, normTier });

// Google Sheet sync (lib/sheetsync.js, lib/gsheets.js): the sheets pulled into the app (the sheet wins) and the app's teams pushed to a mirror tab it owns.
const gsheets = require('../lib/gsheets')();
const syncReq = () => ({ headers: { authorization: `Bearer ${signToken('admin')}` } });   // the sync acts as staff, inside this process only
async function tttMirrorRows(){
  const head = ['Team', 'Level', 'Zone', 'Rider', 'Zwift ID', 'Cat', 'Volunteer captain', 'Double up'];
  const data = await loadTtt();
  if (!data.week) return [head];
  const rows = [head], placed = new Set();
  for (const t of data.week.teams) {
    const riders = data.signups.filter(s => (data.assign[s.name.toLowerCase()] || []).includes(t.id)).sort((a, b) => (b.captain === true) - (a.captain === true) || a.name.localeCompare(b.name));
    riders.forEach(s => placed.add(s.name.toLowerCase()));
    if (!riders.length) rows.push([t.name, t.level || '', t.zone || '', '', '', '', '', '']);
    for (const s of riders) rows.push([t.name, t.level || '', t.zone || '', s.name, s.zwid || '', s.cat || '', s.captain ? 'Yes' : '', s.doubleUp ? 'Yes' : '']);
  }
  for (const s of data.signups.filter(x => x.available && !placed.has(x.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))) rows.push(['— Not in a team —', '', '', s.name, s.zwid || '', s.cat || '', s.captain ? 'Yes' : '', s.doubleUp ? 'Yes' : '']);
  return rows;
}
async function tttPull(){
  if (!(await loadTtt()).week) throw new HttpError(409, 'There is no TTT week yet, so there is nothing to sync into.');
  const a = await TTT_ROUTES['POST /api/ttt/import-sheet'](syncReq(), { apply: true });
  const b = await TTT_ROUTES['POST /api/ttt/import-board'](syncReq(), { apply: true, overwrite: true, prune: true });
  return { signups: a.imported, placed: b.board.placed, removed: b.board.pruned, created: b.board.created, skipped: b.board.skipped.length };
}
const ZRL_SHEET_DEFAULT = '1s8lrYj3f-nD3qSmlA_kaSRJxzvun7-ZJfIl8kR5Pjsc';   // the club's ZRL tracker
const sheetSync = require('../lib/sheetsync')({
  redis, HttpError, requireRole, roleFromRequest, gsheets,
  series: {
    ttt: { label: 'TTT', mirrorTab: 'CRYO-GEN App TTT', pullTab: SHEET_TABS['ttt-sheet'], sheetId: () => SHEET_ID, rows: tttMirrorRows, pull: tttPull },
    zrl: { label: 'ZRL', mirrorTab: 'CRYO-GEN App ZRL', pullTab: 'TEAM LIST', sheetId: () => process.env.ZRL_SHEET_ID || ZRL_SHEET_DEFAULT, rows: () => zrl.mirrorRows(),
      pull: async sheetId => (await zrl.routes['POST /api/zrl/sync-board'](syncReq(), { tab: 'TEAM LIST', sheet: sheetId })).sync },
    // The Ladder and the DIRT Series are published to a mirror tab only for now (the sheet cannot change the app), in the club's ZRL workbook until another is chosen.
    ladder: { label: 'Ladder', mirrorTab: 'CRYO-GEN App Ladder', pullTab: '', sheetId: () => process.env.ZRL_SHEET_ID || ZRL_SHEET_DEFAULT, rows: () => ladder.mirrorRows(), pull: null },
    drs: { label: 'DIRT Series', mirrorTab: 'CRYO-GEN App DIRT', pullTab: '', sheetId: () => process.env.ZRL_SHEET_ID || ZRL_SHEET_DEFAULT, rows: () => drs.mirrorRows(), pull: null },
  },
});
async function handleSync(route, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await route(req, body);
  if (req.method === 'POST' && !parseRequestUrl(req).pathname.endsWith('/auto')) await zrl.logChange(req, parseRequestUrl(req).pathname, { series: body.series, direction: body.direction }, { staffOnly: true }).catch(e => console.error('Log:', e.message));
  sendJSON(res, 200, result);
}

// The public club page (public/club.html): season tables, results and next races, with no rider names, no private links and nothing about people.
// Off until an administrator turns it on; while it is off the address answers 404.
const PUBLIC_KEY = 'cg:public:settings';
let publicCache = null;
const publicOn = async () => { try { return !!JSON.parse((await redis([['GET', PUBLIC_KEY]]))[0] || 'null').on; } catch (e) { return false; } };
async function publicClub(now = Date.now()){
  const staff = syncReq(), out = { name: 'CRYO-GEN', generated: new Date(now).toISOString(), ladder: [], drs: [], next: [] };
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  try {
    for (const t of (await ladder.view(staff, undefined, now)).teams) {
      const v = await ladder.view(staff, t.id, now), rec = v.record;
      out.ladder.push({ team: t.name, rung: (v.meta && v.meta.rung) || null, played: rec.played, won: rec.won, lost: rec.lost, pointsFor: rec.pointsFor, pointsAgainst: rec.pointsAgainst,
        recent: v.matches.filter(m => m.status === 'played' && m.result).slice(0, 5).map(m => ({ opponent: m.opponent, date: m.at ? day(m.at) : '', won: m.result.won, score: `${m.result.ourPoints}-${m.result.theirPoints}` })) });
      for (const m of v.matches) if (m.status === 'scheduled' && m.at && m.at > now) out.next.push({ series: 'Ladder', title: `${t.name} v ${m.opponent}`, at: m.at });
    }
  } catch (e) { /* a series that cannot be read is left out */ }
  try {
    for (const t of (await drs.view(staff, undefined, now)).teams) {
      const v = await drs.view(staff, t.id, now); if (!v.season) continue;
      out.drs.push({ team: t.name, division: v.season.division, season: v.season.name, played: v.record.played, teamPoints: v.record.teamPoints,
        stages: v.stages.map(s => ({ n: s.n, date: s.date, type: v.types[s.type] || s.type, route: s.route || '', played: s.status === 'played', teamPoints: s.result ? s.result.teamPoints : null })) });
      for (const s of v.stages) if (s.status === 'upcoming' && s.startMs > now) out.next.push({ series: 'DIRT Series', title: `${t.name} · stage ${s.n}${s.route ? ' · ' + s.route : ''}`, at: s.startMs });
    }
  } catch (e) { /* ditto */ }
  try {
    const z = await zrl.load();
    if (z.round) {
      out.zrl = { round: z.round.name, start: z.round.start, weeks: z.round.weeks, teams: z.round.teams.filter(t => z.signups.some(x => x.in && (z.assign[x.key] || []).includes(t.id))).map(t => ({ name: t.name, division: t.division || '', league: t.league || '' })) };
      for (let i = 0; i < z.round.weeks; i++) { const ms = Date.parse(`${z.round.start}T00:00:00Z`) + i * 7 * 86400000; if (ms > now - 86400000) out.next.push({ series: 'ZRL', title: `${z.round.name} · race ${i + 1}`, at: ms, dayOnly: true }); }
    }
  } catch (e) { /* ditto */ }
  try {
    const t = await loadTtt();
    if (t.week && t.week.date && Date.parse(`${t.week.date}T00:00:00Z`) > now - 86400000) { out.ttt = { title: t.week.title || 'Weekly TTT', date: t.week.date }; out.next.push({ series: 'TTT', title: t.week.title || 'Weekly TTT', at: Date.parse(`${t.week.date}T00:00:00Z`), dayOnly: true }); }
  } catch (e) { /* ditto */ }
  // The club wall: the club's accent and the top three of each ZRL division (team names and points only).
  try { const th = await clubTheme.get(now); out.accent = th.accent || ''; out.welcome = th.welcome || ''; } catch (e) { /* the default look */ }
  try {
    const st = await zrl.routes['GET /api/zrl/standings'](staff);
    out.podium = (st.groups || []).slice(0, 4).map(g => ({ division: g.name, top: g.teams.filter(t => t.rank <= 3 && t.total > 0).slice(0, 3).map(t => ({ rank: t.rank, team: t.name.replace(/^CRYO-GEN\s+/, ''), points: t.total })) })).filter(g => g.top.length);
  } catch (e) { /* no standings yet */ }
  out.next = out.next.filter(x => x.at < now + 21 * 86400000).sort((a, b) => a.at - b.at).slice(0, 12).map(x => ({ ...x, date: day(x.at), at: x.dayOnly ? null : x.at }));
  return out;
}

// "Ask the club" (lib/assistant.js): plain words to a short plan from a fixed menu, shown to staff and run only when they confirm. Needs ANTHROPIC_API_KEY.
const assistant = require('../lib/assistant')({ redis, HttpError, requireRole, adminReq: () => syncReq(), zrl, ladder, drs, autoLog });

const lifecycle = require('../lib/lifecycle')({ redis, requireRole, tidy, notify: (...a) => comms.notify(...a), siteUrl: SITE_URL });   // members who have gone quiet
const projection = require('../lib/projection')({ requireRole, adminReq: () => syncReq(), zrl, ladder, drs });   // the season outlook

// New-member onboarding (lib/onboarding.js): what each recent joiner still has to do, and two friendly messages for those who can be messaged.
const onboarding = require('../lib/onboarding')({
  redis, HttpError, requireRole, activeMembers, fetchRoster, siteUrl: SITE_URL, notify: (...a) => comms.notify(...a), verifiedLinks: () => comms.verifiedLinks(),
  // Everyone who is on a team or has signed up somewhere right now: ZRL sign-ups, the Ladder rosters, DIRT squads and this week's TTT.
  teamSets: async () => {
    const [zs, lr, ds, ts] = await redis([['HGETALL', zrl.KEYS.signups], ['HGETALL', ladder.KEYS.roster], ['HGETALL', drs.KEYS.squad], ['HGETALL', TTT_KEYS.signups]]);
    const out = new Set(), vals = raw => { const o = []; for (let i = 0; i < (raw || []).length; i += 2) { try { o.push([raw[i], JSON.parse(raw[i + 1])]); } catch (e) { /* skip */ } } return o; };
    for (const [, v] of vals(zs)) if (v.zwid && v.in !== false) out.add(String(v.zwid));
    for (const [f, v] of vals(lr)) out.add(String((v && v.zwid) || f.split('|').pop()));
    for (const [f, v] of vals(ds)) out.add(String((v && v.zwid) || f.split('|').pop()));
    for (const [, v] of vals(ts)) if (v.zwid && v.available !== false) out.add(String(v.zwid));
    return out;
  },
});

// Yes / Maybe / No buttons under Discord reminders (lib/discord-interactions.js): Discord posts each tap, signed, to /api/discord/interactions.
const discordInteractions = require('../lib/discord-interactions')({
  zwidOfDiscord: id => comms.zwidOfDiscord(id),
  // The answer is saved by the same route a rider's own tap in the dashboard uses, as that rider (a member token made here, inside this process only).
  answer: async (zwid, series, id, status) => {
    const req = { headers: { authorization: `Bearer ${signToken('member', { zwid, name: zwid })}` } };
    if (series === 'zrl') { const [week, team] = id.split(':'); await zrl.routes['POST /api/zrl/availability'](req, { week: Number(week), team, status }); }
    else if (series === 'ladder') await ladder.routes['POST /api/ladder/availability'](req, { match: id, status });
    else await drs.routes['POST /api/drs/availability'](req, { stage: id, status });
  },
});
function readRawBody(req, limit = 20000){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit){ reject(new HttpError(413, 'request too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// The go-live checklist (lib/golive.js): what is on, what is half set up, and the next step for each.
const trend = require('../lib/trend')({ redis, HttpError, requireRole, memberFromRequest, fetchRoster, activeMembers, keys: { rides: KEYS.rides, rsvps: KEYS.rsvps },
  // What the staff pages chart: how much needs attention, how many riders are racing and how many have no team yet.
  staffMetrics: async () => {
    const out = {};
    try { out.attention = ((await week.build(syncReq(), Date.now(), 'admin')).attention || []).length; } catch (e) { /* left out */ }
    try { const z = await zrl.load(); if (z.round) { const racing = z.signups.filter(x => x.in), ids = new Set(z.round.teams.map(t => t.id)); out.racing = racing.length; out.unplaced = racing.filter(x => !teamsOfAssign(z.assign[x.key]).some(i => ids.has(i))).length; out.teams = z.round.teams.length; } } catch (e) { /* ditto */ }
    return out;
  } });
const teamsOfAssign = v => (Array.isArray(v) ? v : String(v || '').split(',')).filter(Boolean);
const avatars = require('../lib/avatars')({ redis, HttpError, memberFromRequest, roleFromRequest });
const fairplay = require('../lib/fairplay')({ redis, HttpError, requireRole, staffNameOf: req => String((sessionFromRequest(req) || {}).staffName || ''), fetchRoster, activeMembers, discord, siteUrl: SITE_URL });
const fitAnalysis = require('../lib/fitanalysis');
const investigations = require('../lib/investigations')({ redis, HttpError, requireRole, staffNameOf: req => String((sessionFromRequest(req) || {}).staffName || ''), fetchRoster, analyse: fitAnalysis.analyse, reweigh: fitAnalysis.reweigh });
const coach = require('../lib/coach')({ redis, HttpError, memberFromRequest, fetchRoster, myweek: { build: req => myweek.build(req) }, analyse: fitAnalysis.analyse });
const clubTheme = require('../lib/clubtheme')({ redis, HttpError, requireRole });
const history = require('../lib/history')({ redis, requireRole, xlsx: require('../lib/xlsx'), keys: { zrl: zrl.KEYS, ladder: ladder.KEYS, drs: drs.KEYS } });
const staging = require('../lib/staging')({ requireRole, zrl, asStaff: syncReq });
const golive = require('../lib/golive')({
  requireRole,
  gather: async () => {
    const [checks, ids, stats, devices, users, settings, sync, lt, dt] = await Promise.all([
      healthChecks().catch(() => []), activeMembers().catch(() => []), comms.stats().catch(() => ({ verified: 0 })), redis([['HLEN', push.KEY]]).then(r => Number(r[0]) || 0).catch(() => 0),
      redis([['HLEN', staff.KEY]]).then(r => Number(r[0]) || 0).catch(() => 0), comms.getSettings().catch(() => ({})), sheetSync.load().catch(() => ({ settings: {} })),
      ladder.view(syncReq(), undefined).catch(() => null), drs.view(syncReq(), undefined).catch(() => null)]);
    const row = id => checks.find(c => c.id === id) || {}, links = await redis([['HGETALL', comms.KEYS.links]]).then(r => r[0] || []).catch(() => []), verifiedIds = new Set(), pushIds = new Set((await redis([['HKEYS', push.KEY]]).catch(() => [[]]))[0] || []);
    for (let i = 0; i < links.length; i += 2) { try { if (JSON.parse(links[i + 1]).verified) verifiedIds.add(links[i]); } catch (e) { /* skip */ } }
    const teams = []; for (const t of (lt ? lt.teams : [])) teams.push(['ladder', t.id]); for (const t of (dt ? dt.teams : [])) teams.push(['drs', t.id]);
    let named = 0, total = 0;   // teams that are in use (a ladder team with riders, a DIRT team with a season) and how many have a captain
    for (const [kind, id] of teams) {
      try {
        const v = kind === 'ladder' ? await ladder.view(syncReq(), id) : await drs.view(syncReq(), id);
        if (kind === 'ladder' ? !v.roster.length : !v.season) continue;
        total++; if ((kind === 'ladder' ? v.meta.captains : v.season.captains || []).length) named++;
      } catch (e) { /* skip */ }
    }
    return { env: process.env, redis: row('db').status !== 'fail', cron: ['ok', 'info'].includes(row('cron').status) ? 'ok' : 'todo', cronDetail: row('cron').detail || '', backup: row('backup').status === 'ok' && !/FAILED/.test(row('backup').detail || '') ? 'ok' : 'todo', backupDetail: row('backup').detail || '',
      members: ids.length, verified: ids.filter(z => verifiedIds.has(z)).length, reachable: ids.filter(z => verifiedIds.has(z) || pushIds.has(z)).length, push: { configured: push.configured(), devices },
      auto: !!settings.autoNudge, staffAccounts: users, captains: { total, named }, google: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, sync: Object.values(sync.settings || {}).some(s => s.push || s.pull),
      digest: await redis([['GET', DIGEST_KEYS.settings]]).then(r => { try { return JSON.parse(r[0] || 'null').on === true; } catch (e) { return false; } }).catch(() => false), publicPage: await publicOn() };
  },
});

// The morning digest for the admin channel: what needs attention, what is on today and tomorrow, and what the automation did, once a day after 07:00 UK.
const DIGEST_KEYS = { settings: 'cg:digest:settings', sent: 'cg:digest:sent' };
async function runDigest(now = Date.now()){
  const [raw] = await redis([['GET', DIGEST_KEYS.settings]]);
  let on = false; try { on = !!(raw && JSON.parse(raw).on === true); } catch (e) { /* off */ }   // off until an administrator turns it on
  if (!on) return [];
  const uk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: 'numeric' }).format(new Date(now));
  if (Number(uk) < Number(process.env.DIGEST_FROM_HOUR || 7)) return [];   // the env var exists so tests do not depend on the time of day
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const w = await week.build(syncReq(), now, 'admin');
  const urgent = w.attention.filter(a => a.level === 'fail' || a.level === 'warn'), todo = w.attention.filter(a => a.level === 'todo');
  const soon = w.upcoming.filter(u => u.atMs <= now + 36 * 3600000 && u.atMs >= now - 3 * 3600000);
  const did = (await autoLog.list()).filter(e => Date.parse(e.ts) >= now - 24 * 3600000 && !e.undone);
  if (!urgent.length && !todo.length && !soon.length && !did.length) return [];
  const [claimed] = await redis([['HSETNX', DIGEST_KEYS.sent, day, new Date(now).toISOString()]]);
  if (!claimed) return [];
  const lines = [`☀️ **Good morning: the club today, ${new Date(now).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' })}**`];
  if (urgent.length) lines.push(`**Needs attention (${urgent.length}${todo.length ? `, and ${todo.length} to do` : ''})**\n${urgent.slice(0, 8).map(a => `${a.level === 'fail' ? '🔴' : '🟡'} ${discordEscape(a.title)}: ${discordEscape(a.detail)}`).join('\n')}${urgent.length > 8 ? `\n…and ${urgent.length - 8} more` : ''}`);
  else if (todo.length) lines.push(`**To do (${todo.length})**\n${todo.slice(0, 5).map(a => `⚪ ${discordEscape(a.title)}`).join('\n')}`);
  else lines.push('✅ Nothing needs attention.');
  if (soon.length) lines.push(`**On today and tomorrow**\n${soon.slice(0, 8).map(u => `• ${discordEscape(u.kind)}: ${discordEscape(u.title)}${u.timed ? ` at ${new Date(u.atMs).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UK` : ''}`).join('\n')}`);
  if (did.length) lines.push(`**The automation did ${did.length} thing${did.length === 1 ? '' : 's'} in the last day**\n${did.slice(0, 5).map(e => `🤖 ${discordEscape(e.series)}: ${discordEscape(e.summary)}`).join('\n')}\nUndo any of it on This week.`);
  lines.push(`${SITE_URL} → 📌 This week`);
  await discord('admin', { content: lines.join('\n\n').slice(0, 1900) });
  return ['digest'];
}

// Race day (lib/live.js): what is on now, who is in the pen, and the message twenty minutes before a start.
const live = require('../lib/live')({ discord, discordEscape, siteUrl: SITE_URL, adminReq: () => syncReq(), redis, HttpError, requireRole, roleFromRequest, memberFromRequest, ladder, drs, zrl, notify: (...a) => comms.notify(...a) });

// The staff "This week" page (lib/week.js): what needs attention and what is coming up, read from the modules above.
const week = require('../lib/week')({
  onboarding, requireRole, healthChecks, loadTtt, loadState, zrl, cover, ladder, drs,
  assocList: req => assoc.routes['GET /api/assoc/list'](req),
});

// The rider's "My week" card (lib/myweek.js): their own next seven days.
const myweek = require('../lib/myweek')({
  memberFromRequest, HttpError, loadTtt, myTttStatus, loadState, zrl, cover, ladder, drs,
  isAssociate: member => Promise.resolve(member.assoc === true && assoc.stillAssociate(member.zwid)),
});

// The rider's private calendar feed (lib/calendar.js): their next four weeks as a subscribable .ics.
const calendar = require('../lib/calendar')({
  redis, HttpError, memberFromRequest, myweek, siteUrl: SITE_URL,
  signMember: m => signToken('member', { zwid: m.zwid, name: m.name, ...(m.assoc ? { assoc: true } : {}) }),
});
async function handleCalendar(route, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  sendJSON(res, 200, await route(req, body));
}

// Daily copies of the ZRL and TTT data, kept in Redis (lib/backup.js); admins can download or restore them.
const backup = require('../lib/backup')({ redis, HttpError, requireRole, zrlKeys: zrl.KEYS, tttKeys: TTT_KEYS, ladderKeys: ladder.KEYS, coverKeys: cover.KEYS, drsKeys: drs.KEYS, assocKeys: assoc.KEYS, commsKeys: comms.KEYS, calendarKeys: calendar.KEYS, profileKeys: profile.KEYS, syncKeys: sheetSync.KEYS, extraHashes: [onboarding.KEY, live.KEY] });
async function handleBackup(route, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await route(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname.replace('/api/admin/', '/api/zrl/'), { id: body.id }).catch(e => console.error('ZRL log:', e.message));   // backing up and restoring are worth a line
  sendJSON(res, 200, result);
}

async function handleZrl(zrlRoute, req, res){
  if (req.method === 'GET') await zrl.runSchedule().catch(e => console.error('ZRL schedule:', e.message));
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await zrlRoute(req, body, parseRequestUrl(req).query);
  if (req.method === 'POST') await zrl.logChange(req, parseRequestUrl(req).pathname, body).catch(e => console.error('ZRL log:', e.message));
  // Whatever changed (an import, a move, a rider ticking the star), teams with riders and no captain get their first volunteer.
  if (req.method === 'POST') await zrl.afterChange().catch(e => console.error('ZRL captains:', e.message));
  sendJSON(res, 200, result || zrl.view(await zrl.load(), req));
}

// ── Router ─────────────────────────────────────────────────
async function route(req, res){
  const parsed = parseRequestUrl(req);
  const pathname = parsed.pathname || '/';
  const origin = req.headers.origin;

  if (origin && origin !== SITE_ORIGIN && !['GET', 'HEAD'].includes(req.method)) {
    throw new HttpError(403, 'Requests from this origin are not allowed.');
  }

  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': SITE_ORIGIN,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  // Writes by anyone who is not staff are capped per connection per minute (stops a script flooding sign-ups, RSVPs or storage).
  if (req.method === 'POST' && pathname !== '/api/login' && pathname !== '/api/cron/tick' && !roleFromRequest(req)){
    if (await counter(`cg:rl:w:${clientIp(req)}:${Math.floor(Date.now() / 60000)}`, 120) > writesPerMinute()) throw new HttpError(429, 'Too many requests. Please slow down and try again in a minute.');
  }

  // A signed-in associate reaches only the routes above; staff approval lifts it at once, even mid-session.
  const sess = sessionFromRequest(req);
  if (sess && sess.role === 'member' && sess.assoc === true && pathname.startsWith('/api/') && !['/api/login', '/api/auth/wp', '/api/auth/status', '/api/cron/tick'].includes(pathname)
      && !ASSOCIATE_ALLOWED.has(`${req.method} ${pathname}`) && await assoc.stillAssociate(sess.zwid)){
    return sendJSON(res, 403, { error: 'That is for full members. Request full membership from your profile to unlock it.', associate: true });
  }

  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/roster' && req.method === 'GET') return handleRoster(req, res);
  if (pathname === '/api/auth/status' && req.method === 'GET'){
    return sendJSON(res, 200, { sso: Boolean(process.env.WP_SSO_SECRET), url: WP_SSO_LOGIN_URL, requireLogin: memberLoginRequired(), staging: process.env.STAGING === '1' });
  }
  if (pathname === '/api/auth/wp' && req.method === 'GET') return handleWpSso(req, res, parsed.query.t);
  if (pathname === '/api/me' && req.method === 'GET') return handleMe(req, res);
  if (pathname === '/api/me/season' && req.method === 'GET') return handleMeSeason(req, res);
  if (pathname === '/api/me/season/share' && req.method === 'POST') return handleMeSeasonShare(req, res);
  if (pathname === '/api/health' && req.method === 'GET'){
    requireRole(req, ['admin']);
    return sendJSON(res, 200, { checked: new Date().toISOString(), checks: await healthChecks() });
  }
  const memberMatch = /^\/api\/members\/(\d+)$/.exec(pathname);
  if (pathname === '/api/members/bulk' && req.method === 'POST') return handleMemberBulk(req, res);
  const tidyRoute = tidy.routes[`${req.method} ${pathname}`];
  if (tidyRoute) return sendJSON(res, 200, await tidyRoute(req));
  if (memberMatch && req.method === 'POST') return handleMemberUpdate(req, res, memberMatch[1]);
  if (pathname === '/api/cron/tick' && (req.method === 'POST' || req.method === 'GET')) return handleCron(req, res);

  const dataRoute = DATA_ROUTES[`${req.method} ${pathname}`];
  if (dataRoute) return handleData(dataRoute, req, res);

  const tttRoute = TTT_ROUTES[`${req.method} ${pathname}`];
  if (tttRoute) return handleTtt(tttRoute, req, res);

  const zrlRoute = zrl.routes[`${req.method} ${pathname}`];
  if (zrlRoute) return handleZrl(zrlRoute, req, res);

  const myWeekRoute = myweek.routes[`${req.method} ${pathname}`];
  if (myWeekRoute) return sendJSON(res, 200, await myWeekRoute(req, undefined, parseRequestUrl(req).query));

  if (pathname === '/api/discord/callback' && req.method === 'GET') return handleDiscordCallback(req, res);

  if (pathname === '/api/public/club' && req.method === 'GET'){
    if (!await publicOn()) return sendJSON(res, 404, { error: 'Not found' });
    // Anyone can ask for this page, so the answer is made at most once a minute per server instance.
    if (!publicCache || Date.now() - publicCache.at > 60000) publicCache = { at: Date.now(), data: await publicClub() };
    return sendJSON(res, 200, publicCache.data);
  }
  if (pathname === '/api/public/settings'){
    const role = requireRole(req, ['admin', 'mod']);
    if (req.method === 'POST'){ requireRole(req, ['admin']); const b = await readJSONBody(req); await redis([['SET', PUBLIC_KEY, JSON.stringify({ on: b.on === true })]]); publicCache = null; return sendJSON(res, 200, { on: b.on === true, canChange: true }); }
    return sendJSON(res, 200, { on: await publicOn(), canChange: role === 'admin' });
  }
  const calFeed = /^\/api\/cal\/([A-Za-z0-9_-]+)\.ics$/.exec(pathname);
  if (calFeed && req.method === 'GET'){
    const ics = await calendar.feed(calFeed[1]);
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="cryogen.ics"', 'Cache-Control': 'private, max-age=900', 'Content-Length': Buffer.byteLength(ics) });
    return res.end(ics);
  }
  const calRoute = calendar.routes[`${req.method} ${pathname}`];
  if (calRoute) return handleCalendar(calRoute, req, res);

  const syncRoute = sheetSync.routes[`${req.method} ${pathname}`];
  if (syncRoute) return handleSync(syncRoute, req, res);
  const profileRoute = profile.routes[`${req.method} ${pathname}`];
  if (profileRoute) return handleProfile(profileRoute, req, res);

  const commsRoute = comms.routes[`${req.method} ${pathname}`];
  if (commsRoute) return handleComms(commsRoute, req, res);

  if (pathname === '/api/ping' && req.method === 'GET'){   // for an uptime check: is the app up and is its database answering
    try { await redis([['GET', 'cg:ping']]); } catch (e) { return sendJSON(res, 503, { ok: false, redis: false }); }
    return sendJSON(res, 200, { ok: true, redis: true, at: new Date().toISOString() });
  }
  if (pathname === '/api/discord/interactions' && req.method === 'POST'){
    const out = await discordInteractions.handle(await readRawBody(req), req.headers);
    return sendJSON(res, out.status, out.body);
  }
  if (pathname === '/api/digest' && (req.method === 'GET' || req.method === 'POST')) {
    const role = requireRole(req, ['admin', 'mod']);
    if (req.method === 'POST') { requireRole(req, ['admin']); const body = await readJSONBody(req); await redis([['SET', DIGEST_KEYS.settings, JSON.stringify({ on: body.on === true })]]); return sendJSON(res, 200, { on: body.on === true, canChange: true }); }
    const [raw] = await redis([['GET', DIGEST_KEYS.settings]]);
    let on = false; try { on = !!(raw && JSON.parse(raw).on === true); } catch (e) { /* off */ }
    return sendJSON(res, 200, { on, canChange: role === 'admin' });
  }
  if (pathname === '/api/selfcheck' && req.method === 'POST'){ requireRole(req, ['admin']); return sendJSON(res, 200, await selfCheck()); }
  if (pathname === '/api/outbox/flush' && req.method === 'POST'){ requireRole(req, ['admin']); await flushOutbox(); const [left] = await redis([['HLEN', OUTBOX_KEY]]); return sendJSON(res, 200, { left }); }
  const trendRoute = trend.routes[`${req.method} ${pathname}`] || clubTheme.routes[`${req.method} ${pathname}`] || avatars.routes[`${req.method} ${pathname}`] || fairplay.routes[`${req.method} ${pathname}`];
  if (trendRoute) return sendJSON(res, 200, await trendRoute(req, req.method === 'POST' ? await readJSONBody(req) : undefined, parseRequestUrl(req).query));
  // Investigation files and the coach take whole rides (up to six hours of one-second data), so their uploads may be larger than other requests.
  const bigRoute = investigations.routes[`${req.method} ${pathname}`] || coach.routes[`${req.method} ${pathname}`];
  if (bigRoute) return sendJSON(res, 200, await bigRoute(req, req.method === 'POST' ? await readJSONBody(req, ['/api/inv/file', '/api/coach/ride'].includes(pathname) ? 3000000 : 20000) : {}, parseRequestUrl(req).query));
  const historyRoute = history.routes[`${req.method} ${pathname}`];
  if (historyRoute) return sendJSON(res, 200, await historyRoute(req));
  const stagingRoute = staging.routes[`${req.method} ${pathname}`];
  if (stagingRoute) return sendJSON(res, 200, await stagingRoute(req));
  const goliveRoute = golive.routes[`${req.method} ${pathname}`];
  if (goliveRoute) return sendJSON(res, 200, await goliveRoute(req));

  const lifecycleRoute = lifecycle.routes[`${req.method} ${pathname}`];
  if (lifecycleRoute) return sendJSON(res, 200, await lifecycleRoute(req));

  const projectionRoute = projection.routes[`${req.method} ${pathname}`];
  if (projectionRoute) return sendJSON(res, 200, await projectionRoute(req));

  const assistantRoute = assistant.routes[`${req.method} ${pathname}`];
  if (assistantRoute) return sendJSON(res, 200, await assistantRoute(req, req.method === 'POST' ? await readJSONBody(req) : {}));

  const pushRoute = push.routes[`${req.method} ${pathname}`];
  if (pushRoute) return sendJSON(res, 200, await pushRoute(req, req.method === 'POST' ? await readJSONBody(req) : {}));

  const staffRoute = staff.routes[`${req.method} ${pathname}`];
  if (staffRoute) return sendJSON(res, 200, await staffRoute(req, req.method === 'POST' ? await readJSONBody(req) : {}));

  const onboardRoute = onboarding.routes[`${req.method} ${pathname}`];
  if (onboardRoute) return sendJSON(res, 200, await onboardRoute(req));

  const liveRoute = live.routes[`${req.method} ${pathname}`];
  if (liveRoute) return sendJSON(res, 200, await liveRoute(req, req.method === 'POST' ? await readJSONBody(req) : {}, parseRequestUrl(req).query));

  const autoRoute = autoLog.routes[`${req.method} ${pathname}`];
  if (autoRoute) return sendJSON(res, 200, await autoRoute(req, req.method === 'POST' ? await readJSONBody(req) : {}));

  const weekRoute = week.routes[`${req.method} ${pathname}`];
  if (weekRoute) return sendJSON(res, 200, await weekRoute(req));

  const assocRoute = assoc.routes[`${req.method} ${pathname}`];
  if (assocRoute) return handleAssoc(assocRoute, req, res);

  const drsRoute = drs.routes[`${req.method} ${pathname}`];
  if (drsRoute) return handleDrs(drsRoute, req, res);

  const ladderRoute = ladder.routes[`${req.method} ${pathname}`];
  if (ladderRoute) return handleLadder(ladderRoute, req, res);

  const coverRoute = cover.routes[`${req.method} ${pathname}`];
  if (coverRoute) return handleCover(coverRoute, req, res);

  const backupRoute = backup.routes[`${req.method} ${pathname}`];
  if (backupRoute) return handleBackup(backupRoute, req, res);

  if (pathname === '/api/proxy'){
    // Only named sheet tabs are allowed, so the proxy can't be used to fetch arbitrary URLs.
    const endpoint = parsed.query.endpoint;
    if (!Object.prototype.hasOwnProperty.call(SHEET_TABS, endpoint)){
      return sendJSON(res, 400, { error: 'unknown endpoint', endpoint: endpoint || null });
    }
    return handleSheet(endpoint, res);
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Not found' });
  serveStatic(res, pathname);
}

// An unexpected failure (not a refusal the app chose to make) is told to the admin channel, once an hour for the same place and message.
async function reportError(req, err){
  try {
    const where = `${req.method} ${String((parseRequestUrl(req).pathname) || '').replace(/[0-9a-f]{12,}|\d{6,}/gi, ':id').slice(0, 80)}`, what = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
    const hour = new Date().toISOString().slice(0, 13), key = `${hour}:${where}:${what}`.slice(0, 250);
    const [claimed] = await redis([['HSETNX', 'cg:alerts:errors', key, new Date().toISOString()]]);
    if (claimed) await discord('admin', { content: `🧯 **Unexpected error in the dashboard**\n\`${discordEscape(where)}\`: ${discordEscape(what)}\nIt answered "internal error". Check the Vercel logs for the full details.` });
  } catch (e) { /* alerting must never make things worse */ }
}

function handler(req, res){
  route(req, res).catch(err => {
    if (!err.status){ console.error(err); reportError(req, err); }
    if (res.headersSent) return res.end();
    sendJSON(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  });
}

// Vercel calls the exported handler; `npm start` runs a local server.
module.exports = handler;

if (require.main === module){
  http.createServer(handler).listen(PORT, () => console.log(`cryogen-proxy server listening on http://localhost:${PORT}`));
}

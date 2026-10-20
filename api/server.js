const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
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
    'Access-Control-Allow-Origin': '*'
  });
  res.end(s);
}

function readJSONBody(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 20000){ reject(new HttpError(413, 'request too large')); req.destroy(); }
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
    ? { zwid: String(session.zwid), name: String(session.name) } : null;
}

// Who a sign-up / withdrawal / RSVP is for. A signed-in member always acts as themselves.
// Staff and (until REQUIRE_MEMBER_LOGIN=1) guests name the rider in the request.
function identify(req, body){
  const member = memberFromRequest(req);
  if (member) return member;
  if (!roleFromRequest(req) && process.env.REQUIRE_MEMBER_LOGIN === '1'){
    throw new HttpError(401, 'Please sign in with your cryogen.team account.');
  }
  return {
    name: text(body.name, 'name', 60),
    zwid: /^\d{1,12}$/.test(String(body.zwid || '')) ? String(body.zwid) : '',
  };
}

function requireRole(req, roles){
  const role = roleFromRequest(req);
  if (!role) throw new HttpError(401, 'Please log in again.');
  if (!roles.includes(role)) throw new HttpError(403, 'Not allowed for your role.');
  return role;
}

async function handleLogin(req, res){
  const payload = await readJSONBody(req);
  const envName = ROLE_PASSWORD_ENV[payload.role];
  if (!envName) throw new HttpError(400, 'unknown role');
  const expected = process.env[envName];
  if (!expected) return sendJSON(res, 503, { error: 'login not configured', missing: envName });
  if (typeof payload.password === 'string' && passwordMatches(payload.password, expected)){
    return sendJSON(res, 200, { role: payload.role, token: signToken(payload.role) });
  }
  sendJSON(res, 401, { error: 'incorrect password' });
}

// ── Redis (Upstash REST API, as added through the Vercel Marketplace) ──
function redisConfig(){
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ''), token } : null;
}

async function redis(commands){
  const cfg = redisConfig();
  if (!cfg) throw new HttpError(503, 'Shared storage is not set up yet.');
  const r = await fetch(`${cfg.base}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'The date must be YYYY-MM-DD.');
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
// Posts via channel webhooks: DISCORD_WEBHOOK_PUBLIC (club channel) and DISCORD_WEBHOOK_ADMIN
// (private admin channel). A missing webhook just means that message isn't sent.
const discordEscape = t => String(t == null ? '' : t).replace(/([\\*_~`|>\[\]])/g, '\\$1');

async function discord(channel, payload){
  const hook = channel === 'admin' ? process.env.DISCORD_WEBHOOK_ADMIN : process.env.DISCORD_WEBHOOK_PUBLIC;
  if (!hook) return false;
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Never let rider-entered text ping @everyone, roles or users.
      body: JSON.stringify({ username: 'CRYO-GEN TTT', allowed_mentions: { parse: [] }, ...payload }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) console.error(`Discord ${channel} webhook returned ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error(`Discord ${channel} webhook failed: ${e.message}`);
    return false;
  }
}

const teamLabel = t => [t.level, t.zone].filter(Boolean).join(' · ');

function postSignupsOpen(week){
  const close = week.closesAt ? `\nSign-ups close **${ukLabel(Date.parse(week.closesAt))}**.` : '';
  return discord('public', {
    content: `📣 **TTT sign-ups are open — ${discordEscape(week.title)}**\nSign up at ${SITE_URL} → 🏁 TTT Week.${close}`,
    embeds: [{ title: 'Teams this week', color: 0x00d4ff,
      description: week.teams.map(t => `**${discordEscape(t.name)}** — ${discordEscape(teamLabel(t))} (max ${t.max})`).join('\n').slice(0, 4000) }],
  });
}

function postReminder(week, signups){
  const n = signups.filter(s => s.available).length;
  return discord('public', {
    content: `⏰ **Last day to sign up for ${discordEscape(week.title)}** — ${n} rider${n === 1 ? '' : 's'} signed up so far.\nSign-ups close **${ukLabel(Date.parse(week.closesAt))}**: ${SITE_URL}`,
  });
}

function postClosed(week, signups, assign){
  const avail = signups.filter(s => s.available);
  const unplaced = avail.filter(s => !(assign[s.name.toLowerCase()] || []).length).length;
  return Promise.all([
    discord('public', { content: `🔒 Sign-ups for **${discordEscape(week.title)}** are closed — ${avail.length} rider${avail.length === 1 ? '' : 's'}. Line-ups coming soon.` }),
    discord('admin', { content: `🛠️ **${discordEscape(week.title)}**: sign-ups closed — ${avail.length} available, ${unplaced} not yet in a team.\nBuild and publish the teams: ${SITE_URL} → 🏁 TTT Week` }),
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

  'POST /api/ttt/results': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const weekId = String(body.weekId || '');
    const current = await loadTtt();
    if (current.week && current.week.id === weekId){
      await weekWith({ results: parseResults(body.results, current.week.teams) });
      return;
    }
    // Results usually arrive after the Thursday rollover, so archived weeks can be updated too.
    const [snap] = await redis([['HGET', TTT_KEYS.archive, weekId]]);
    if (!snap) throw new HttpError(404, 'That week was not found.');
    const data = JSON.parse(snap);
    data.week = { ...data.week, results: parseResults(body.results, data.week.teams) };
    await redis([['HSET', TTT_KEYS.archive, weekId, JSON.stringify(data)]]);
    return tttView({ ...data, archive: current.archive }, roleFromRequest(req));
  },

  'GET /api/ttt/archive': async (req) => {
    const id = String(url.parse(req.url, true).query.id || '');
    const [snap] = await redis([['HGET', TTT_KEYS.archive, id]]);
    if (!snap) throw new HttpError(404, 'That week is not in the archive.');
    const data = JSON.parse(snap);
    return tttView({ ...data, archive: [] }, roleFromRequest(req));
  },

  'POST /api/ttt/signup': async (req, body) => {
    const { week } = await requireWeek();
    if (!week.open) throw new HttpError(409, 'TTT sign-ups are closed for this week.');
    const { name, zwid } = identify(req, body);
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
    const data = await loadTtt();
    const key = name.toLowerCase();
    const existing = data.signups.find(s => s.name.toLowerCase() === key);
    if (existing) entry.ts = existing.ts;
    await redis([['HSET', TTT_KEYS.signups, key, JSON.stringify(entry)]]);
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

  'POST /api/ttt/withdraw': async (req, body) => {
    const key = identify(req, body).name.toLowerCase();
    const data = await loadTtt();
    const rider = data.signups.find(s => s.name.toLowerCase() === key);
    await redis([['HDEL', TTT_KEYS.signups, key]]);
    // Free their place(s); once line-ups are out, the waitlist moves up automatically.
    if (data.week && rider){
      await freePlaces({ ...data, signups: data.signups.filter(s => s.name.toLowerCase() !== key) }, key, rider.name, 'withdrew from');
    } else {
      await redis([['HDEL', TTT_KEYS.assign, key]]);
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

  'POST /api/ttt/auto-assign': async (req) => {
    requireRole(req, ['admin', 'mod']);
    const data = await requireWeek();
    const velo = await riderVelos(data.signups);
    const { placements, summary } = planTeams({ teams: data.week.teams, signups: data.signups, assign: data.assign, velo });
    const commands = Object.entries(placements).map(([key, ids]) => ['HSET', TTT_KEYS.assign, key, JSON.stringify(ids)]);
    // Give every team without a captain its strongest volunteer.
    const assign = { ...data.assign, ...placements };
    const captains = captainsOf({ week: data.week, assign });
    summary.noCaptain = [];
    for (const t of data.week.teams){
      const inTeam = Object.values(assign).some(ids => ids.includes(t.id));
      if (!inTeam || captains[t.id]) continue;
      const pick = pickCaptain(t.id, data.signups, assign, velo);
      if (pick) captains[t.id] = pick; else summary.noCaptain.push(t.name);
    }
    commands.push(['SET', TTT_KEYS.week, JSON.stringify({ ...data.week, captains })]);
    await redis(commands);
    return { ...tttView(await loadTtt(), roleFromRequest(req)), summary };
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'The date must be YYYY-MM-DD.');
    await startWeek(date, text(body.title, 'title', 80, false) || weekTitle(date));
  },
};

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
  const done = [];
  for (const event of due){
    const [claimed] = await redis([['HSETNX', TTT_KEYS.sent, `${week.id}:${event}`, new Date(now).toISOString()]]);
    if (!claimed) continue;
    if (event === 'reminder') await postReminder(week, data.signups);
    if (event === 'close'){
      if (week.open) await redis([['SET', TTT_KEYS.week, JSON.stringify({ ...week, open: false })]]);
      await postClosed(week, data.signups, data.assign);
    }
    if (event === 'next-week'){
      const date = addDays(week.date, 7);
      await startWeek(date, weekTitle(date));
    }
    done.push(event);
  }
  return done;
}

async function handleCron(req, res){
  const secret = process.env.CRON_SECRET;
  if (!secret) return sendJSON(res, 503, { error: 'CRON_SECRET is not set' });
  const given = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1] || '';
  if (!passwordMatches(given, secret)) return sendJSON(res, 401, { error: 'unauthorized' });
  sendJSON(res, 200, { ran: await runTttSchedule() });
}

async function handleTtt(tttRoute, req, res){
  if (req.method === 'GET') await runTttSchedule().catch(e => console.error('TTT schedule:', e.message));
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await tttRoute(req, body);
  sendJSON(res, 200, result || tttView(await loadTtt(), roleFromRequest(req)));
}

async function handleData(dataRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await dataRoute(req, body);
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
    power: pick(r.power, ['wkg5', 'wkg15', 'wkg30', 'wkg60', 'wkg120', 'wkg300', 'wkg1200']),
    race: {
      ...pick(race, ['finishes', 'dnfs', 'wins', 'podiums']),
      current: race.current ? { rating: race.current.rating, mixed: race.current.mixed ? { category: race.current.mixed.category } : undefined } : undefined,
    },
    phenotype: r.phenotype ? { value: r.phenotype.value, scores: r.phenotype.scores } : undefined,
    handicaps: r.handicaps && r.handicaps.profile ? { profile: r.handicaps.profile } : undefined,
  };
}

async function fetchRoster(){
  if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache;
  const auth = process.env.WP_API_USER && process.env.WP_API_APP_PASSWORD
    ? `${process.env.WP_API_USER}:${process.env.WP_API_APP_PASSWORD}` : null;
  const [club, members] = await Promise.allSettled([
    wpGet(`/zwift/public/clubs/${encodeURIComponent(ZWIFT_CLUB_ID)}/0`),
    auth ? wpGet('/members', auth) : Promise.reject(new Error('not configured')),
  ]);
  if (club.status === 'rejected') throw club.reason;
  rosterCache = {
    at: Date.now(),
    riders: Array.isArray(club.value.riders) ? club.value.riders.map(slimRider) : [],
    members: members.status === 'fulfilled' && Array.isArray(members.value) ? members.value : null,
    membersError: members.status === 'rejected' ? members.reason.message : null,
  };
  return rosterCache;
}

// WordPress can hold several records for one Zwift ID (test entries, re-registrations).
// Everything here uses the last one, so what the page shows is what a save changes.
function uniqueMembers(list){
  const byId = new Map();
  for (const m of Array.isArray(list) ? list : []){
    if (/^\d+$/.test(String(m.zwift_id))) byId.set(String(m.zwift_id), m);
  }
  return [...byId.values()];
}

async function handleRoster(req, res){
  const { riders, members: allMembers, membersError } = await fetchRoster();
  const members = allMembers && uniqueMembers(allMembers);
  const staff = ['admin', 'mod'].includes(roleFromRequest(req));
  // Everyone sees name/status/tier; off-boarding progress is staff-only.
  const memberView = members && members.map(m => ({
    zwift_id: m.zwift_id, name: m.name, status: m.status, tier: m.tier,
    ...(staff ? { offboard_discord: m.offboard_discord, offboard_fb: m.offboard_fb, offboard_zp: m.offboard_zp } : {}),
  }));
  sendJSON(res, 200, { riders, members: memberView, membersError: staff ? membersError : undefined });
}

// Staff edits to a member record, saved to WordPress with the server's credentials.
const MEMBER_FIELDS = {
  tier: ['full', 'half'],
  status: ['active', 'suspended', 'left'],
  offboard_discord: ['0', '1'],
  offboard_fb: ['0', '1'],
  offboard_zp: ['0', '1'],
};
const MEMBER_VIEW_KEYS = ['zwift_id', 'name', 'status', 'tier', 'offboard_discord', 'offboard_fb', 'offboard_zp'];

async function handleMemberUpdate(req, res, zwiftId){
  requireRole(req, ['admin', 'mod']);
  const body = await readJSONBody(req);
  const changes = {};
  for (const [k, allowed] of Object.entries(MEMBER_FIELDS)){
    if (body[k] === undefined) continue;
    if (!allowed.includes(String(body[k]))) throw new HttpError(400, `invalid ${k}`);
    changes[k] = String(body[k]);
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'nothing to change');
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
    const { riders, members } = await fetchRoster();
    const record = members && uniqueMembers(members).find(m => String(m.zwift_id) === t.zwid);
    if (record && record.status === 'left') throw new HttpError(403, 'Your membership is no longer active.');
    const rider = riders.find(r => String(r.riderId) === t.zwid);
    const name = (rider && rider.name) || t.name;
    if (!name) throw new HttpError(403, 'Your Zwift ID is not in the club roster yet. Ask a moderator.');
    ssoRedirect(res, `sso=${signToken('member', { zwid: t.zwid, name })}`);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    ssoRedirect(res, `sso_error=${encodeURIComponent(e.message)}`);
  }
}

async function handleMe(req, res){
  const member = memberFromRequest(req);
  if (!member) return sendJSON(res, 401, { error: 'Not signed in as a member.' });
  const { members } = await fetchRoster();
  const record = members && uniqueMembers(members).find(m => String(m.zwift_id) === member.zwid);
  sendJSON(res, 200, { zwid: member.zwid, name: member.name, tier: record && record.tier, status: record && record.status });
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

async function fetchTab(tab){
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const r = await fetch(sheetUrl, { headers: { 'User-Agent': 'cryogen-proxy/2.0' } });
  const body = await r.text();
  if (!r.ok) throw new HttpError(502, `Google Sheets returned ${r.status} for tab "${tab}".`);
  if (/^\s*</.test(body)) throw new HttpError(502, 'The Google Sheet is not shared publicly ("Anyone with the link can view").');
  return body;
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serveStatic(res, reqPath){
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath === '/' ? '/index.html' : reqPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()){
    return sendJSON(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── Router ─────────────────────────────────────────────────
async function route(req, res){
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/roster' && req.method === 'GET') return handleRoster(req, res);
  if (pathname === '/api/auth/status' && req.method === 'GET'){
    return sendJSON(res, 200, { sso: Boolean(process.env.WP_SSO_SECRET), url: WP_SSO_LOGIN_URL, requireLogin: process.env.REQUIRE_MEMBER_LOGIN === '1' });
  }
  if (pathname === '/api/auth/wp' && req.method === 'GET') return handleWpSso(req, res, parsed.query.t);
  if (pathname === '/api/me' && req.method === 'GET') return handleMe(req, res);
  const memberMatch = /^\/api\/members\/(\d+)$/.exec(pathname);
  if (memberMatch && req.method === 'POST') return handleMemberUpdate(req, res, memberMatch[1]);
  if (pathname === '/api/cron/tick' && (req.method === 'POST' || req.method === 'GET')) return handleCron(req, res);

  const dataRoute = DATA_ROUTES[`${req.method} ${pathname}`];
  if (dataRoute) return handleData(dataRoute, req, res);

  const tttRoute = TTT_ROUTES[`${req.method} ${pathname}`];
  if (tttRoute) return handleTtt(tttRoute, req, res);

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

function handler(req, res){
  route(req, res).catch(err => {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.end();
    sendJSON(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  });
}

// Vercel calls the exported handler; `npm start` runs a local server.
module.exports = handler;

if (require.main === module){
  http.createServer(handler).listen(PORT, () => console.log(`cryogen-proxy server listening on http://localhost:${PORT}`));
}

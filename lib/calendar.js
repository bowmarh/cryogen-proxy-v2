'use strict';
// A private calendar feed for each rider: their next four weeks from "My week" (TTT, ZRL, rides, ride cover, Ladder, DIRT Series) as an
// iCalendar (.ics) subscription for Google, Apple or Outlook calendar. The link holds a random secret instead of a login, so it is shown
// only to the rider and can be reset or switched off at any time. Nothing is stored but the secret and who it belongs to.
const crypto = require('crypto');

module.exports = function createCalendar({ redis, HttpError, memberFromRequest, signMember, myweek, siteUrl }) {
  const KEYS = { tokens: 'cg:cal:tokens', owners: 'cg:cal:owners' };   // zwid -> record, secret -> zwid
  const WINDOW_DAYS = 28;
  const RACE_HOURS = { ZRL: 1.5, Ladder: 1, 'DIRT Series': 1.5, TTT: 1.5, Ride: 2, 'Ride cover': 2 };

  const feedUrl = secret => `${siteUrl}/api/cal/${secret}.ics`;
  const newSecret = () => crypto.randomBytes(24).toString('base64url');

  async function recordOf(zwid) {
    const [raw] = await redis([['HGET', KEYS.tokens, zwid]]);
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  async function issue(member, reset) {
    const old = await recordOf(member.zwid);
    if (old && !reset) return old;
    const rec = { secret: newSecret(), name: member.name, assoc: member.assoc === true, at: new Date().toISOString() };
    const cmds = [['HSET', KEYS.tokens, member.zwid, JSON.stringify(rec)], ['HSET', KEYS.owners, rec.secret, member.zwid]];
    if (old) cmds.push(['HDEL', KEYS.owners, old.secret]);
    await redis(cmds);
    return rec;
  }

  async function remove(zwid) {
    const old = await recordOf(zwid);
    if (!old) return false;
    await redis([['HDEL', KEYS.tokens, zwid], ['HDEL', KEYS.owners, old.secret]]);
    return true;
  }

  const need = req => {
    const member = memberFromRequest(req);
    if (!member) throw new HttpError(401, 'Sign in with your cryogen.team account.');
    return member;
  };

  // iCalendar text rules: escape \ ; , and newlines, and fold lines longer than 75 bytes.
  const esc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  function fold(line) {
    const out = [];
    let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateOnly = d => String(d).replace(/-/g, '');

  function toIcs(zwid, name, items, now) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CRYO-GEN//Club dashboard//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc('CRYO-GEN: ' + name)}`, 'X-WR-CALDESC:Your races and rides from the CRYO-GEN club dashboard', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
    for (const it of items) {
      const uid = crypto.createHash('sha1').update(`${zwid}|${it.kind}|${it.title}|${it.date}`).digest('hex').slice(0, 24);
      const todo = it.state === 'todo';
      const hours = RACE_HOURS[it.kind] || 1.5;
      lines.push('BEGIN:VEVENT', `UID:${uid}@club.cryo-gen.team`, `DTSTAMP:${stamp(now)}`);
      if (it.timed) lines.push(`DTSTART:${stamp(it.atMs)}`, `DTEND:${stamp(it.atMs + hours * 3600000)}`);
      else {
        lines.push(`DTSTART;VALUE=DATE:${dateOnly(it.date)}`);
        lines.push(`DTEND;VALUE=DATE:${dateOnly(new Date(Date.parse(`${it.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10))}`);
      }
      lines.push(`SUMMARY:${esc(`${todo ? '❓ ' : ''}${it.kind}: ${it.title}`)}`);
      lines.push(`DESCRIPTION:${esc(`${it.note}${todo ? ' (needs your answer)' : ''}\n${siteUrl}`)}`, `URL:${siteUrl}`, 'STATUS:' + (todo ? 'TENTATIVE' : 'CONFIRMED'), 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  // The public feed: no login, the secret in the address is the key. Unknown secrets are a plain 404.
  async function feed(secret, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(secret || '')) throw new HttpError(404, 'Not found');
    const [zwid] = await redis([['HGET', KEYS.owners, secret]]);
    const rec = zwid ? await recordOf(zwid) : null;
    if (!rec || rec.secret !== secret) throw new HttpError(404, 'Not found');
    const req = { headers: { authorization: `Bearer ${signMember({ zwid, name: rec.name, assoc: rec.assoc })}` } };
    const week = await myweek.build(req, now, WINDOW_DAYS);
    const items = week.items.filter(i => i.state === 'in' || i.state === 'todo');
    return toIcs(zwid, rec.name, items, now);
  }

  const routes = {
    'GET /api/me/calendar': async req => {
      const member = need(req);
      const rec = await recordOf(member.zwid);
      return { on: Boolean(rec), url: rec ? feedUrl(rec.secret) : null, windowDays: WINDOW_DAYS };
    },
    'POST /api/me/calendar': async (req, body) => {
      const member = need(req);
      const rec = await issue(member, body && body.reset === true);
      return { on: true, url: feedUrl(rec.secret), windowDays: WINDOW_DAYS };
    },
    'POST /api/me/calendar/remove': async req => ({ on: false, removed: await remove(need(req).zwid) }),
  };

  return { routes, feed, KEYS, toIcs, recordOf };
};

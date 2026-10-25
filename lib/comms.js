'use strict';
// Staff messages to Discord: to everyone (one post in the club channel) or to chosen members. A member is reached by a direct message when the
// server has a Discord bot (DISCORD_BOT_TOKEN); without one, the message goes to the club channel with an @mention of just that member. Either way
// the member needs their Discord user ID saved here (staff add it; Discord's "Copy User ID" in developer mode gives it). The mentions are exactly
// the ones staff chose: nothing a rider typed can ping anyone, and @everyone is for admins only. Every send is recorded in a short log.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createComms({ redis, HttpError, text, requireRole, roleFromRequest, discord, namesFor, fetchImpl = (...a) => fetch(...a) }) {
  const KEYS = {
    links: 'cg:comms:discord',   // zwid -> {id, at}: the member's Discord user ID
    log: 'cg:comms:log',         // list, newest first: what was sent, to whom, by which role
  };
  const MAX_TEXT = 1800, MAX_MEMBERS = 50, LOG_KEEP = 100, PER_MINUTE = 10;
  const API = 'https://discord.com/api/v10';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const idOk = v => /^\d{15,25}$/.test(String(v || ''));
  const bot = () => process.env.DISCORD_BOT_TOKEN || '';
  const channelSet = () => ['DISCORD_WEBHOOK_COMMS', 'DISCORD_WEBHOOK_PUBLIC'].some(k => process.env[k]);
  const SIGN = '\n— CRYO-GEN staff';

  async function loadLinks() {
    const [raw] = await redis([['HGETALL', KEYS.links]]);
    return Object.fromEntries(pairs(raw).map(([z, v]) => [z, parse(v)]).filter(([, v]) => v && v.id));
  }

  // A true direct message through the bot: open the DM channel, then post in it. Members with DMs closed to the server answer 403.
  async function dm(userId, content) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${bot()}`, 'User-Agent': 'cryogen-proxy/2.0' };
    const ch = await fetchImpl(`${API}/users/@me/channels`, { method: 'POST', headers, body: JSON.stringify({ recipient_id: userId }), signal: AbortSignal.timeout(4000) });
    if (!ch.ok) return { ok: false, error: ch.status === 403 || ch.status === 400 ? 'Discord would not open a DM with this member' : `Discord answered ${ch.status}` };
    const { id } = await ch.json();
    const msg = await fetchImpl(`${API}/channels/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(4000) });
    if (msg.ok) return { ok: true };
    return { ok: false, error: msg.status === 403 ? 'This member has direct messages closed to the server' : `Discord answered ${msg.status}` };
  }

  async function recordLog(entry) {
    await redis([['LPUSH', KEYS.log, JSON.stringify(entry)], ['LTRIM', KEYS.log, 0, LOG_KEEP - 1]]);
  }

  const routes = {
    // What staff need on the page: whether DMs and the channel are set up, who has a Discord ID saved, and what was sent lately.
    'GET /api/comms': async req => {
      requireRole(req, ['admin', 'mod']);
      const [links, [logRaw]] = [await loadLinks(), await redis([['LRANGE', KEYS.log, 0, 29]])];
      return { dm: !!bot(), channel: channelSet(), canPingEveryone: roleFromRequest(req) === 'admin', links: Object.fromEntries(Object.entries(links).map(([z, v]) => [z, v.id])),
        log: (logRaw || []).map(parse).filter(Boolean), limits: { text: MAX_TEXT, members: MAX_MEMBERS } };
    },

    // Staff: save (or clear, with an empty id) a member's Discord user ID.
    'POST /api/comms/link': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed (numbers only).');
      const id = String(body.discordId || '').trim();
      if (!id) { await redis([['HDEL', KEYS.links, zwid]]); return { zwid, discordId: '' }; }
      if (!idOk(id)) throw new HttpError(400, 'A Discord user ID is 17 to 19 digits. In Discord turn on Developer Mode, then right-click the member and choose Copy User ID.');
      await redis([['HSET', KEYS.links, zwid, JSON.stringify({ id, at: new Date().toISOString() })]]);
      return { zwid, discordId: id };
    },

    // Staff: send. `audience` is "all" (one post in the club channel) or "members" (the Zwift IDs in `zwids`).
    'POST /api/comms/send': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const role = roleFromRequest(req);
      const message = text(body.message, 'message', MAX_TEXT, true);
      const audience = body.audience === 'all' ? 'all' : 'members';
      // A short limit on sends, so a slip of the finger does not flood the channel or members' DMs.
      const minute = Math.floor(Date.now() / 60000), rateKey = `cg:comms:rate:${minute}`;
      const [count] = await redis([['INCR', rateKey], ['EXPIRE', rateKey, 120]]);
      if (count > PER_MINUTE) throw new HttpError(429, 'That is a lot of messages in a minute. Wait a moment and try again.');
      const content = `${message}${SIGN}`.slice(0, 1990);
      if (audience === 'all') {
        if (!channelSet()) throw new HttpError(503, 'No Discord channel is set up for the club (DISCORD_WEBHOOK_PUBLIC).');
        const ping = body.pingEveryone === true;
        if (ping && role !== 'admin') throw new HttpError(403, 'Only an administrator can notify everyone.');
        const ok = await discord('comms', { content: `${ping ? '@everyone ' : ''}${content}`, allowed_mentions: ping ? { parse: ['everyone'] } : { parse: [] } });
        if (!ok) throw new HttpError(502, 'Discord did not take the message. Nothing was sent.');
        await recordLog({ at: new Date().toISOString(), by: role, audience: 'all', count: null, ok: 1, failed: 0, text: message.slice(0, 140), ping });
        return { audience: 'all', sent: true };
      }
      const zwids = [...new Set((Array.isArray(body.zwids) ? body.zwids : []).map(String))];
      if (!zwids.length) throw new HttpError(400, 'Pick at least one member.');
      if (zwids.length > MAX_MEMBERS) throw new HttpError(400, `Message at most ${MAX_MEMBERS} members at a time. For everyone, use the club channel.`);
      if (!zwids.every(z => /^\d{1,12}$/.test(z))) throw new HttpError(400, 'Zwift IDs are numbers only.');
      const [links, names] = await Promise.all([loadLinks(), namesFor(zwids)]);
      const results = [], mentions = [];
      const todo = zwids.map(z => ({ zwid: z, name: names[z] || z, id: links[z] && links[z].id }));
      for (const m of todo) if (!m.id) results.push({ zwid: m.zwid, name: m.name, ok: false, error: 'No Discord ID saved for this member' });
      const reachable = todo.filter(m => m.id);
      if (bot()) {
        const started = Date.now();
        for (let i = 0; i < reachable.length; i += 5) {
          if (Date.now() - started > 7000) { for (const m of reachable.slice(i)) results.push({ zwid: m.zwid, name: m.name, ok: false, error: 'Not attempted (out of time): send to these again' }); break; }
          await Promise.all(reachable.slice(i, i + 5).map(async m => {
            try { const r = await dm(m.id, content); results.push({ zwid: m.zwid, name: m.name, ok: r.ok, via: 'dm', ...(r.error ? { error: r.error } : {}) }); }
            catch (e) { results.push({ zwid: m.zwid, name: m.name, ok: false, via: 'dm', error: 'Could not reach Discord' }); }
          }));
        }
      } else if (reachable.length) {
        // No bot: one post in the channel that mentions exactly these members (and nobody else).
        if (!channelSet()) throw new HttpError(503, 'Direct messages need DISCORD_BOT_TOKEN, and there is no club channel to mention members in (DISCORD_WEBHOOK_PUBLIC).');
        const ok = await discord('comms', { content: `${reachable.map(m => `<@${m.id}>`).join(' ')} ${content}`.slice(0, 1990), allowed_mentions: { users: reachable.map(m => m.id) } });
        for (const m of reachable) results.push({ zwid: m.zwid, name: m.name, ok, via: 'mention', ...(ok ? {} : { error: 'Discord did not take the message' }) });
        mentions.push(...reachable);
      }
      const order = new Map(zwids.map((z, i) => [z, i]));
      results.sort((a, b) => order.get(a.zwid) - order.get(b.zwid));
      const sent = results.filter(r => r.ok).length;
      await recordLog({ at: new Date().toISOString(), by: role, audience: 'members', count: zwids.length, ok: sent, failed: results.length - sent, via: bot() ? 'dm' : 'mention', names: results.slice(0, 6).map(r => r.name), text: message.slice(0, 140) });
      return { audience: 'members', via: bot() ? 'dm' : 'mention', sent, failed: results.length - sent, results };
    },
  };

  return { routes, KEYS };
};

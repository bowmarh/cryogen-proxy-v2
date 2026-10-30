'use strict';
// Staff messages to Discord: to everyone (one post in the club channel) or to chosen members. A member is reached by a direct message when the
// server has a Discord bot (DISCORD_BOT_TOKEN); without one, the message goes to the club channel with an @mention of just that member. Either way
// the member needs their Discord user ID saved here (staff add it; Discord's "Copy User ID" in developer mode gives it). The mentions are exactly
// the ones staff chose: nothing a rider typed can ping anyone, and @everyone is for admins only. Every send is recorded in a short log.
// Riders can save their own Discord ID from their profile. With the bot on, it is verified by a code sent to that Discord account, and a rider can switch
// the club's direct messages off or pick which kinds they want (race reminders, social rides, club news). With a Discord app set up they can instead
// sign in with Discord, which proves the account without a code. An optional automatic reminder DMs riders who have not answered for a race that is
// about to start. Messages can carry {name} and other per-member values, so a reminder reads as written to one person.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createComms({ redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, namesFor, candidates = async () => [], siteUrl = '', signState, readState, nudges = async () => [], templates = async () => [], fetchImpl = (...a) => fetch(...a) }) {
  const KEYS = {
    links: 'cg:comms:discord',   // zwid -> {id, at, by: 'staff'|'self', verified, dm}: the member's Discord user ID (dm false: no direct messages)
    settings: 'cg:comms:settings', // JSON {autoNudge}: the optional automatic reminder, off until an administrator turns it on
    sent: 'cg:comms:sent',       // "<reminder key>" -> ISO time, so each automatic reminder goes once
    verify: 'cg:comms:verify',   // zwid -> {code, id, at, tries}: a code sent to the Discord account a rider entered
    log: 'cg:comms:log',         // list, newest first: what was sent, to whom, by which role
  };
  const MAX_TEXT = 1800, MAX_MEMBERS = 50, LOG_KEEP = 100, PER_MINUTE = 10, MAX_PERSONAL_POSTS = 15, CODE_MS = 15 * 60000;
  const API = 'https://discord.com/api/v10';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const idOk = v => /^\d{15,25}$/.test(String(v || ''));
  const bot = () => process.env.DISCORD_BOT_TOKEN || '';
  const channelSet = () => ['DISCORD_WEBHOOK_COMMS', 'DISCORD_WEBHOOK_PUBLIC'].some(k => process.env[k]);
  const SIGN = '\n— CRYO-GEN staff';
  const KINDS = { race: 'race reminders', rides: 'social ride messages', club: 'club news' };   // what a rider can switch off
  const oauth = () => ({ id: process.env.DISCORD_CLIENT_ID || '', secret: process.env.DISCORD_CLIENT_SECRET || '', redirect: `${siteUrl.replace(/\/$/, '')}/api/discord/callback` });
  const oauthOn = () => { const o = oauth(); return !!(o.id && o.secret && siteUrl); };

  async function loadLinks() {
    const [raw] = await redis([['HGETALL', KEYS.links]]);
    return Object.fromEntries(pairs(raw).map(([z, v]) => [z, parse(v)]).filter(([, v]) => v && v.id)
      .map(([z, v]) => [z, { id: v.id, by: v.by || 'staff', verified: v.verified !== false, dm: v.dm !== false, at: v.at, tag: v.tag || '', prefs: { race: !(v.prefs && v.prefs.race === false), rides: !(v.prefs && v.prefs.rides === false), club: !(v.prefs && v.prefs.club === false) } }]));
  }
  // Whether staff can use a saved ID: a rider's own entry must be verified, unless there is no bot to verify it with.
  const usable = l => !!l && (l.verified || !bot());
  const skipReason = (l, kind) => !l ? 'No Discord ID saved for this member' : l.dm === false ? 'Opted out of messages from the club' : !usable(l) ? 'Their Discord ID is not verified yet' : kind && l.prefs[kind] === false ? `Turned off ${KINDS[kind]}` : '';
  // Save a member's link, keeping what is already there (the preferences, the name Discord gave) unless this changes it.
  async function saveLink(zwid, patch) {
    const old = (await loadLinks())[zwid] || {};
    const rec = { id: old.id, by: old.by || 'staff', verified: old.verified !== false, dm: old.dm !== false, tag: old.tag || '', prefs: old.prefs || { race: true, rides: true, club: true }, ...patch, at: new Date().toISOString() };
    await redis([['HSET', KEYS.links, zwid, JSON.stringify(rec)]]);
    return rec;
  }
  const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';
  // {name} and any other {key} in a message become that member's own values; anything unknown is removed.
  const fill = (msg, name, vars) => msg.replace(/\{(\w+)\}/g, (_, k) => (k === 'name' ? firstName(name) : String((vars && vars[k]) || '')));
  const personal = msg => /\{\w+\}/.test(msg);

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

  // ── Import Discord IDs in bulk: from the server's member list (through the bot) or from a file ──
  // Discord names rarely equal Zwift names, so each member is paired with a rider by name and staff confirm before anything is saved.
  const norm = v => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/cryo[\s-]*gen/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  // 100: the same words. 90: same first and last word. 70: same first word and the initial of the last. 0: no match.
  function nameScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 100;
    const x = a.split(' '), y = b.split(' ');
    if (x.length < 2 || y.length < 2) return 0;
    if (x[0] === y[0] && x[x.length - 1] === y[y.length - 1]) return 90;
    if (x[0] === y[0] && x[x.length - 1][0] === y[y.length - 1][0] && (x[x.length - 1].length === 1 || y[y.length - 1].length === 1)) return 70;
    return 0;
  }
  async function guildMembers() {
    const guild = process.env.DISCORD_GUILD_ID || '';
    if (!bot()) throw new HttpError(409, 'The Discord bot is not set up (DISCORD_BOT_TOKEN).');
    if (!/^\d{15,25}$/.test(guild)) throw new HttpError(409, 'Add your Discord server\'s ID as DISCORD_GUILD_ID in Vercel (in Discord: right-click the server, Copy Server ID).');
    const out = [];
    let after = '0';
    for (let page = 0; page < 4; page++) {   // 4000 members at most, inside the function's time limit
      const r = await fetchImpl(`${API}/guilds/${guild}/members?limit=1000&after=${after}`, { headers: { Authorization: `Bot ${bot()}`, 'User-Agent': 'cryogen-proxy/2.0' }, signal: AbortSignal.timeout(3000) });
      if (r.status === 403) throw new HttpError(409, 'Discord refused the member list. In the Developer Portal open Bot and turn on Server Members Intent, and check the bot is in the server.');
      if (!r.ok) throw new HttpError(502, `Discord answered ${r.status}.`);
      const list = await r.json();
      for (const m of list) if (m.user && !m.user.bot) out.push({ id: String(m.user.id), username: m.user.username || '', name: m.nick || m.user.global_name || m.user.username || '', names: [m.nick, m.user.global_name, m.user.username].filter(Boolean) });
      if (list.length < 1000) break;
      after = String(list[list.length - 1].user.id);
    }
    return out;
  }
  async function matchMembers(members) {
    const [people, links] = await Promise.all([candidates(), loadLinks()]);
    const byId = new Map(Object.entries(links).map(([z, l]) => [l.id, z]));
    const index = people.map(p => ({ zwid: String(p.zwid), name: p.name, key: norm(p.name) })).filter(p => p.key);
    return members.map(m => {
      const names = [...new Set((m.names && m.names.length ? m.names : [m.name]).map(norm).filter(Boolean))];
      const best = new Map();
      for (const p of index) for (const n of names) { const sc = nameScore(n, p.key); if (sc && sc > ((best.get(p.zwid) || {}).score || 0)) best.set(p.zwid, { zwid: p.zwid, name: p.name, score: sc }); }
      const matches = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
      const exact = matches.length && matches[0].score >= 90 && (matches.length === 1 || matches[1].score < matches[0].score) ? matches[0] : null;
      return { discordId: m.id, discordName: m.name || m.username || m.id, alreadyLinkedTo: byId.get(m.id) || '', status: exact ? 'exact' : matches.length ? 'near' : 'none', matches, pick: exact ? exact.zwid : '' };
    });
  }

  const routes = {
    // What staff need on the page: whether DMs and the channel are set up, who has a Discord ID saved, and what was sent lately.
    'GET /api/comms': async req => {
      requireRole(req, ['admin', 'mod']);
      const [links, [logRaw]] = [await loadLinks(), await redis([['LRANGE', KEYS.log, 0, 29]])];
      return { auto: { nudge: (await getSettings()).autoNudge, canChange: roleFromRequest(req) === 'admin' }, oauth: oauthOn(), stats: { linked: Object.keys(links).length, verified: Object.values(links).filter(l => l.verified).length }, dm: !!bot(), channel: channelSet(), canPingEveryone: roleFromRequest(req) === 'admin', links: Object.fromEntries(Object.entries(links).map(([z, v]) => [z, { id: v.id, self: v.by !== 'staff', verified: v.verified, dm: v.dm, off: Object.keys(KINDS).filter(k => v.prefs[k] === false) }])),
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
      const old = (await loadLinks())[zwid];
      await saveLink(zwid, { id, by: 'staff', verified: true, tag: old && old.id === id ? old.tag : '' });
      return { zwid, discordId: id };
    },

    // Staff: the server's members, from the bot, each paired with the rider whose name matches (exact, near, or none) for staff to confirm.
    'GET /api/comms/discord-members': async req => {
      requireRole(req, ['admin', 'mod']);
      const members = await guildMembers();
      const rows = await matchMembers(members);
      return { total: members.length, rows, counts: { exact: rows.filter(r => r.status === 'exact').length, near: rows.filter(r => r.status === 'near').length, none: rows.filter(r => r.status === 'none').length, linked: rows.filter(r => r.alreadyLinkedTo).length } };
    },

    // Staff: the same pairing for a list read from a file: [{id, name}].
    'POST /api/comms/discord-match': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const list = (Array.isArray(body.members) ? body.members : []).slice(0, 5000).map(m => ({ id: String(m && m.id || '').trim(), name: String(m && m.name || '').slice(0, 80) })).filter(m => idOk(m.id));
      if (!list.length) throw new HttpError(400, 'No Discord user IDs (17 to 19 digits) were found in that file.');
      const rows = await matchMembers(list);
      return { total: list.length, rows, counts: { exact: rows.filter(r => r.status === 'exact').length, near: rows.filter(r => r.status === 'near').length, none: rows.filter(r => r.status === 'none').length, linked: rows.filter(r => r.alreadyLinkedTo).length } };
    },

    // Staff: save the pairings they confirmed, [{zwid, discordId, tag}]. A rider's own verified link is never replaced by an import.
    'POST /api/comms/import': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const list = Array.isArray(body.links) ? body.links.slice(0, 1000) : [];
      if (!list.length) throw new HttpError(400, 'Nothing to save.');
      const links = await loadLinks(), skipped = [], seen = new Set(), seenIds = new Set(), cmds = [], at = new Date().toISOString();
      let saved = 0;
      for (const l of list) {
        const zwid = String(l && l.zwid || ''), id = String(l && l.discordId || '').trim();
        if (!/^\d{1,12}$/.test(zwid) || !idOk(id)) { skipped.push({ zwid, reason: 'Not a valid Zwift ID and Discord ID' }); continue; }
        if (seen.has(zwid)) { skipped.push({ zwid, reason: 'Chosen twice' }); continue; }
        if (seenIds.has(id)) { skipped.push({ zwid, reason: 'That Discord member was chosen for another rider too' }); continue; }
        seen.add(zwid); seenIds.add(id);
        const old = links[zwid];
        if (old && old.id !== id && old.by !== 'staff') { skipped.push({ zwid, reason: 'Already linked by the rider themselves' }); continue; }
        const keep = old || {};
        cmds.push(['HSET', KEYS.links, zwid, JSON.stringify({ id, by: 'staff', verified: true, dm: keep.dm !== false, tag: String(l.tag || '').slice(0, 60), prefs: keep.prefs || { race: true, rides: true, club: true }, at })]);
        saved++;
      }
      for (let i = 0; i < cmds.length; i += 200) await redis(cmds.slice(i, i + 200));   // a few round trips, not one per link
      return { saved, skipped };
    },

    // Staff: send. `audience` is "all" (one post in the club channel) or "members" (the Zwift IDs in `zwids`).
    'POST /api/comms/send': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const role = roleFromRequest(req);
      const message = text(body.message, 'message', MAX_TEXT, true);
      const kind = KINDS[body.kind] ? body.kind : 'club';   // what sort of message it is, so a rider's choices are respected
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
        const ok = await discord('comms', { content: `${ping ? '@everyone ' : ''}${fill(message, '', {})}${SIGN}`.slice(0, 1990), allowed_mentions: ping ? { parse: ['everyone'] } : { parse: [] } });
        if (!ok) throw new HttpError(502, 'Discord did not take the message. Nothing was sent.');
        await recordLog({ at: new Date().toISOString(), by: role, audience: 'all', count: null, ok: 1, failed: 0, text: message.slice(0, 140), ping });
        return { audience: 'all', sent: true };
      }
      const zwids = [...new Set((Array.isArray(body.zwids) ? body.zwids : []).map(String))];
      if (!zwids.length) throw new HttpError(400, 'Pick at least one member.');
      if (zwids.length > MAX_MEMBERS) throw new HttpError(400, `Message at most ${MAX_MEMBERS} members at a time. For everyone, use the club channel.`);
      if (!zwids.every(z => /^\d{1,12}$/.test(z))) throw new HttpError(400, 'Zwift IDs are numbers only.');
      const vars = body.vars && typeof body.vars === 'object' ? body.vars : {};
      const [links, names] = await Promise.all([loadLinks(), namesFor(zwids)]);
      const results = [];
      const todo = zwids.map(z => ({ zwid: z, name: names[z] || z, link: links[z], vars: vars[z] }));
      const reachable = [];
      for (const m of todo) { const why = skipReason(m.link, kind); if (why) results.push({ zwid: m.zwid, name: m.name, ok: false, error: why }); else reachable.push(m); }
      const own = m => `${fill(message, m.name, m.vars)}${SIGN}`.slice(0, 1990);   // that member's own copy of the message
      if (bot()) {
        const started = Date.now();
        for (let i = 0; i < reachable.length; i += 5) {
          if (Date.now() - started > 7000) { for (const m of reachable.slice(i)) results.push({ zwid: m.zwid, name: m.name, ok: false, error: 'Not attempted (out of time): send to these again' }); break; }
          await Promise.all(reachable.slice(i, i + 5).map(async m => {
            try { const r = await dm(m.link.id, own(m)); results.push({ zwid: m.zwid, name: m.name, ok: r.ok, via: 'dm', ...(r.error ? { error: r.error } : {}) }); }
            catch (e) { results.push({ zwid: m.zwid, name: m.name, ok: false, via: 'dm', error: 'Could not reach Discord' }); }
          }));
        }
      } else if (reachable.length) {
        // No bot: the club channel, mentioning exactly these members (and nobody else). A message with {name} or other per-member values is posted once each.
        if (!channelSet()) throw new HttpError(503, 'Direct messages need DISCORD_BOT_TOKEN, and there is no club channel to mention members in (DISCORD_WEBHOOK_PUBLIC).');
        if (personal(message)) {
          if (reachable.length > MAX_PERSONAL_POSTS) throw new HttpError(400, `A personal message is one channel post each, so at most ${MAX_PERSONAL_POSTS} at a time without a bot. Pick fewer members, or take {name} out to mention them all in one post.`);
          for (const m of reachable) {
            const ok = await discord('comms', { content: `<@${m.link.id}> ${own(m)}`.slice(0, 1990), allowed_mentions: { users: [m.link.id] } });
            results.push({ zwid: m.zwid, name: m.name, ok, via: 'mention', ...(ok ? {} : { error: 'Discord did not take the message' }) });
            await new Promise(r => setTimeout(r, 250));
          }
        } else {
          const ok = await discord('comms', { content: `${reachable.map(m => `<@${m.link.id}>`).join(' ')} ${content}`.slice(0, 1990), allowed_mentions: { users: reachable.map(m => m.link.id) } });
          for (const m of reachable) results.push({ zwid: m.zwid, name: m.name, ok, via: 'mention', ...(ok ? {} : { error: 'Discord did not take the message' }) });
        }
      }
      const order = new Map(zwids.map((z, i) => [z, i]));
      results.sort((a, b) => order.get(a.zwid) - order.get(b.zwid));
      const sent = results.filter(r => r.ok).length;
      await recordLog({ at: new Date().toISOString(), by: role, audience: 'members', count: zwids.length, ok: sent, failed: results.length - sent, via: bot() ? 'dm' : 'mention', names: results.slice(0, 6).map(r => r.name), text: message.slice(0, 140), kind, template: body.template ? String(body.template).slice(0, 40) : undefined });
      return { audience: 'members', via: bot() ? 'dm' : 'mention', sent, failed: results.length - sent, results };
    },

    // Admin: turn the automatic reminder on or off.
    'POST /api/comms/auto': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.nudge === true && !bot()) throw new HttpError(409, 'Automatic reminders are direct messages, so they need DISCORD_BOT_TOKEN first.');
      await redis([['SET', KEYS.settings, JSON.stringify({ autoNudge: body.nudge === true })]]);
      return { autoNudge: body.nudge === true };
    },

    // Staff: ready-made reminders, each with the people it is for (worked out from the live data) and the words to send.
    'GET /api/comms/templates': async req => {
      requireRole(req, ['admin', 'mod']);
      const list = await templates(req);
      const ids = [...new Set(list.flatMap(t => (t.recipients || []).map(r => r.zwid)))];
      const names = ids.length ? await namesFor(ids) : {};
      return { templates: list.map(t => ({ ...t, recipients: (t.recipients || []).map(r => ({ ...r, name: names[r.zwid] || r.zwid })) })) };
    },

    // ── A rider's own Discord details (any signed-in member, associates included) ──
    'GET /api/me/discord': async req => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const l = (await loadLinks())[m.zwid];
      return { linked: !!l, id: l ? l.id : '', tag: l ? l.tag : '', verified: l ? l.verified : false, dm: l ? l.dm : true, prefs: l ? l.prefs : { race: true, rides: true, club: true }, kinds: KINDS, byStaff: !!l && l.by === 'staff', oauth: oauthOn(), canVerify: !!bot(), pending: !!(await redis([['HGET', KEYS.verify, m.zwid]]))[0] };
    },

    // Save the ID (and, with the bot, send a code to that Discord account to prove it is theirs).
    'POST /api/me/discord': async (req, body) => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const id = String(body.discordId || '').trim();
      if (!idOk(id)) throw new HttpError(400, 'A Discord user ID is 17 to 19 digits. In Discord turn on Developer Mode (Settings, Advanced), then right-click your name and choose Copy User ID.');
      const hour = Math.floor(Date.now() / 3600000), rateKey = `cg:comms:selfrate:${m.zwid}:${hour}`;
      const [count] = await redis([['INCR', rateKey], ['EXPIRE', rateKey, 7200]]);
      if (count > 6) throw new HttpError(429, 'That is a lot of tries. Please wait an hour and try again.');
      const old = (await loadLinks())[m.zwid];
      const keep = old && old.id === id ? old : null;   // saving the same ID again changes nothing
      if (!bot()) {
        await saveLink(m.zwid, { id, by: 'self', verified: false, tag: keep ? keep.tag : '' });
        return { saved: true, needsCode: false, verified: false };
      }
      if (keep && keep.verified) return { saved: true, needsCode: false, verified: true };
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const sent = await dm(id, `Your CRYO-GEN verification code is **${code}**. Enter it on the dashboard to link this Discord account. If you did not ask for it, ignore this message.`).catch(() => ({ ok: false, error: 'Could not reach Discord' }));
      if (!sent.ok) throw new HttpError(409, `${sent.error}. Check the ID, make sure you are in the CRYO-GEN Discord server, and that "Allow direct messages from server members" is on.`);
      await saveLink(m.zwid, { id, by: 'self', verified: false, tag: keep ? keep.tag : '' });
      await redis([['HSET', KEYS.verify, m.zwid, JSON.stringify({ code, id, at: Date.now(), tries: 0 })]]);
      return { saved: true, needsCode: true, verified: false };
    },

    'POST /api/me/discord/verify': async (req, body) => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const [raw] = await redis([['HGET', KEYS.verify, m.zwid]]);
      const v = parse(raw);
      if (!v || Date.now() - v.at > CODE_MS) throw new HttpError(400, 'That code has expired. Save your Discord ID again to get a new one.');
      if (v.tries >= 5) throw new HttpError(429, 'Too many wrong codes. Save your Discord ID again to get a new one.');
      if (String(body.code || '').trim() !== v.code) {
        await redis([['HSET', KEYS.verify, m.zwid, JSON.stringify({ ...v, tries: v.tries + 1 })]]);
        throw new HttpError(400, 'That code is not right.');
      }
      await saveLink(m.zwid, { id: v.id, by: 'self', verified: true });
      await redis([['HDEL', KEYS.verify, m.zwid]]);
      return { verified: true };
    },

    // Switch the club's direct messages on or off, and choose which kinds a rider wants.
    'POST /api/me/discord/prefs': async (req, body) => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const l = (await loadLinks())[m.zwid];
      if (!l) throw new HttpError(409, 'Save your Discord ID first.');
      const prefs = { ...l.prefs };
      for (const k of Object.keys(KINDS)) if (body.kinds && typeof body.kinds[k] === 'boolean') prefs[k] = body.kinds[k];
      const rec = await saveLink(m.zwid, { dm: body.dm === undefined ? l.dm : body.dm !== false, prefs });
      return { dm: rec.dm, prefs: rec.prefs };
    },

    // ── Sign in with Discord: proves the account without a code (needs DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET) ──
    'GET /api/me/discord/start': async req => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      if (!oauthOn()) throw new HttpError(409, 'Sign in with Discord is not set up for the club yet.');
      const o = oauth(), state = signState({ zwid: m.zwid, nonce: Math.random().toString(36).slice(2) + Date.now().toString(36) });
      return { url: `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: o.id, response_type: 'code', scope: 'identify', redirect_uri: o.redirect, state, prompt: 'consent' })}` };
    },

    'POST /api/me/discord/remove': async req => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      await redis([['HDEL', KEYS.links, m.zwid], ['HDEL', KEYS.verify, m.zwid]]);
      return { linked: false };
    },

    // A test message to themselves, to see that it works (bot only).
    'POST /api/me/discord/test': async req => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      if (!bot()) throw new HttpError(409, 'Direct messages are not switched on for the club yet.');
      const l = (await loadLinks())[m.zwid];
      if (!l || !l.verified) throw new HttpError(409, 'Verify your Discord ID first.');
      const r = await dm(l.id, `This is a test message from the CRYO-GEN dashboard. Messages from the club will arrive here.${SIGN}`);
      if (!r.ok) throw new HttpError(409, r.error);
      return { sent: true };
    },
  };

  // Discord sends the rider back here with a code. The state we signed says who started it; the code is traded for the Discord user they are.
  async function callback(query = {}) {
    if (!oauthOn()) return 'failed';
    if (query.error) return 'denied';
    const st = readState(String(query.state || ''));
    if (!st || !st.zwid || !st.nonce) return 'expired';
    const [fresh] = await redis([['SET', `cg:comms:oauth:${st.nonce}`, '1', 'EX', 900, 'NX']]);
    if (fresh !== 'OK') return 'expired';   // each sign-in link works once
    const o = oauth();
    try {
      const tok = await fetchImpl(`${API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: o.id, client_secret: o.secret, grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: o.redirect }), signal: AbortSignal.timeout(5000) });
      if (!tok.ok) return 'failed';
      const { access_token: access } = await tok.json();
      const me = await fetchImpl(`${API}/users/@me`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(5000) });
      if (!me.ok) return 'failed';
      const u = await me.json();
      if (!idOk(u.id)) return 'failed';
      await saveLink(String(st.zwid), { id: u.id, by: 'oauth', verified: true, tag: String(u.global_name || u.username || '').slice(0, 40) });
      await redis([['HDEL', KEYS.verify, String(st.zwid)]]);
      return 'linked';
    } catch (e) { return 'failed'; }
  }

  // ── The optional automatic reminder: riders who have not answered for a race that is about to start get one DM, once ──
  const getSettings = async () => { const [raw] = await redis([['GET', KEYS.settings]]); return { autoNudge: false, ...(parse(raw) || {}) }; };
  async function runSchedule(now = Date.now()) {
    if (!bot() || !(await getSettings()).autoNudge) return [];
    const targets = (await nudges(now)).slice(0, 60);
    if (!targets.length) return [];
    const [links, names] = await Promise.all([loadLinks(), namesFor([...new Set(targets.map(t => t.zwid))])]);
    const sent = [], failed = [];
    for (const t of targets.slice(0, 40)) {
      if (skipReason(links[t.zwid], t.kind || 'race')) continue;   // not linked, opted out or has turned these off: no message and no note
      const [claimed] = await redis([['HSETNX', KEYS.sent, `nudge:${t.key}`, new Date(now).toISOString()]]);
      if (!claimed) continue;
      const r = await dm(links[t.zwid].id, `${fill(t.text, names[t.zwid] || '', t.vars)}\n— CRYO-GEN (automatic reminder; you can switch these off in My Profile)`).catch(() => ({ ok: false }));
      (r.ok ? sent : failed).push(names[t.zwid] || t.zwid);
    }
    if (sent.length || failed.length) await recordLog({ at: new Date(now).toISOString(), by: 'auto', audience: 'members', count: sent.length + failed.length, ok: sent.length, failed: failed.length, via: 'dm', kind: 'race', names: [...sent, ...failed].slice(0, 6), text: 'Automatic reminder: say if you can race' });
    return sent.length ? ['comms-nudge'] : [];
  }

  // One automatic direct message from another module (a line-up change, a team short of riders). It goes only when the administrator has switched
  // automatic messages on, the rider's Discord is linked and verified, and they have not turned that kind off; `key` makes it once.
  async function notify(zwid, text, { kind = 'race', key } = {}) {
    if (!bot() || !(await getSettings()).autoNudge) return false;
    const l = (await loadLinks())[String(zwid)];
    if (skipReason(l, kind)) return false;
    if (key) { const [claimed] = await redis([['HSETNX', KEYS.sent, `notify:${key}`, new Date().toISOString()]]); if (!claimed) return false; }
    const r = await dm(l.id, `${text}\n— CRYO-GEN (automatic message; you can switch these off in My Profile)`).catch(() => ({ ok: false }));
    return !!r.ok;
  }

  // Everyone whose Discord ID is saved and verified (for the onboarding checklist).
  const verifiedLinks = async () => new Set(Object.entries(await loadLinks()).filter(([, l]) => l && l.verified).map(([z]) => z));

  // For the associate checklist: a verified Discord account counts as having joined the Discord.
  const linkedVerified = async zwid => { const l = (await loadLinks())[String(zwid)]; return !!(l && l.verified && bot()); };

  const stats = async () => { const l = await loadLinks(); return { linked: Object.keys(l).length, verified: Object.values(l).filter(x => x.verified).length }; };

  return { routes, KEYS, nameScore, norm, linkedVerified, stats, callback, runSchedule, getSettings, oauthOn, notify, verifiedLinks };
};

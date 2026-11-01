'use strict';
// The Comms Studio: when something happens in the club (a ZRL, Ladder or DIRT result, a new week) the studio drafts a post for every platform the club
// uses, in the club's own voice, and puts it in a queue. A person reads it, changes it, ticks the platforms and approves it; only then does anything go out
// (unless a kind of post has been set to go automatically, which is off by default). Riders are named only if they said "OK to feature me". Names never go to
// the AI: it writes "{R1}", "{R2}" and the club puts the names in afterwards.
//
// Posted by the app: Discord, the cryogen.team website (as a draft unless set to publish), Telegram, Bluesky.
// Sent to a Zapier/Make webhook (so no Meta app review is needed): Facebook, Instagram (needs a picture), and one "everything" hook.
// Copied by a person: WhatsApp, Strava (neither allows apps to post to a club or group), and email unless an email hook is set.
const { GUIDE, VERCEL } = require('./studio-guide');
module.exports = function createStudio({ redis, HttpError, requireRole, memberFromRequest, staffNameOf = () => '', ai, fetchRoster, zrl, ladder, drs, adminReq, publicClub, weekInfo = async () => ({}), discord, wp, siteUrl = '', fetchImpl = (...a) => fetch(...a) }) {
  const STATS = 'cg:studio:stats', POSTS = 'cg:studio:posts', FEATURE = 'cg:studio:feature', SEEN = 'cg:studio:seen', SETTINGS = 'cg:studio:settings', IMG = 'cg:studio:img:';
  const DAY = 86400000, MAX_PER_TICK = 3;
  const API = { discord: 'Discord', website: 'Website', telegram: 'Telegram', bluesky: 'Bluesky', facebook: 'Facebook', instagram: 'Instagram', hook: 'Zapier / Make (everything)' };
  const MANUAL = { whatsapp: 'WhatsApp', strava: 'Strava', email: 'Email' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
  const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
  const monday = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── Which platforms are connected (names only; the keys live in Vercel) ──
  const env = k => process.env[k] || '';
  const configured = {
    discord: () => !!env('DISCORD_WEBHOOK_PUBLIC'), website: () => !!(wp && wp.ready()), telegram: () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')), bluesky: () => !!(env('BLUESKY_HANDLE') && env('BLUESKY_APP_PASSWORD')),
    facebook: () => !!env('STUDIO_HOOK_FACEBOOK'), instagram: () => !!env('STUDIO_HOOK_INSTAGRAM'), hook: () => !!env('STUDIO_HOOK_OTHER'),
  };
  const emailHook = () => !!env('STUDIO_HOOK_EMAIL');

  const DEFAULTS = { enabled: false, paused: false, voice: 'Warm, friendly and a little cheeky, like a club that loves racing and looks after its riders.', hashtags: '#CRYOGEN #Zwift #ZRL', websiteStatus: 'draft', dailyLimit: 3, autoKinds: [], disabled: [], stravaUrl: '' };
  const KINDS = ['zrl_result', 'ladder_result', 'dirt_result', 'week_ahead', 'week_recap', 'month_recap', 'milestone', 'weekly_tip', 'manual'];
  async function settings() {
    const s = parse((await redis([['GET', SETTINGS]]))[0]) || {};
    return { enabled: s.enabled === true, paused: s.paused === true, voice: clip(s.voice, 400) || DEFAULTS.voice, hashtags: clip(s.hashtags, 120) || DEFAULTS.hashtags, websiteStatus: s.websiteStatus === 'publish' ? 'publish' : 'draft', dailyLimit: Math.min(Math.max(parseInt(s.dailyLimit, 10) || DEFAULTS.dailyLimit, 1), 20),
      autoKinds: (Array.isArray(s.autoKinds) ? s.autoKinds : []).filter(k => KINDS.includes(k)), disabled: (Array.isArray(s.disabled) ? s.disabled : []).filter(c => API[c]), stravaUrl: /^https:\/\//.test(s.stravaUrl || '') ? String(s.stravaUrl).slice(0, 300) : '' };
  }
  const channelStatus = async () => { const s = await settings(); return [...Object.keys(API).map(c => ({ id: c, label: API[c], type: 'app', configured: configured[c](), enabled: configured[c]() && !s.disabled.includes(c) })), ...Object.keys(MANUAL).map(c => ({ id: c, label: MANUAL[c], type: c === 'email' && emailHook() ? 'app' : 'manual', configured: c === 'email' ? emailHook() : true, enabled: !s.disabled.includes(c) }))]; };

  // ── Riders who said "OK to feature me" ──
  const featured = async () => new Map(pairs((await redis([['HGETALL', FEATURE]]))[0]).map(([z, v]) => [z, parse(v) || {}]));

  // ── Facts for a post. `people` are opted-in riders, given to the AI as {R1}, {R2}… ──
  async function nameRefs(zwids) {
    const f = await featured(), { riders } = await fetchRoster().catch(() => ({ riders: [] })), people = [];
    for (const z of zwids || []) if (f.has(String(z))) { const r = riders.find(x => String(x.riderId) === String(z)); if (r) people.push({ ref: `R${people.length + 1}`, zwid: String(z), name: String(r.name).replace(/\s+/g, ' ').trim() }); }
    return people;
  }
  async function zrlFacts(round, week, results, playing) {
    const rows = playing.map(t => { const r = results[`${week}:${t.id}`]; return r ? { team: t.name.replace(/^CRYO-GEN\s+/i, ''), position: r.pos || null, points: r.pts == null ? null : r.pts } : null; }).filter(Boolean).sort((a, b) => (a.position || 99) - (b.position || 99));
    return { kind: 'zrl_result', headline: `ZRL ${round.name}, race ${week + 1}`, facts: { competition: 'Zwift Racing League', round: round.name, race: week + 1, of: round.weeks, teams: rows } };
  }
  const kindLabel = { zrl_result: 'ZRL result', ladder_result: 'Ladder result', dirt_result: 'DIRT result', week_ahead: 'This week', week_recap: 'Last week', month_recap: 'Month in review', milestone: 'Rider milestone', weekly_tip: 'Tip of the week', manual: 'Post' };

  // ── Drafting ──
  const LIMITS = { discord: 1800, telegram: 3500, bluesky: 290, facebook: 1800, instagram: 1800, whatsapp: 1500, strava: 1500, hook: 1800 };
  function template(ev, people, link, tags) {
    const lines = [ev.headline, ...Object.entries(ev.facts).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${v}`), ...(Array.isArray(ev.facts.teams) ? ev.facts.teams.map(t => `${t.position ? t.position + '. ' : ''}${t.team}${t.points != null ? ` (${t.points} pts)` : ''}`) : []), ...(ev.facts.lines || [])];
    const text = `${lines.join('\n')}${people.length ? `\nWell done ${people.map(p => p.name).join(', ')}!` : ''}\n${link} ${tags}`.trim();
    const v = {}; for (const c of ['discord', 'telegram', 'facebook', 'instagram', 'whatsapp', 'strava', 'hook']) v[c] = text.slice(0, LIMITS[c]);
    v.bluesky = `${ev.headline}${people.length ? ` Well done ${people.map(p => p.name).join(', ')}!` : ''} ${link}`.slice(0, 290);
    v.website = { title: ev.headline, body: lines.join('\n') }; v.email = { subject: ev.headline, body: `${lines.join('\n')}\n\n${link}` };
    return v;
  }
  const put = (text, people) => String(text || '').replace(/\{R(\d+)\}/g, (m, n) => (people[Number(n) - 1] ? people[Number(n) - 1].name : '')).replace(/\{[^}]*\}/g, '').replace(/ {2,}/g, ' ').trim();
  async function compose(ev, st) {
    const link = siteUrl ? `${siteUrl}/club.html` : '', people = await nameRefs(ev.zwids), tags = st.hashtags;
    let v = null, via = 'template';
    if (await ai.available(false)) {
      try {
        const text = await ai.complete({ kind: 'studio', cap: 60, supporter: false, maxTokens: 3000, system: `You write social media posts for a Zwift cycling club. Voice: ${st.voice}\nUse ONLY the facts you are given: never invent results, numbers, names or quotes. Riders appear only as {R1}, {R2}…; use those exact tokens where you mention a rider, and mention nobody else by name. No @mentions, no promises, no medical or political content. British English. Reply with JSON only: {"discord": "...", "telegram": "...", "bluesky": "<under 280 characters, includes the link>", "facebook": "...", "instagram": "<caption, ends with hashtags>", "whatsapp": "...", "strava": "...", "website": {"title": "...", "body": "<2 to 4 short paragraphs separated by blank lines>"}, "email": {"subject": "...", "body": "..."}}. Each platform's version should differ a little in length and style but never in the facts. Include this link where natural: ${link || '(none)'} and these hashtags where they suit: ${tags}.`,
          user: JSON.stringify({ kind: kindLabel[ev.kind], headline: ev.headline, facts: ev.facts, riders: people.map(p => p.ref) }) });
        const j = ai.json(text); if (j && j.discord) { v = j; via = 'ai'; }
      } catch (e) { console.error('Studio draft:', e.message); }
    }
    if (!v) v = template(ev, people, link, tags);
    const out = {};
    for (const c of ['discord', 'telegram', 'bluesky', 'facebook', 'instagram', 'whatsapp', 'strava', 'hook']) out[c] = put(v[c] || v.discord, people).slice(0, LIMITS[c]);
    out.website = { title: clip(put((v.website || {}).title || ev.headline, people), 120), body: put((v.website || {}).body || v.discord, people).slice(0, 4000) };
    out.email = { subject: clip(put((v.email || {}).subject || ev.headline, people), 150), body: put((v.email || {}).body || v.discord, people).slice(0, 4000) };
    return { variants: out, via, named: people.map(p => p.name) };
  }

  async function create(ev, who) {
    const st = await settings(), c = await compose(ev, st);
    const p = { id: uid(), kind: ev.kind, headline: ev.headline, status: 'pending', createdAt: new Date().toISOString(), by: who, via: c.via, named: c.named, variants: c.variants, channels: [], results: {}, imageId: '' };
    await redis([['HSET', POSTS, p.id, JSON.stringify(p)]]);
    return p;
  }
  const load = async id => { const p = parse((await redis([['HGET', POSTS, String(id)]]))[0]); if (!p) throw new HttpError(404, 'That post is not there.'); return p; };
  const save = p => redis([['HSET', POSTS, p.id, JSON.stringify(p)]]);

  // ── Publishing ──
  const imageUrl = p => (p.imageId && siteUrl ? `${siteUrl}/api/studio/img/${p.imageId}.png` : '');
  const post = async (url, body, headers = {}) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${clip(d.message || d.error || d.description || '', 120)}`.trim()); return d;
  };
  const publishers = {
    discord: async (p, v) => { const ok = await discord('public', { content: v.discord }); if (!ok) throw new Error('Discord did not accept it'); return {}; },
    website: async (p, v, st) => {
      const img = imageUrl(p), html = `${v.website.body.split(/\n{2,}/).map(x => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('')}${img ? `<p><img src="${esc(img)}" alt="${esc(p.headline)}"/></p>` : ''}`;
      const d = await wp.post({ title: v.website.title, content: html, status: st.websiteStatus }); return { url: d.link || '', note: st.websiteStatus === 'draft' ? 'saved as a draft on the website' : '' };
    },
    telegram: async (p, v) => {
      const base = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`, img = imageUrl(p);
      if (img && v.telegram.length <= 1000) await post(`${base}/sendPhoto`, { chat_id: env('TELEGRAM_CHAT_ID'), photo: img, caption: v.telegram }); else await post(`${base}/sendMessage`, { chat_id: env('TELEGRAM_CHAT_ID'), text: v.telegram });
      return {};
    },
    bluesky: async (p, v) => {
      const s = await post('https://bsky.social/xrpc/com.atproto.server.createSession', { identifier: env('BLUESKY_HANDLE'), password: env('BLUESKY_APP_PASSWORD') });
      const text = v.bluesky, facets = [], enc = new TextEncoder();
      for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) { const start = enc.encode(text.slice(0, m.index)).length; facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] }); }
      const d = await post('https://bsky.social/xrpc/com.atproto.repo.createRecord', { repo: s.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'], ...(facets.length ? { facets } : {}) } }, { authorization: `Bearer ${s.accessJwt}` });
      return { url: d.uri ? `https://bsky.app/profile/${s.did}/post/${String(d.uri).split('/').pop()}` : '' };
    },
    facebook: async (p, v) => { await post(env('STUDIO_HOOK_FACEBOOK'), { platform: 'facebook', id: p.id, kind: p.kind, title: p.headline, text: v.facebook, imageUrl: imageUrl(p), link: siteUrl }); return {}; },
    instagram: async (p, v) => { const img = imageUrl(p); if (!img) throw new Error('Instagram needs a picture: make the picture card first'); await post(env('STUDIO_HOOK_INSTAGRAM'), { platform: 'instagram', id: p.id, kind: p.kind, title: p.headline, text: v.instagram, imageUrl: img, link: siteUrl }); return {}; },
    hook: async (p, v) => { await post(env('STUDIO_HOOK_OTHER'), { platform: 'all', id: p.id, kind: p.kind, title: p.headline, imageUrl: imageUrl(p), link: siteUrl, variants: v }); return {}; },
    email: async (p, v) => { await post(env('STUDIO_HOOK_EMAIL'), { platform: 'email', id: p.id, kind: p.kind, subject: v.email.subject, text: v.email.body, imageUrl: imageUrl(p) }); return {}; },
  };
  async function postedToday(channel) { const [raw] = await redis([['HGETALL', POSTS]]); const d = day(); return pairs(raw).map(([, v]) => parse(v)).filter(Boolean).filter(p => (p.results[channel] || {}).ok && String((p.results[channel] || {}).at || '').startsWith(d)).length; }
  async function publish(p, channels, who) {
    const st = await settings(); if (st.paused) throw new HttpError(409, 'The studio is paused. Switch it back on in the settings.');
    const status = await channelStatus(), usable = new Set(status.filter(c => c.enabled && c.type === 'app').map(c => c.id));
    const todo = [...new Set(channels)].filter(c => usable.has(c));
    for (const c of todo) {
      if ((p.results[c] || {}).ok) continue;
      if (await postedToday(c) >= st.dailyLimit) { p.results[c] = { ok: false, error: `Daily limit of ${st.dailyLimit} reached for this platform`, at: new Date().toISOString() }; continue; }
      try { const r = await publishers[c](p, p.variants, st); p.results[c] = { ok: true, at: new Date().toISOString(), ...r }; }
      catch (e) { p.results[c] = { ok: false, error: clip(e.message, 200), at: new Date().toISOString() }; }
    }
    p.channels = [...new Set([...(p.channels || []), ...channels])]; p.approvedBy = who; p.approvedAt = p.approvedAt || new Date().toISOString();
    const anyOk = Object.values(p.results).some(r => r.ok); p.status = anyOk ? 'posted' : (todo.length ? 'failed' : 'approved');
    await save(p); return p;
  }

  // ── Looking for things worth a post ──
  async function findEvents(now) {
    const out = [], dt = new Date(now), adm = adminReq();
    try {
      const z = await zrl.load();
      if (z.round && z.round.published) {
        const results = await zrl.loadResults(), playing = z.round.teams.filter(t => z.signups.some(x => x.in && (z.assign[x.key] || []).includes(t.id)));
        for (let i = 0; i < z.round.weeks; i++) {
          const race = Date.parse(`${z.round.start}T00:00:00Z`) + i * 7 * DAY, have = playing.filter(t => results[`${i}:${t.id}`]);
          if (!have.length || now < race + 6 * 3600000) continue;
          if (have.length < playing.length && now < race + 36 * 3600000) continue;   // wait for the other teams, up to a day and a half
          const ev = await zrlFacts(z.round, i, results, playing); ev.key = `zrl:${z.round.id}:${i}`;
          const lineup = (await zrl.loadWeekly()).lineup || {};
          ev.zwids = Object.entries(lineup).filter(([f]) => f.startsWith(`${i}:`)).flatMap(([, l]) => l);
          out.push(ev);
        }
      }
    } catch (e) { /* the other kinds still run */ }
    try {
      for (const m of await ladder.allMatches(adm, now)) if (m.status === 'played' && m.result && m.at && now - m.at < 5 * DAY) out.push({ key: `ladder:${m.id}`, kind: 'ladder_result', headline: `Ladder: ${m.teamName || 'CRYO-GEN'} v ${m.opponent}`, zwids: m.lineup || [], facts: { competition: 'Zwift Club Ladder', opponent: m.opponent, weWon: !!m.result.won, ourPoints: m.result.ourPoints, theirPoints: m.result.theirPoints, route: (m.route && m.route.name) || null } });
    } catch (e) { /* ditto */ }
    try {
      for (const s of await drs.allStages(adm, now)) if (s.status === 'played' && s.result && s.startMs && now - s.startMs < 5 * DAY) out.push({ key: `drs:${s.id}`, kind: 'dirt_result', headline: `DIRT Series: stage ${s.n}${s.route ? ` · ${s.route}` : ''}`, zwids: s.result.scorers || [], facts: { competition: 'DIRT Racing Series', team: s.teamName, stage: s.n, teamPoints: s.result.teamPoints, route: s.route || null } });
    } catch (e) { /* ditto */ }
    if (dt.getUTCDay() === 1 && dt.getUTCHours() >= 8) {
      const wk = monday(now);
      try {
        const pc = await publicClub(now), ahead = (pc.next || []).filter(n => n.at ? n.at < now + 7 * DAY : true).slice(0, 8);
        if (ahead.length) out.push({ key: `ahead:${wk}`, kind: 'week_ahead', headline: 'This week at CRYO-GEN', zwids: [], facts: { fixtures: ahead.map(n => `${n.series}: ${n.title} (${n.date})`).slice(0, 8), lines: ahead.map(n => `${n.series}: ${n.title} on ${n.date}`) } });
        const info = await weekInfo(now), lines = [];
        for (const t of pc.ladder || []) for (const r of (t.recent || []).slice(0, 2)) if (r.date && r.date >= day(now - 7 * DAY)) lines.push(`Ladder: ${r.won ? 'won' : 'lost'} ${r.score} v ${r.opponent}`);
        for (const g of pc.podium || []) if (g.top && g.top[0]) lines.push(`ZRL ${g.division}: ${g.top.map(t => `${t.rank}. ${t.team} (${t.points})`).join(', ')}`);
        if (lines.length || info.newMembers) out.push({ key: `recap:${wk}`, kind: 'week_recap', headline: 'The week at CRYO-GEN', zwids: [], facts: { newMembersJoined: info.newMembers || 0, lines } });
      } catch (e) { /* ditto */ }
    }
    // Milestones for riders who opted in (their first win, a podium, their 10th, 25th, 50th, 100th race): noticed by comparing with what the roster said last time.
    try {
      const f = await featured(), { riders } = await fetchRoster(), [prevRaw] = await redis([['HGETALL', STATS]]), prev = Object.fromEntries(pairs(prevRaw).map(([z, v]) => [z, parse(v) || {}])), writes = [];
      for (const r of riders) {
        const z = String(r.riderId); if (!f.has(z)) continue;
        const cur = { f: (r.race && r.race.finishes) || 0, w: (r.race && r.race.wins) || 0, p: (r.race && r.race.podiums) || 0 }, old = prev[z];
        writes.push(['HSET', STATS, z, JSON.stringify(cur)]);
        if (!old) continue;   // the first time we see them is only the starting point
        const mk = (type, n, text) => out.push({ key: `milestone:${z}:${type}:${n}`, kind: 'milestone', headline: text.replace('{R1}', 'A CRYO-GEN rider'), zwids: [z], facts: { milestone: text, lines: [text.replace('{R1}', '{R1}')] } });
        for (const n of [10, 25, 50, 100, 200]) if (old.f < n && cur.f >= n) mk('races', n, `{R1} has now finished ${n} races`);
        if (old.w === 0 && cur.w > 0) mk('win', 1, '{R1} has won a race for the first time'); else if (cur.w > old.w) mk('win', cur.w, `{R1} has won again: ${cur.w} wins now`);
        if (old.p === 0 && cur.p > 0) mk('podium', 1, '{R1} has reached the podium for the first time'); else for (const n of [5, 10, 25]) if (old.p < n && cur.p >= n) mk('podium', n, `{R1} has now stood on the podium ${n} times`);
      }
      if (writes.length) await redis(writes);
    } catch (e) { /* the other kinds still run */ }
    // A practical tip each Thursday (needs the AI: a bland template is not worth a post), and a month in review on the 1st.
    if (dt.getUTCDay() === 4 && dt.getUTCHours() >= 8 && await ai.available(false)) {
      const themes = ['pacing a race so you have something left for the end', 'fuelling before and during a race', 'getting the best from your trainer set-up and cooling', 'sitting in the bunch and using the draft', 'warming up properly so the first minutes do not hurt', 'recovering well between races', 'keeping calm and sharp on race day', 'reading a route profile before you start'];
      const wk = monday(now), n = Math.floor(Date.parse(wk + 'T00:00:00Z') / (7 * DAY)) % themes.length;
      out.push({ key: `tip:${wk}`, kind: 'weekly_tip', headline: 'Tip of the week', zwids: [], facts: { theme: themes[n], audience: 'Zwift riders of all levels in a friendly racing club', lines: [] }, needsAi: true });
    }
    if (dt.getUTCDate() === 1 && dt.getUTCHours() >= 8) {
      try {
        const pc = await publicClub(now), lines = [];
        for (const t of pc.ladder || []) lines.push(`Ladder, ${t.team}: ${t.won} won, ${t.lost} lost`);
        for (const g of pc.podium || []) lines.push(`ZRL ${g.division}: ${g.top.map(x => `${x.rank}. ${x.team} (${x.points})`).join(', ')}`);
        for (const t of pc.drs || []) lines.push(`DIRT Series, ${t.team}: ${t.teamPoints} points`);
        if (lines.length) out.push({ key: `month:${dt.toISOString().slice(0, 7)}`, kind: 'month_recap', headline: `${dt.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} at CRYO-GEN`, zwids: [], facts: { lines } });
      } catch (e) { /* ditto */ }
    }
    return out;
  }
  async function runSchedule(now = Date.now()) {
    // Off until an administrator switches it on, so nothing is drafted (and no AI is used) before the club has chosen to.
    const st = await settings(); if (!st.enabled || st.paused) return [];
    const events = await findEvents(now); let made = 0, ready = 0;
    for (const ev of events) {
      if (made >= MAX_PER_TICK) break;
      if (ev.needsAi && !(await ai.available(false))) continue;
      const [first] = await redis([['HSETNX', SEEN, ev.key, new Date(now).toISOString()]]); if (!first) continue;
      made++;
      try {
        const p = await create(ev, 'automatic');
        if (st.autoKinds.includes(ev.kind)) { const usable = (await channelStatus()).filter(c => c.enabled && c.type === 'app').map(c => c.id); await publish(p, usable, 'automatic'); } else ready++;
      } catch (e) { console.error('Studio:', e.message); await redis([['HDEL', SEEN, ev.key]]).catch(() => {}); }
    }
    if (ready) await discord('admin', { content: `📣 **Comms Studio:** ${ready} post${ready === 1 ? ' is' : 's are'} ready for you to read and approve: ${siteUrl}/ → Studio.` }).catch(() => {});
    return [];
  }

  // ── Pictures (made in the browser, kept 30 days, shown at an unguessable address) ──
  async function saveImage(p, b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 100 || buf.length > 450000 || buf.readUInt32BE(0) !== 0x89504e47) throw new HttpError(400, 'That is not a PNG picture under 450 KB.');
    const id = require('crypto').randomBytes(12).toString('hex');
    await redis([['SET', IMG + id, buf.toString('base64'), 'EX', String(30 * 86400)]]);
    p.imageId = id; await save(p); return id;
  }
  const getImage = async id => { if (!/^[0-9a-f]{24}$/.test(id)) return null; const [b] = await redis([['GET', IMG + id]]); return b ? Buffer.from(b, 'base64') : null; };

  async function testChannel(c) {
    const g = GUIDE.find(x => x.id === c); if (!g) throw new HttpError(400, 'Choose a platform from the list.');
    const missing = g.env.filter(e => !env(e));
    if (missing.length) return { ok: false, detail: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set yet.`, hint: 'Add it in Vercel (Settings, Environment Variables), then Redeploy and test again. The steps are above.' };
    const fail = (e, hints) => { const m = clip(e.message, 160); return { ok: false, detail: m, hint: (hints.find(([re]) => re.test(m)) || [0, 'Check the steps above and try again.'])[1] }; };
    try {
      if (c === 'telegram') { await post(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, { chat_id: env('TELEGRAM_CHAT_ID'), text: '✅ CRYO-GEN Studio test: this channel is connected.' }); return { ok: true, detail: 'A test message was sent. Look in your Telegram channel.' }; }
      if (c === 'bluesky') { const s = await post('https://bsky.social/xrpc/com.atproto.server.createSession', { identifier: env('BLUESKY_HANDLE'), password: env('BLUESKY_APP_PASSWORD') }); return { ok: true, detail: `Signed in as ${s.handle || env('BLUESKY_HANDLE')}. Nothing was posted.` }; }
      if (c === 'website') { if (!wp || !wp.ready()) return { ok: false, detail: 'The WordPress login is not set up.', hint: 'The app needs WP_API_USER and WP_API_APP_PASSWORD (it uses them for member records).' }; const me = await wp.me(), caps = me.capabilities || {}; return caps.publish_posts || caps.edit_posts ? { ok: true, detail: `Signed in to the website as ${me.name || 'the club user'}, and allowed to write posts.` } : { ok: false, detail: `Signed in as ${me.name || 'the club user'}, but not allowed to write posts.`, hint: 'In WordPress go to Users, open that user and set Role to Author, Editor or Administrator.' }; }
      if (c === 'discord') { const ok = await discord('admin', { content: '✅ CRYO-GEN Studio test: Discord is connected.' }, { noQueue: true }); return ok ? { ok: true, detail: 'A test line was posted in the admin channel.' } : { ok: false, detail: 'Discord did not accept the post.', hint: 'The webhook may have been deleted. Make a new one in Discord (channel settings, Integrations, Webhooks) and update DISCORD_WEBHOOK_PUBLIC in Vercel.' }; }
      const hookEnv = { facebook: 'STUDIO_HOOK_FACEBOOK', instagram: 'STUDIO_HOOK_INSTAGRAM', hook: 'STUDIO_HOOK_OTHER', email: 'STUDIO_HOOK_EMAIL' }[c];
      if (hookEnv) { await post(env(hookEnv), { platform: c, test: true, id: 'test', kind: 'test', title: 'Test from CRYO-GEN Studio', text: 'This is a test from the CRYO-GEN Studio. It is safe to ignore.', subject: 'Test from CRYO-GEN Studio', imageUrl: '', link: siteUrl, variants: { discord: 'Test' } }); return { ok: true, detail: 'A test was sent. In Zapier (or Make) press Test trigger / Find new records, and you should see it with the fields text, title and link.' }; }
      return { ok: true, detail: 'There is nothing to test: you post this one by hand.' };
    } catch (e) {
      return fail(e, [[/chat not found|400/i, 'The chat ID is wrong, or the bot is not an admin of the channel. Check steps 5 and 6.'], [/401|unauthorized|Invalid identifier/i, 'The token or password was not accepted. Copy it again carefully (no spaces).'], [/404/, 'That address was not found. Copy the link again from Zapier.'], [/403|forbidden/i, 'It was refused: check the permissions in the steps above.']]);
    }
  }

  // ── Routes ──
  const staff = req => requireRole(req, ['admin', 'mod']);
  const routes = {
    'GET /api/studio': async req => {
      staff(req);
      const [raw] = await redis([['HGETALL', POSTS]]);
      const posts = pairs(raw).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40);
      return { vercel: VERCEL, guide: GUIDE.map(g => ({ ...g, missing: g.env.filter(e => !env(e)) })), posts, channels: await channelStatus(), settings: await settings(), aiOn: ai.enabled(), kinds: KINDS.map(k => ({ id: k, label: kindLabel[k] })), stravaUrl: (await settings()).stravaUrl };
    },
    'POST /api/studio/settings': async (req, body) => {
      requireRole(req, ['admin']);
      const s = { enabled: body.enabled === true, paused: body.paused === true, voice: clip(body.voice, 400), hashtags: clip(body.hashtags, 120), websiteStatus: body.websiteStatus === 'publish' ? 'publish' : 'draft', dailyLimit: body.dailyLimit, autoKinds: body.autoKinds, disabled: body.disabled, stravaUrl: body.stravaUrl };
      await redis([['SET', SETTINGS, JSON.stringify(s)]]); return { settings: await settings() };
    },
    'POST /api/studio/draft': async (req, body) => {
      staff(req);
      const brief = clip(body.brief, 800); if (!brief) throw new HttpError(400, 'Say what the post is about.');
      const p = await create({ kind: 'manual', key: '', headline: clip(body.title, 100) || 'Club news', zwids: [], facts: { brief, lines: [brief] } }, staffNameOf(req) || 'staff'); return { post: p };
    },
    'POST /api/studio/edit': async (req, body) => {
      staff(req); const p = await load(body.id); if (p.status === 'posted') throw new HttpError(409, 'It has already gone out.');
      const v = body.variants || {};
      for (const c of Object.keys(LIMITS)) if (typeof v[c] === 'string') p.variants[c] = clip(v[c], LIMITS[c]);
      if (v.website) p.variants.website = { title: clip(v.website.title, 120), body: clip(v.website.body, 4000) };
      if (v.email) p.variants.email = { subject: clip(v.email.subject, 150), body: clip(v.email.body, 4000) };
      await save(p); return { post: p };
    },
    'POST /api/studio/approve': async (req, body) => { staff(req); const p = await load(body.id); return { post: await publish(p, Array.isArray(body.channels) ? body.channels : [], staffNameOf(req) || 'staff') }; },
    'POST /api/studio/reject': async (req, body) => { staff(req); const p = await load(body.id); p.status = 'rejected'; await save(p); return { post: p }; },
    'POST /api/studio/done': async (req, body) => { staff(req); const p = await load(body.id), c = String(body.channel || ''); if (!MANUAL[c]) throw new HttpError(400, 'That one is posted by the app.'); p.results[c] = { ok: true, manual: true, at: new Date().toISOString() }; if (p.status === 'pending') p.status = 'posted'; await save(p); return { post: p }; },
    'POST /api/studio/image': async (req, body) => { staff(req); const p = await load(body.id); return { imageId: await saveImage(p, body.png), post: p }; },
    // "Test the connection" for one platform: a real, harmless call, and a plain answer about what to fix.
    'POST /api/studio/test': async (req, body) => { requireRole(req, ['admin']); return testChannel(String(body.channel || '')); },
    'GET /api/studio/feature': async req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return { on: !!(await featured()).get(m.zwid) }; },
    'POST /api/studio/feature': async (req, body) => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      await redis([body.on === false ? ['HDEL', FEATURE, m.zwid] : ['HSET', FEATURE, m.zwid, JSON.stringify({ at: new Date().toISOString() })]]); return { on: body.on !== false };
    },
  };
  return { routes, runSchedule, findEvents, compose, create, publish, getImage, settings, channelStatus, featured };
};

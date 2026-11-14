'use strict';
// Riders who stream their races: each adds one link (Twitch, YouTube, Kick or Facebook), and everyone signed in sees the collection, grouped by ZRL team.
// A link is only ever shown with the rider's name, and only if the rider added it themselves; they can remove it at any time.
module.exports = function createStreams({ redis, HttpError, memberFromRequest, roleFromRequest, teamsOf = async () => ({}) }) {
  const KEY = 'cg:streams';
  const HOSTS = [['twitch.tv', 'Twitch'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['kick.com', 'Kick'], ['facebook.com', 'Facebook'], ['fb.watch', 'Facebook']];
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  function clean(raw) {
    const t = String(raw || '').trim(); if (!t) return null;
    let u; try { u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch (e) { throw new HttpError(400, 'That does not look like a web address.'); }
    if (u.protocol !== 'https:') throw new HttpError(400, 'Use an https:// link.');
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, ''), hit = HOSTS.find(([h]) => host === h || host.endsWith('.' + h));
    if (!hit) throw new HttpError(400, 'Streams from Twitch, YouTube, Kick or Facebook are supported.');
    if (u.username || u.password) throw new HttpError(400, 'Remove the user name and password from that link.');
    return { url: u.toString().slice(0, 300), platform: hit[1] };
  }
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const routes = {
    'GET /api/streams': async req => {
      if (!roleFromRequest(req) && !memberFromRequest(req)) throw new HttpError(401, 'Please sign in.');
      const [h, teams] = await Promise.all([redis([['HGETALL', KEY]]), teamsOf().catch(() => ({}))]);
      const flat = h[0] || [], rows = [];
      for (let i = 0; i < flat.length; i += 2) { const v = parse(flat[i + 1]); if (v) rows.push({ zwid: flat[i], name: v.name, url: v.url, platform: v.platform, teams: teams[flat[i]] || [] }); }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      const m = memberFromRequest(req);
      return { streams: rows, mine: m ? (rows.find(r => r.zwid === String(m.zwid)) || null) : null, canAdd: !!m };
    },
    'POST /api/me/stream': async (req, body) => {
      const m = need(req), z = String(m.zwid);
      const c = clean(body && body.url);
      if (!c) { await redis([['HDEL', KEY, z]]); return { ok: true, removed: true }; }
      await redis([['HSET', KEY, z, JSON.stringify({ name: m.name, url: c.url, platform: c.platform, ts: Date.now() })]]);
      return { ok: true, platform: c.platform };
    },
  };
  return { routes, clean };
};

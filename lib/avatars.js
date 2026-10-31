'use strict';
// A rider's own avatar: one emoji they pick, shown next to their name for other signed-in members. Zwift's own profile pictures are not part of the
// data the club gets, and uploaded photos would need a public address per rider, so this is a single emoji (nothing else is stored).
module.exports = function createAvatars({ redis, HttpError, memberFromRequest, roleFromRequest, supporters = async () => [] }) {
  const KEY = 'cg:me:avatar';   // zwid -> emoji
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  const one = s => { const t = String(s || '').trim(); const parts = seg ? [...seg.segment(t)].map(x => x.segment) : [...t]; return parts.length === 1 && /\p{Extended_Pictographic}/u.test(parts[0]) && t.length <= 16 ? t : ''; };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

  const routes = {
    // Everyone who has one: {zwid: emoji}. Signed-in members and staff only.
    'GET /api/avatars': async req => {
      if (!memberFromRequest(req) && !roleFromRequest(req)) throw new HttpError(401, 'Sign in first.');
      return { avatars: Object.fromEntries(pairs((await redis([['HGETALL', KEY]]))[0])), supporters: await supporters().catch(() => []) };
    },
    'POST /api/me/avatar': async (req, body) => {
      const me = memberFromRequest(req);
      if (!me) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const emoji = String(body.emoji || '').trim();
      if (!emoji) { await redis([['HDEL', KEY, me.zwid]]); return { emoji: '' }; }
      const ok = one(emoji);
      if (!ok) throw new HttpError(400, 'Pick one emoji.');
      await redis([['HSET', KEY, me.zwid, ok]]);
      return { emoji: ok };
    },
  };
  return { routes, one, KEY };
};

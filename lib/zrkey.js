'use strict';
// The ZwiftRacing.app API keys. ZWIFTRACING_API_KEY is the main key and ZWIFTRACING_API_KEY_spare the backup: a request is made with the main key,
// and when ZwiftRacing.app refuses it (401/403) or the minute's allowance is used up (429), the same request is made once with the spare.
// Every part of the app that talks to the ZwiftRacing.app API goes through here, so both keys are used everywhere.
const named = () => [['main', process.env.ZWIFTRACING_API_KEY], ['spare', process.env.ZWIFTRACING_API_KEY_spare]].map(([n, k]) => [n, String(k || '').trim()]).filter(([, k]) => k);
const keys = () => named().map(([, k]) => k);
const zrKeySet = () => keys().length > 0;
const RETRY_WITH_SPARE = new Set([401, 403, 429]);

// fetch() with the key in the Authorization header (sent raw, as the API wants). Returns the last Response; `keyUsed` says which key answered
// ('main' or 'spare'), for the health page. Throws only when no key is set or the network fails.
async function zrFetch(url, opts = {}, fetchImpl = (...a) => fetch(...a)) {
  const list = named();
  if (!list.length) throw Object.assign(new Error('ZWIFTRACING_API_KEY is not set in Vercel yet.'), { status: 503 });
  let res = null;
  for (let i = 0; i < list.length; i++) {
    res = await fetchImpl(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: list[i][1] } });
    res.keyUsed = list[i][0];
    if (!RETRY_WITH_SPARE.has(res.status)) break;
  }
  return res;
}

module.exports = { zrFetch, zrKeySet, zrKeyCount: () => keys().length };

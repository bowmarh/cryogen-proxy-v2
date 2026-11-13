'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.setEnv();
const load = () => { delete require.cache[require.resolve('../lib/zrkey')]; return require('../lib/zrkey'); };
const res = status => new Response('{}', { status });

test('the main key is used first; the spare is tried when the main key is refused or rate-limited, and not otherwise', async () => {
  process.env.ZWIFTRACING_API_KEY = 'main'; process.env.ZWIFTRACING_API_KEY_spare = 'spare';
  const { zrFetch } = load(), seen = [];
  const ok = await zrFetch('https://api.zwiftracing.app/x', {}, async (u, o) => { seen.push(o.headers.Authorization); return res(200); });
  assert.deepEqual(seen, ['main']); assert.equal(ok.keyUsed, 'main');
  for (const st of [401, 403, 429]) {
    seen.length = 0;
    const r = await zrFetch('https://api.zwiftracing.app/x', {}, async (u, o) => { seen.push(o.headers.Authorization); return res(o.headers.Authorization === 'main' ? st : 200); });
    assert.deepEqual(seen, ['main', 'spare'], `after ${st}`); assert.equal(r.keyUsed, 'spare');
  }
  seen.length = 0;
  const nf = await zrFetch('https://api.zwiftracing.app/x', {}, async (u, o) => { seen.push(o.headers.Authorization); return res(404); });
  assert.deepEqual(seen, ['main'], 'a 404 is an answer, not a key problem'); assert.equal(nf.status, 404);
});

test('the spare alone works, and no key at all says so', async () => {
  delete process.env.ZWIFTRACING_API_KEY; process.env.ZWIFTRACING_API_KEY_spare = 'spare';
  let { zrFetch, zrKeySet } = load(); assert.equal(zrKeySet(), true);
  const r = await zrFetch('u', {}, async (u, o) => { assert.equal(o.headers.Authorization, 'spare'); return res(200); }); assert.equal(r.keyUsed, 'spare');
  delete process.env.ZWIFTRACING_API_KEY_spare; ({ zrFetch, zrKeySet } = load()); assert.equal(zrKeySet(), false);
  await assert.rejects(() => zrFetch('u', {}, async () => res(200)), /not set/);
});

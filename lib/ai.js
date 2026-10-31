'use strict';
// One place that talks to the model for the newer AI features: the key, the model, the budget, a daily cap per kind of use, token counting, and the
// answer joined from every text block. The older coach and investigation code keeps its own copy of this on purpose (it works; leave it alone).
module.exports = function createAi({ redis, HttpError, support, fetchImpl = (...a) => fetch(...a) }) {
  const MODEL = () => process.env.AI_MODEL || process.env.COACH_MODEL || process.env.ASSISTANT_MODEL || 'claude-sonnet-5-5';
  const day = () => new Date().toISOString().slice(0, 10);
  const enabled = () => !!process.env.ANTHROPIC_API_KEY;

  // For scheduled jobs: is there room in the budget? (Never throws.)
  async function available(supporter = true) {
    if (!enabled()) return false;
    try { return (await support.budgetState(supporter)).ok; } catch (e) { return false; }
  }
  async function record(kind, u) {
    const d = day();
    await redis([['HINCRBY', support.KEYS.AI, `${d}:in`, Number(u && u.input_tokens) || 0], ['HINCRBY', support.KEYS.AI, `${d}:out`, Number(u && u.output_tokens) || 0], ['HINCRBY', support.KEYS.AI, `${d}:calls`, 1], ['HINCRBY', support.KEYS.AI, `${d}:k:${kind}`, 1]]);
  }
  // `cap` is the most calls of this kind a day (the whole club, not one rider).
  async function complete({ kind, system, user, messages, maxTokens = 1500, supporter = true, cap = 0 }) {
    if (!enabled()) throw new HttpError(503, 'The AI features need ANTHROPIC_API_KEY in Vercel.');
    const b = await support.budgetState(supporter); if (!b.ok) throw new HttpError(429, b.why);
    if (cap) { const [n] = await redis([['INCR', `cg:ai:kind:${kind}:${day()}`]]); await redis([['EXPIRE', `cg:ai:kind:${kind}:${day()}`, 172800]]); if (n > cap) throw new HttpError(429, `That is limited to ${cap} a day across the club. Try again tomorrow.`); }
    let r, data;
    try {
      r = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system, messages: messages || [{ role: 'user', content: user }] }), signal: AbortSignal.timeout(45000) });
      data = await r.json();
    } catch (e) { throw new HttpError(502, 'The AI could not be reached just now.'); }
    if (!r.ok) throw new HttpError(502, 'The AI could not answer just now.');
    await record(kind, data.usage).catch(() => {});
    const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    if (!text) { console.error(`AI ${kind}: no text, stop_reason =`, data.stop_reason); throw new HttpError(502, 'The AI had no answer that time. Please try again.'); }
    return text;
  }
  const json = t => { try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { return null; } };
  const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
  return { complete, available, enabled, json, clip, MODEL };
};

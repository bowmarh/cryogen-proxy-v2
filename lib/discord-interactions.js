'use strict';
// Buttons in Discord direct messages: a rider taps Yes, Maybe or No under the reminder and the answer is saved as if they had used the dashboard.
// Discord posts every button tap to one address (the "Interactions Endpoint URL" in the Discord developer portal), signed with Ed25519 using the
// application's public key (DISCORD_PUBLIC_KEY). The signature is checked over the exact bytes received, so a request that is not from Discord is refused.
const crypto = require('crypto');

module.exports = function createDiscordInteractions({ publicKey = () => process.env.DISCORD_PUBLIC_KEY || '', zwidOfDiscord, answer }) {
  const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
  const STATUS_LABEL = { yes: '✅ Yes', maybe: '🤔 Maybe', no: '❌ No' };

  function verify(raw, headers) {
    const key = publicKey(), sig = String(headers['x-signature-ed25519'] || ''), ts = String(headers['x-signature-timestamp'] || '');
    if (!/^[0-9a-fA-F]{64}$/.test(key) || !/^[0-9a-fA-F]{128}$/.test(sig) || !ts) return false;
    try {
      const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key, 'hex')]), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(ts + raw), pub, Buffer.from(sig, 'hex'));
    } catch (e) { return false; }
  }

  // The buttons under a message: custom_id is "av|<series>|<id>|<answer>" (at most 100 characters).
  const buttons = (series, id) => {
    const cid = s => `av|${series}|${id}|${s}`.slice(0, 100);
    return [{ type: 1, components: [{ type: 2, style: 3, label: 'Yes', custom_id: cid('yes') }, { type: 2, style: 2, label: 'Maybe', custom_id: cid('maybe') }, { type: 2, style: 4, label: 'No', custom_id: cid('no') }] }];
  };

  async function handle(raw, headers) {
    if (!verify(raw, headers)) return { status: 401, body: { error: 'invalid request signature' } };
    let it; try { it = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'invalid JSON' } }; }
    if (it.type === 1) return { status: 200, body: { type: 1 } };   // Discord's ping when the address is saved
    if (it.type !== 3) return { status: 200, body: { type: 4, data: { content: 'Nothing to do here.', flags: 64 } } };
    const m = /^av\|(zrl|ladder|drs)\|([^|]+)\|(yes|maybe|no)$/.exec(String((it.data || {}).custom_id || ''));
    const user = (it.user || (it.member && it.member.user) || {}).id;
    const reply = text => ({ status: 200, body: { type: 4, data: { content: text, flags: 64 } } });   // 64: only the rider sees it
    if (!m || !user) return reply('That button is not recognised.');
    const zwid = await zwidOfDiscord(user);
    if (!zwid) return reply('I could not tell who you are. Link your Discord in My Profile on the club dashboard first.');
    try { await answer(zwid, m[1], m[2], m[3]); } catch (e) { return reply(`I could not save that: ${String((e && e.message) || 'something went wrong').slice(0, 160)}`); }
    const base = String(((it.message || {}).content) || '').split('\n\n✔')[0];
    return { status: 200, body: { type: 7, data: { content: `${base}\n\n✔ You said **${STATUS_LABEL[m[3]]}**. Tap another button to change it.`.slice(0, 1900), components: (it.message || {}).components || [] } } };
  }
  return { handle, verify, buttons };
};

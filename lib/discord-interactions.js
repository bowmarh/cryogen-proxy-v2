'use strict';
// Buttons in Discord direct messages: a rider taps Yes, Maybe or No under the reminder and the answer is saved as if they had used the dashboard.
// Discord posts every button tap to one address (the "Interactions Endpoint URL" in the Discord developer portal), signed with Ed25519 using the
// application's public key (DISCORD_PUBLIC_KEY). The signature is checked over the exact bytes received, so a request that is not from Discord is refused.
const crypto = require('crypto');

// Slash commands a linked rider can type in Discord: /week, /recap, /badges and /answer. Replies are only ever shown to the rider who typed them.
const COMMANDS = [
  { name: 'week', description: 'Your next seven days in the club' },
  { name: 'recap', description: 'Your latest race recap' },
  { name: 'badges', description: 'Your badges and the next one to aim for' },
  { name: 'answer', description: 'Answer your next availability request', options: [{ type: 3, name: 'status', description: 'Can you race?', required: true, choices: [{ name: 'Yes', value: 'yes' }, { name: 'Maybe', value: 'maybe' }, { name: 'No', value: 'no' }] }] },
];
const ICON = { in: '✅', todo: '🟡', info: '⚪', out: '➖' };
const cap = t => String(t).slice(0, 1900);
const weekText = items => {
  const rows = (items || []).slice(0, 12).map(u => `${ICON[u.state] || '•'} **${u.date}**${u.timed ? ' ' + new Date(u.atMs).toISOString().slice(11, 16) + ' UTC' : ''}: ${u.kind} ${u.title}${u.note ? ` (${u.note})` : ''}`);
  return rows.length ? `**Your next seven days**\n${rows.join('\n')}` : 'A clear week: nothing in your calendar for the next seven days.';
};
const recapText = r => (r && !r.empty ? `**${r.headline}**\n${r.lines.join('\n')}` : 'No recap yet: it appears after your first scored race.');
const badgesText = b => (b && b.earned.length ? `**Your badges (${b.earned.length})**\n${b.earned.map(x => `${x.icon} ${x.label}`).join('\n')}${b.next ? `\n\n${b.next.text}` : ''}` : `No badges yet: your first race earns one.${b && b.next ? `\n${b.next.text}` : ''}`);

module.exports = function createDiscordInteractions({ publicKey = () => process.env.DISCORD_PUBLIC_KEY || '', zwidOfDiscord, answer, coverClaim = null, lineupAction = null, commands = {}, now = () => Date.now() }) {
  const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
  const STATUS_LABEL = { yes: '✅ Yes', maybe: '🤔 Maybe', no: '❌ No' };

  function verify(raw, headers) {
    const key = publicKey(), sig = String(headers['x-signature-ed25519'] || ''), ts = String(headers['x-signature-timestamp'] || '');
    if (!/^[0-9a-fA-F]{64}$/.test(key) || !/^[0-9a-fA-F]{128}$/.test(sig) || !/^\d{9,14}$/.test(ts)) return false;
    // A signed request is only good for five minutes (Discord sends seconds; milliseconds are also read), so one captured on the way cannot be replayed later.
    const at = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
    if (Math.abs(now() - at) > 5 * 60000) return false;
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

  async function slash(it) {
    const reply = text => ({ status: 200, body: { type: 4, data: { content: cap(text), flags: 64 } } });
    const user = (it.member && it.member.user ? it.member.user : it.user || {}).id, name = String((it.data || {}).name || '');
    if (!user) return reply('I could not tell who you are.');
    const zwid = await zwidOfDiscord(user);
    if (!zwid) return reply('I could not tell who you are. Link your Discord in My Profile on the club dashboard first.');
    try {
      if (name === 'week' && commands.week) return reply(weekText(await commands.week(zwid)));
      if (name === 'recap' && commands.recap) return reply(recapText(await commands.recap(zwid)));
      if (name === 'badges' && commands.badges) return reply(badgesText(await commands.badges(zwid)));
      if (name === 'answer' && commands.answer) {
        const status = String(((it.data.options || []).find(o => o.name === 'status') || {}).value || '');
        if (!['yes', 'maybe', 'no'].includes(status)) return reply('Choose yes, maybe or no.');
        const done = await commands.answer(zwid, status);
        return reply(done ? `✔ You said **${STATUS_LABEL[status]}** for ${done.title} (${done.date}).` : 'Nothing is waiting for an answer from you right now.');
      }
    } catch (e) { return reply(`I could not do that: ${String((e && e.message) || 'something went wrong').slice(0, 160)}`); }
    return reply('I do not know that command.');
  }

  async function handle(raw, headers) {
    if (!verify(raw, headers)) return { status: 401, body: { error: 'invalid request signature' } };
    let it; try { it = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'invalid JSON' } }; }
    if (it.type === 1) return { status: 200, body: { type: 1 } };   // Discord's ping when the address is saved
    if (it.type === 2) return slash(it);
    if (it.type !== 3) return { status: 200, body: { type: 4, data: { content: 'Nothing to do here.', flags: 64 } } };
    const lu = /^lu\|(\d+)\|([^|]+)\|(approve|skip)$/.exec(String((it.data || {}).custom_id || ''));
    if (lu && lineupAction) {   // the captain's one-tap answer to a proposed line-up
      const who = (it.user || (it.member && it.member.user) || {}).id, say = text => ({ status: 200, body: { type: 4, data: { content: text, flags: 64 } } });
      const zw = who && await zwidOfDiscord(who);
      if (!zw) return say('I could not tell who you are. Link your Discord in My Profile on the club dashboard first.');
      try { const done = await lineupAction(zw, Number(lu[1]), lu[2], lu[3]); return { status: 200, body: { type: 7, data: { content: `${String(((it.message || {}).content) || '').split('\n\n✔')[0]}\n\n✔ ${done.text}`.slice(0, 1900), components: [] } } }; }
      catch (e) { return say(`I could not do that: ${String((e && e.message) || 'something went wrong').slice(0, 160)}`); }
    }
    const rc = /^rc\|([^|]+)\|(\d{4}-\d{2}-\d{2})\|(lead|sweep)$/.exec(String((it.data || {}).custom_id || ''));
    if (rc && coverClaim) {   // "I'll lead" / "I'll sweep" under a ride cover request
      const who = (it.user || (it.member && it.member.user) || {}).id, say = text => ({ status: 200, body: { type: 4, data: { content: text, flags: 64 } } });
      const zw = who && await zwidOfDiscord(who);
      if (!zw) return say('I could not tell who you are. Link your Discord in My Profile on the club dashboard first.');
      try {
        const done = await coverClaim(zw, rc[1], rc[2], rc[3]);
        return { status: 200, body: { type: 7, data: { content: `${String(((it.message || {}).content) || '').split('\n\n✔')[0]}\n\n✔ Thank you: you're down as ${done.role.toLowerCase()} for ${done.title} on ${done.date}.`.slice(0, 1900), components: [] } } };
      } catch (e) { return say(`I could not put you down: ${String((e && e.message) || 'something went wrong').slice(0, 160)}`); }
    }
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
  // Under a proposed line-up (sent to the captain): custom_id "lu|<week>|<team>|approve" or "|skip".
  const lineupButtons = (week, team) => [{ type: 1, components: [{ type: 2, style: 3, label: 'Approve line-up', custom_id: `lu|${week}|${team}|approve`.slice(0, 100) }, { type: 2, style: 2, label: 'No thanks, I will pick', custom_id: `lu|${week}|${team}|skip`.slice(0, 100) }] }];
  return { handle, verify, buttons, lineupButtons, COMMANDS };
};

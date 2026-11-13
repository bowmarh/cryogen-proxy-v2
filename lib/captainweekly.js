'use strict';
// A Sunday-evening direct message to each ZRL captain: how many of their riders have not yet answered for the coming race week, who they are, and where the one-tap
// "Ask the unanswered on Discord" button is. Once a week per captain and team; nothing is sent when everyone has answered or when the captain cannot be messaged.
module.exports = function createCaptainWeekly({ redis, zrl, notify = async () => false, siteUrl = '', now = () => Date.now() }) {
  const DONE = 'cg:captainweekly:sent';
  const week = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / 86400000 + 1) / 7)).padStart(2, '0')}`; };
  const dateOf = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * 86400000).toISOString().slice(0, 10);
  async function run(t = now()) {
    const d = new Date(t); if (d.getUTCDay() !== 0 || d.getUTCHours() < 17) return [];   // Sunday, from 17:00 UTC
    const data = await zrl.load(); if (!data.round) return [];
    const today = d.toISOString().slice(0, 10), next = Array.from({ length: data.round.weeks }, (_, i) => i).find(i => dateOf(data.round, i) >= today); if (next === undefined) return [];
    const weekly = await zrl.loadWeekly(), sent = [];
    for (const team of data.round.teams) {
      if (!team.captain) continue;
      const pool = data.signups.filter(x => x.in && x.zwid && (data.assign[x.key] || []).includes(team.id)), missing = pool.filter(x => !zrl.availOf(weekly, next, x.zwid, team.id));
      if (!missing.length) continue;
      const [fresh] = await redis([['HSETNX', DONE, `${week(t)}:${team.id}`, new Date(t).toISOString()]]); if (!fresh) continue;
      const names = missing.slice(0, 8).map(x => x.name).join(', ') + (missing.length > 8 ? ` and ${missing.length - 8} more` : '');
      const ok = await notify(String(team.captain), `🧢 ${team.name}: ${missing.length} of ${pool.length} riders have not answered for race ${next + 1} (${dateOf(data.round, next)}): ${names}. One tap in the app asks them all on Discord: ${siteUrl}/ → My team → "Ask the unanswered".`).catch(() => false);
      if (ok) sent.push(team.id); else await redis([['HDEL', DONE, `${week(t)}:${team.id}`]]);   // not reachable: try again at the next run tonight, not forever
    }
    return sent.length ? ['captain weekly'] : [];
  }
  return { run };
};

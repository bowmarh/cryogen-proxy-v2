'use strict';
// The public race-day board (a projector or an OBS browser source): what is racing in the next day, a countdown, how many starters are in the pen, and how
// each is going to run. Totals only: no rider names, no IDs, no answers. Team and event names are the same ones the public club page already shows.
const SERIES = { zrl: 'ZRL', ladder: 'Ladder', drs: 'DIRT Series', ttt: 'TTT' };

// events: the live module's list for the next day (see lib/live.js). now: ms.
function publicLive(events, now = Date.now()) {
  const list = (events || []).filter(e => Number.isFinite(e.at) && e.at - now > -45 * 60000).sort((a, b) => a.at - b.at).slice(0, 12).map(e => {
    const minutes = Math.round((e.at - now) / 60000), need = Number(e.need) || 0, ready = Number(e.ready) || 0;
    const phase = minutes > 60 ? 'later' : minutes > 0 ? 'pen' : 'racing';
    return { series: SERIES[e.kind] || String(e.kind || ''), title: String(e.title || ''), at: e.at, minutes, phase, need, ready, full: need > 0 && ready >= need };
  });
  return { generated: new Date(now).toISOString(), next: list.find(e => e.minutes > 0) || null, events: list };
}
module.exports = { publicLive };

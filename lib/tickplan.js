'use strict';
// Which scheduled jobs a tick runs. The workflow ticks every 15 minutes, but most jobs only need a look about once an hour. With ?speed=auto a tick
// runs everything when ANY of these holds, and otherwise only the jobs that must not wait:
//   - a full run has not happened for 55 minutes (so every job still runs at least hourly, even if GitHub runs a tick late);
//   - a race is within 90 minutes of starting, or has just started (pen reminders, no-show alerts and AI briefings work in short windows);
//   - there is no record yet of a full run.
// Without ?speed=auto (the daily Vercel run, a manual run, tests) every job runs, exactly as before.
const ALWAYS = ['Outbox', 'Usage', 'Comms'];   // queued Discord retries, the usage counters, scheduled posts
const FULL_EVERY_MS = 55 * 60000, WAKE_LEAD_MS = 90 * 60000;

function plan({ speed, now, state }) {
  if (speed !== 'auto') return { full: true, reason: 'not an automatic tick' };
  if (!state || !Number.isFinite(state.fullAt)) return { full: true, reason: 'no earlier full run on record' };
  if (now - state.fullAt >= FULL_EVERY_MS) return { full: true, reason: 'an hour since the last full run' };
  if (Number.isFinite(state.wake) && now >= state.wake) return { full: true, reason: 'a race is close' };
  return { full: false, reason: 'nothing is due' };
}
// The time the next race needs full ticks to start: 90 minutes before the earliest start that has not passed by more than 30 minutes.
function wakeFor(events, now) {
  const starts = (events || []).filter(e => Number.isFinite(e.minutes) && e.minutes > -30).map(e => now + e.minutes * 60000);
  return starts.length ? Math.min(...starts) - WAKE_LEAD_MS : null;
}
module.exports = { plan, wakeFor, ALWAYS, FULL_EVERY_MS, WAKE_LEAD_MS };

'use strict';
// "Ride On" for social rides: after a ride, a member who rode it can cheer the other riders who were on it (the same idea as the 👏 kudos
// on race results, and Strava's kudos). Rules:
//   - you must be signed in with your cryogen.team account, and have been GOING on that ride (a waitlist place does not count),
//   - you can only cheer riders who were going too, never yourself,
//   - from the day of the ride until 30 days after it, at most 10 per ride,
//   - one per rider per ride, and a second tap takes it back.
// Storage: one Redis hash, cg:rideon, field "<ride id>|<lower-case rider name>" -> JSON list of the Zwift IDs who cheered (so counts and "mine" are
// worked out without ever sending anyone's Zwift ID to the browser). Lives outside api/ on purpose (every file in api/ becomes a public function).
const ridecap = require('./ridecap');

const KEY = 'cg:rideon', WINDOW_DAYS = 30, PER_RIDE = 10, KEEP = 200, DAY = 86400000;
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
// Names are compared ignoring case and spacing, the same way RSVPs are keyed.
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
// A ride is in the Ride On window from its day until WINDOW_DAYS after it.
const inWindow = (date, today) => !!date && date <= today && daysBetween(date, today) <= WINDOW_DAYS;

// Whether `giverName` may cheer `toName` on this ride. Returns null when allowed, else { status, message }.
// `list` is the ride's RSVPs oldest first; `given` is how many riders this member has already cheered on the ride.
function check({ ride, list, giverName, toName, today, given }) {
  const { going } = ridecap.split(list, ridecap.maxOf(ride));
  const on = n => going.some(x => norm(x.name) === norm(n));
  const no = (status, message) => ({ status, message });
  if (!on(giverName)) return no(403, 'You can only give a Ride On on a ride you joined.');
  if (norm(giverName) === norm(toName)) return no(400, 'Ride On is for your fellow riders.');
  if (!on(toName)) return no(400, 'That rider was not on this ride.');
  if (ride.date > today) return no(400, 'Ride Ons open once the ride has started.');
  if (daysBetween(ride.date, today) > WINDOW_DAYS) return no(400, `Ride Ons close ${WINDOW_DAYS} days after the ride.`);
  if (given >= PER_RIDE) return no(429, `You have used all ${PER_RIDE} Ride Ons for this ride.`);
  return null;
}

module.exports = function createRideOn({ redis, HttpError, memberFromRequest, loadState }) {
  const signedIn = req => {
    const m = memberFromRequest(req);
    if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account to give Ride Ons.');
    return m;
  };
  const loadKudos = async () => {
    const [raw] = await redis([['HGETALL', KEY]]);
    return Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v) || []]));
  };

  const routes = {
    // The rides from the last 30 days the signed-in member was going on: who they can cheer, how many each rider has, and which they have given.
    // `received` is every Ride On the member got on rides in that window.
    'GET /api/rides/rideon': async req => {
      const m = signedIn(req), me = String(m.zwid), mine = norm(m.name), today = day();
      const [state, kud] = await Promise.all([loadState(), loadKudos()]);
      const rides = {}; let received = 0;
      for (const ride of state.rides || []) {
        if (!inWindow(ride.date, today)) continue;
        const { going } = ridecap.split(state.rsvps[ride.id], ridecap.maxOf(ride));
        received += (kud[`${ride.id}|${mine}`] || []).length;
        if (!going.some(x => norm(x.name) === mine)) continue;
        rides[ride.id] = {
          title: ride.title, date: ride.date, time: ride.time || '',
          riders: going.filter(x => norm(x.name) !== mine).map(x => { const g = kud[`${ride.id}|${norm(x.name)}`] || []; return { name: x.name, n: g.length, mine: g.includes(me) }; }),
        };
      }
      return { rides, received };
    },

    // Give a Ride On to a rider on a ride, or take it back. Returns that rider's new count.
    'POST /api/rides/rideon': async (req, body) => {
      const m = signedIn(req), me = String(m.zwid), today = day();
      const rideId = String(body.rideId || ''), to = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!/^[\w-]{1,40}$/.test(rideId) || !to) throw new HttpError(400, 'Pick a rider to cheer.');
      const state = await loadState(), ride = (state.rides || []).find(r => r.id === rideId);
      if (!ride) throw new HttpError(404, 'That ride was not found.');
      const kud = await loadKudos(), field = `${ride.id}|${norm(to)}`, had = (kud[field] || []).includes(me);
      // Taking one back is always allowed; giving one has to pass the rules.
      if (!had) {
        const given = Object.entries(kud).filter(([f, g]) => f.startsWith(`${ride.id}|`) && g.includes(me)).length;
        const bad = check({ ride, list: state.rsvps[ride.id], giverName: m.name, toName: to, today, given });
        if (bad) throw new HttpError(bad.status, bad.message);
      }
      const g = had ? kud[field].filter(x => x !== me) : [...(kud[field] || []), me].slice(-KEEP);
      await redis([g.length ? ['HSET', KEY, field, JSON.stringify(g)] : ['HDEL', KEY, field]]);
      return { n: g.length, mine: !had };
    },
  };

  return { routes, KEY };
};
module.exports.check = check;
module.exports.inWindow = inWindow;
module.exports.PER_RIDE = PER_RIDE;
module.exports.WINDOW_DAYS = WINDOW_DAYS;

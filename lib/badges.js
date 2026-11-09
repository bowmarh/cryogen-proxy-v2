'use strict';
// Badges: earned from numbers the club already has (the rider's roster record and their season), never stored, so they can never be out of date.
// A rider sees their own; nothing is shown to anyone else. The Studio's opt-in milestone posts (first win, podium, 10th/25th/50th race) are the only
// public shout-outs, and only for riders who said "OK to feature me".
const DEFS = [
  { id: 'first_race', icon: '🏁', label: 'First race', need: s => ({ have: Math.max(s.finishes, s.zrlPicked, s.tttWeeks), want: 1 }) },
  { id: 'races_10', icon: '🔟', label: '10 races', need: s => ({ have: s.finishes, want: 10 }) },
  { id: 'races_25', icon: '🚴', label: '25 races', need: s => ({ have: s.finishes, want: 25 }) },
  { id: 'races_50', icon: '🔥', label: '50 races', need: s => ({ have: s.finishes, want: 50 }) },
  { id: 'first_win', icon: '🥇', label: 'First win', need: s => ({ have: s.wins, want: 1 }) },
  { id: 'podium', icon: '🏆', label: 'On the podium', need: s => ({ have: Math.max(s.podiums, s.clubPodiums), want: 1 }) },
  { id: 'ever_present', icon: '📆', label: 'Raced every ZRL race', need: s => ({ have: s.zrlRaces >= 2 && s.zrlPicked === s.zrlRaces ? 1 : 0, want: 1 }) },
  { id: 'team_player', icon: '✅', label: 'Answered every ZRL week', need: s => ({ have: s.zrlWeeks && s.zrlAnswered === s.zrlWeeks ? 1 : 0, want: 1 }) },
  { id: 'social_rider', icon: '☕', label: 'Social rider', need: s => ({ have: s.rides, want: 1 }) },
  { id: 'ride_regular', icon: '🚲', label: '5 social rides', need: s => ({ have: s.rides, want: 5 }) },
  { id: 'ride_leader', icon: '🧭', label: 'Led a ride', need: s => ({ have: s.led, want: 1 }) },
  { id: 'sweeper', icon: '🧹', label: 'Swept a ride', need: s => ({ have: s.swept, want: 1 }) },
  { id: 'captain', icon: '🎖️', label: 'Team captain', need: s => ({ have: s.captain, want: 1 }) },
];

function facts(season, rider) {
  const race = (rider && rider.race) || {}, z = (season && season.zrl) || {}, t = (season && season.ttt) || {}, r = (season && season.rides) || {}, c = (season && season.cover) || {};
  const n = v => Number(v) || 0;
  return { finishes: n(race.finishes), wins: n(race.wins), podiums: n(race.podiums), clubPodiums: n(z.podiums) + n(t.podiums), zrlPicked: n(z.picked), zrlRaces: n(z.races), zrlWeeks: n(z.weeks), zrlAnswered: n(z.answered),
    tttWeeks: n(t.weeks), captain: n(t.captain), rides: n(r.attended), led: n(c.led), swept: n(c.swept) };
}

// { earned: [...], next: the nearest unearned badge with a count to go }
function badgesFrom(season, rider) {
  const f = facts(season, rider), all = DEFS.map(d => { const { have, want } = d.need(f); return { id: d.id, icon: d.icon, label: d.label, earned: have >= want, have: Math.min(have, want), want }; });
  const todo = all.filter(b => !b.earned && b.want > 1 && b.have > 0).sort((a, b) => (b.have / b.want) - (a.have / a.want))[0] || all.filter(b => !b.earned).sort((a, b) => a.want - b.want)[0] || null;
  return { earned: all.filter(b => b.earned), locked: all.filter(b => !b.earned), next: todo ? { ...todo, text: todo.want > 1 ? `${todo.want - todo.have} more for ${todo.label}` : `Next up: ${todo.label}` } : null };
}

module.exports = function createBadges({ HttpError, memberFromRequest, season, fetchRoster }) {
  return { badgesFrom, DEFS, routes: {
    'GET /api/me/badges': async req => {
      const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const [s, roster] = await Promise.all([season(m).catch(() => null), fetchRoster().catch(() => ({ riders: [] }))]);
      return badgesFrom(s, (roster.riders || []).find(x => String(x.riderId) === String(m.zwid)));
    },
  } };
};
module.exports.badgesFrom = badgesFrom;

'use strict';
// Social-ride capacity and the waitlist. RSVPs are stored oldest-first, and a ride has a `max` (default 25).
// The first `max` RSVPs are going; everyone after them is on the waitlist, in sign-up order. Nothing extra is stored:
// when a going rider cancels, the first waitlisted rider simply becomes the last going one.
// Pure functions only (no Redis, no clock), so every counter in the app can share the same rule.

const DEFAULT_MAX = 25;

// A ride's capacity, read the same way the browser does (`parseInt(ride.max) || 25`).
const maxOf = ride => parseInt(ride && ride.max, 10) || DEFAULT_MAX;

const lc = s => String(s == null ? '' : s).toLowerCase();

// RSVPs (oldest first) split into who is going and who is waiting.
function split(list, max) {
  const l = Array.isArray(list) ? list : [];
  const m = Math.max(0, parseInt(max, 10) || DEFAULT_MAX);
  return { going: l.slice(0, m), waitlist: l.slice(m) };
}

// 1-based place on the waitlist for `name`, or 0 when they are going (or not signed up at all).
function waitlistPlace(list, name, max) {
  const i = split(list, max).waitlist.findIndex(x => lc(x.name) === lc(name));
  return i < 0 ? 0 : i + 1;
}

// Who moves into a place when `name` cancels? Null when nobody does: the cancelling rider was not going,
// or nobody is waiting.
function promotedOnCancel(list, name, max) {
  const { going, waitlist } = split(list, max);
  if (!waitlist.length) return null;
  return going.some(x => lc(x.name) === lc(name)) ? waitlist[0] : null;
}

// Group raw RSVP hash fields ("<ride id>|<lowercase name>" -> JSON) by ride, oldest first.
function groupByRide(rsvpPairs) {
  const by = new Map();
  for (const [field, value] of rsvpPairs || []) {
    let entry; try { entry = JSON.parse(value); } catch (e) { continue; }
    if (!entry) continue;
    const id = String(field).slice(0, String(field).indexOf('|'));
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(entry);
  }
  for (const list of by.values()) list.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return by;
}

// Every RSVP that counts as a ride joined: [{ rideId, name }]. Waitlisted riders are left out. A ride that no longer
// exists cannot have a waitlist, so its RSVPs all count (the default capacity never applies to a missing ride).
// `ridesById` is a Map of ride id -> ride object.
function goingEntries(rsvpPairs, ridesById) {
  const out = [];
  for (const [rideId, list] of groupByRide(rsvpPairs)) {
    const ride = ridesById && ridesById.get(rideId);
    const kept = ride ? split(list, maxOf(ride)).going : list;
    for (const e of kept) out.push({ rideId, name: lc(e.name) });
  }
  return out;
}

module.exports = { DEFAULT_MAX, maxOf, split, waitlistPlace, promotedOnCancel, groupByRide, goingEntries };

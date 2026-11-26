'use strict';
// The weekly club news line (the Notion / Spotify "your week in review" idea): once a week, on Monday morning UTC, one line goes into the notification bell
// saying what the club did in the last seven days. Built from the results already stored; nothing is posted if nobody finished a race, and a week is only ever
// posted once (a key per Monday), however often the scheduler runs.
module.exports = function createClubDigest({ redis, clubResults, feed, fromHour = 7 }) {
  const KEY = 'cg:clubdigest:sent';
  const first = n => String(n || '').replace(/\s*[\[(].*$/, '').trim().split(/\s+/)[0] || 'A rider';
  const ord = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
  const mondayOf = now => { const d = new Date(now), back = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10); };
  async function compose(now) {
    const from = (now - 7 * 864e5) / 1000, evs = (await clubResults.list(60)).filter(e => e.time && e.time >= from && e.time <= now / 1000 + 3600);
    const rows = evs.flatMap(e => e.riders.map(r => ({ ...r, p: r.catPos || r.pos })));
    if (!rows.length) return '';
    const riders = new Set(rows.map(r => r.zwid)).size, podiums = rows.filter(r => r.p && r.p <= 3).length, best = rows.filter(r => r.p).sort((a, b) => a.p - b.p)[0];
    let line = `Last week: ${rows.length} finish${rows.length === 1 ? '' : 'es'} from ${riders} rider${riders === 1 ? '' : 's'}`;
    if (podiums) line += `, ${podiums} podium${podiums === 1 ? '' : 's'}`;
    line += '.';
    if (best) line += ` Best: ${first(best.name)} (${ord(best.p)}).`;
    try { const c = (await clubResults.leaderboard(now)).challenge; if (c && c.goal) line += ` Club challenge: ${c.done}/${c.goal}.`; } catch (e) { /* the line is fine without it */ }
    return line;
  }
  async function runSchedule(now = Date.now()) {
    if (new Date(now).getUTCHours() < fromHour) return [];
    const week = mondayOf(now), [claimed] = await redis([['HSETNX', KEY, week, new Date(now).toISOString()]]);
    if (!claimed) return [];
    const text = await compose(now);
    if (!text) return [];
    await feed.add('news', { content: text });
    return [text];
  }
  return { runSchedule, compose, mondayOf };
};

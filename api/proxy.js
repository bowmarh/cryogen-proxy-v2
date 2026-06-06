const BASE      = "https://api.zwiftracing.app/api";
const ZRA_KEY   = process.env.ZRA_API_KEY  || "63e32b2550a0742a4aa04923";
const ZRA_KEY_2 = process.env.ZRA_API_KEY_2;
const ZP_TEAM   = "2740";   // ZwiftPower team ID
const ZWIFT_CLUB = "2470";  // Zwift club ID
const SHEET_ID  = "1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw";
const SHEET_GID = "1775447215";

const KEYS = [ZRA_KEY, ZRA_KEY_2].filter(Boolean);
let memCache = { team: null, ts: 0 };

function extractEvents(obj, depth=0) {
  if (depth > 6 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && (obj[0].eventStart || obj[0].name || obj[0].eventName || obj[0].id)) return obj;
    for (const item of obj) { const f = extractEvents(item, depth+1); if (f) return f; }
    return null;
  }
  for (const key of ["events","items","data","results","list","upcoming","pageProps","props","content"]) {
    if (obj[key]) { const f = extractEvents(obj[key], depth+1); if (f) return f; }
  }
  return null;
}

async function fetchTeam() {
  for (let i = 0; i < KEYS.length; i++) {
    const r = await fetch(`${BASE}/public/clubs/${ZP_TEAM}/0`, { headers: { "Authorization": KEYS[i] } });
    if (r.status === 429) continue;
    if (!r.ok) throw new Error(`ZRA ${r.status}`);
    return await r.json();
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { endpoint } = req.query;

  try {

    // ── ZwiftRacing.app roster ───────────────────────────
    if (endpoint === "team") {
      const age = (Date.now() - memCache.ts) / 1000;
      if (memCache.team && age < 660) {
        res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
        return res.status(200).json(memCache.team);
      }
      const data = await fetchTeam();
      if (!data) {
        if (memCache.team) return res.status(200).json(memCache.team);
        return res.status(429).json({ error: "Rate limited", retryAfter: 600, windowMinutes: 10 });
      }
      memCache = { team: data, ts: Date.now() };
      res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
      return res.status(200).json(data);
    }

    // ── Zwift Club Events (direct Zwift API) ─────────────
    if (endpoint === "events") {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

      const headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
      };

      // Try Zwift's public club events endpoints
      const attempts = [
        `https://us-or-rly101.zwift.com/api/clubs/${ZWIFT_CLUB}/events/upcoming`,
        `https://us-or-rly101.zwift.com/api/clubs/${ZWIFT_CLUB}/events`,
        `https://us-or-rly101.zwift.com/api/public/events?organizer_id=${ZWIFT_CLUB}&limit=20`,
        `https://us-or-rly101.zwift.com/api/public/events?club_id=${ZWIFT_CLUB}&limit=20`,
        `https://api.zwift.com/api/clubs/${ZWIFT_CLUB}/events`,
        `https://us-or-rly101.zwift.com/api/public/events?organizerId=${ZWIFT_CLUB}`,
      ];

      for (const url of attempts) {
        try {
          const r = await fetch(url, { headers });
          if (r.ok) {
            const ct = r.headers.get("content-type") || "";
            if (ct.includes("json")) {
              const data = await r.json();
              const events = Array.isArray(data) ? data : extractEvents(data);
              if (events && events.length > 0) {
                return res.status(200).json({ source: "zwift", url, events });
              }
            }
          }
        } catch(e) { /* try next */ }
      }

      // Fallback: ZwiftPower events
      try {
        const r = await fetch(
          `https://zwiftpower.com/api3.php?do=team_events&id=${ZP_TEAM}`,
          { headers: { ...headers, "Referer": "https://zwiftpower.com" } }
        );
        if (r.ok) {
          const data = await r.json();
          const events = Array.isArray(data) ? data : extractEvents(data);
          if (events && events.length > 0) {
            return res.status(200).json({ source: "zwiftpower", events });
          }
        }
      } catch(e) { /* ZwiftPower also failed */ }

      return res.status(404).json({
        error: "Could not fetch Zwift club events",
        tried: attempts.length + 1,
        hint: "Zwift API may require authentication — events may need admin-only OAuth token"
      });
    }

    // ── Team results ──────────────────────────────────────
    if (endpoint === "results") {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
      try {
        const r = await fetch(`${BASE}/public/clubs/${ZP_TEAM}/results`,
          { headers: { "Authorization": KEYS[0] } });
        if (r.ok) return res.status(200).json(await r.json());
      } catch(e) {}
      if (memCache.team?.riders) {
        const recent = memCache.team.riders
          .filter(r => r.race?.last?.date)
          .sort((a,b) => b.race.last.date - a.race.last.date)
          .slice(0,20)
          .map(r => ({
            riderId: r.riderId, name: r.name,
            date: r.race.last.date,
            rating: r.race.last.rating,
            category: r.race.last.mixed?.category,
            wins: r.race.wins||0, podiums: r.race.podiums||0, finishes: r.race.finishes||0,
          }));
        return res.status(200).json({ source: "derived", results: recent });
      }
      return res.status(404).json({ error: "No results available" });
    }

    // ── Google Sheets ─────────────────────────────────────
    if (endpoint === "ttt-sheet") {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=30");
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) return res.status(r.status).json({ error: `Sheet ${r.status}` });
      const csv = await r.text();
      const lines = csv.trim().split("\n").map(l => l.split(",").map(c => c.replace(/^"|"$/g,"").trim()));
      const headers = lines[0];
      const rows = lines.slice(1).filter(r => r.some(c=>c))
        .map(row => Object.fromEntries(headers.map((h,i)=>[h,row[i]||""])));
      return res.status(200).json({ headers, rows, count: rows.length });
    }

    res.status(400).json({ error: "Unknown endpoint", endpoint });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};

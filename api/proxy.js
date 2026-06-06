const BASE      = "https://api.zwiftracing.app/api";
const ZRA_KEY   = process.env.ZRA_API_KEY  || "63e32b2550a0742a4aa04923";
const ZRA_KEY_2 = process.env.ZRA_API_KEY_2;
const TEAM_ID   = "2740";
const SHEET_ID  = "1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw";
const SHEET_GID = "1775447185";
const ZWIFTHACKS_KEY = "6a24978d28168";

const KEYS = [ZRA_KEY, ZRA_KEY_2].filter(Boolean);
let memCache = { team: null, ts: 0 };

async function fetchTeam() {
  for (let i = 0; i < KEYS.length; i++) {
    const r = await fetch(`${BASE}/public/clubs/${TEAM_ID}/0`,
      { headers: { "Authorization": KEYS[i] } });
    if (r.status === 429) { continue; }
    if (!r.ok) throw new Error(`ZRA ${r.status}`);
    return await r.json();
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { endpoint } = req.query;

  try {

    // ── Team roster ──────────────────────────────────────
    if (endpoint === "team") {
      const age = (Date.now() - memCache.ts) / 1000;
      if (memCache.team && age < 660) {
        res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(memCache.team);
      }
      const data = await fetchTeam();
      if (!data) {
        if (memCache.team) {
          res.setHeader("X-Cache", "STALE");
          return res.status(200).json(memCache.team);
        }
        return res.status(429).json({ error: "Rate limited", retryAfter: 600, windowMinutes: 10 });
      }
      memCache = { team: data, ts: Date.now() };
      res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
      return res.status(200).json(data);
    }

    // ── Recent team results from ZwiftRacing.app ─────────
    if (endpoint === "results") {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
      // Try team results endpoint
      const r = await fetch(`${BASE}/public/clubs/${TEAM_ID}/results`,
        { headers: { "Authorization": KEYS[0] } });
      if (r.ok) {
        const data = await r.json();
        return res.status(200).json(data);
      }
      // Fallback: derive recent activity from roster data
      // Use cached team data if available to extract last race info
      if (memCache.team && memCache.team.riders) {
        const recent = memCache.team.riders
          .filter(r => r.race?.last?.date)
          .sort((a, b) => b.race.last.date - a.race.last.date)
          .slice(0, 20)
          .map(r => ({
            riderId: r.riderId,
            name: r.name,
            date: r.race.last.date,
            rating: r.race.last.rating,
            category: r.race.last.mixed?.category,
            wins: r.race.wins || 0,
            podiums: r.race.podiums || 0,
            finishes: r.race.finishes || 0,
          }));
        return res.status(200).json({ source: "derived", results: recent });
      }
      return res.status(404).json({ error: "No results available yet" });
    }

    // ── ZwiftHacks club events ────────────────────────────
    if (endpoint === "events") {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
      const now   = new Date();
      const today = now.toISOString().split("T")[0];
      const next7 = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];

      // Try ZwiftHacks events API with the key
      const urls = [
        `https://zwifthacks.com/api/events/?sport=cycling&start=${today}&end=${next7}&key=${ZWIFTHACKS_KEY}`,
        `https://www.zwifthacks.com/api/events/?sport=cycling&start=${today}&key=${ZWIFTHACKS_KEY}`,
        `https://zwifthacks.com/api/events/?start=${today}&key=${ZWIFTHACKS_KEY}`,
      ];

      for (const url of urls) {
        try {
          const r = await fetch(url, {
            headers: { "Accept": "application/json", "User-Agent": "CRYO-GEN-App/1.0" }
          });
          if (r.ok) {
            const ct = r.headers.get("content-type") || "";
            if (ct.includes("json")) {
              const data = await r.json();
              return res.status(200).json({ source: url, data });
            }
          }
        } catch(e) { /* try next */ }
      }
      return res.status(404).json({ error: "Events not available", hint: "ZwiftHacks API format may have changed" });
    }

    // ── Google Sheets ─────────────────────────────────────
    if (endpoint === "ttt-sheet") {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=30");
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) return res.status(r.status).json({ error: `Sheet ${r.status}` });
      const csv = await r.text();
      const lines = csv.trim().split("\n").map(l =>
        l.split(",").map(c => c.replace(/^"|"$/g,"").trim()));
      const headers = lines[0];
      const rows = lines.slice(1).filter(r=>r.some(c=>c))
        .map(row => Object.fromEntries(headers.map((h,i)=>[h,row[i]||""])));
      return res.status(200).json({ headers, rows, count: rows.length });
    }

    res.status(400).json({ error: "Unknown endpoint", endpoint });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

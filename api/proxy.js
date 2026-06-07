const BASE       = "https://api.zwiftracing.app/api";
const ZRA_KEY    = process.env.ZRA_API_KEY  || "63e32b2550a0742a4aa04923";
const ZRA_KEY_2  = process.env.ZRA_API_KEY_2;
const ZP_TEAM    = "2740";
const SHEET_ID   = "1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw";
const SHEET_GID  = "1775447185";
const RIDES_URL  = process.env.RIDES_SCRIPT_URL; // Google Apps Script web app URL

const KEYS = [ZRA_KEY, ZRA_KEY_2].filter(Boolean);
let memCache = { team: null, ts: 0 };

async function fetchTeam() {
  for (const key of KEYS) {
    const r = await fetch(`${BASE}/public/clubs/${ZP_TEAM}/0`, { headers: { Authorization: key } });
    if (r.status === 429) continue;
    if (!r.ok) throw new Error(`ZRA ${r.status}`);
    return r.json();
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
        return res.status(429).json({ error: "Rate limited", retryAfter: 600 });
      }
      memCache = { team: data, ts: Date.now() };
      res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
      return res.status(200).json(data);
    }

    // ── Club rides from Google Apps Script ───────────────
    if (endpoint === "rides") {
      if (!RIDES_URL) {
        return res.status(404).json({ error: "RIDES_SCRIPT_URL not set in Vercel env vars. Add it in Vercel → Settings → Environment Variables." });
      }
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=60");
      const r = await fetch(RIDES_URL, { redirect: "follow" });
      const text = await r.text();
      // Check if Google returned a login page instead of JSON
      if (text.trim().startsWith("<")) {
        return res.status(401).json({
          error: "Script returned HTML — re-deploy with: Execute as = Me, Who has access = Anyone",
          hint: "In Apps Script: Deploy → Manage deployments → Edit → set access to Anyone (not Google account)"
        });
      }
      try {
        const data = JSON.parse(text);
        return res.status(200).json(data);
      } catch(e) {
        return res.status(500).json({ error: "Invalid JSON from script: " + text.substring(0, 100) });
      }
    }

    // ── Google Sheets TTT data ───────────────────────────
    if (endpoint === "ttt-sheet") {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=30");
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) return res.status(r.status).json({ error: `Sheet ${r.status}` });
      const csv = await r.text();
      const lines = csv.trim().split("\n").map(l => l.split(",").map(c => c.replace(/^"|"$/g,"").trim()));
      const headers = lines[0];
      const rows = lines.slice(1).filter(r => r.some(c=>c))
        .map(row => Object.fromEntries(headers.map((h,i) => [h, row[i]||""])));
      return res.status(200).json({ headers, rows, count: rows.length });
    }

    // ── Derived results from roster cache ────────────────
    if (endpoint === "results") {
      res.setHeader("Cache-Control", "s-maxage=300");
      if (memCache.team?.riders) {
        const recent = memCache.team.riders
          .filter(r => r.race?.last?.date)
          .sort((a,b) => b.race.last.date - a.race.last.date)
          .slice(0,15)
          .map(r => ({
            name: r.name, date: r.race.last.date,
            rating: r.race.last.rating,
            category: r.race.last.mixed?.category,
            wins: r.race.wins||0, podiums: r.race.podiums||0, finishes: r.race.finishes||0,
          }));
        return res.status(200).json({ source: "derived", results: recent });
      }
      return res.status(404).json({ error: "No cached data yet" });
    }

    res.status(400).json({ error: "Unknown endpoint" });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};

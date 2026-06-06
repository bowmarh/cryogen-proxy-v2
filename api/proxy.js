const BASE    = "https://api.zwiftracing.app/api";
const ZRA_KEY = process.env.ZRA_API_KEY || "63e32b2550a0742a4aa04923";
const TEAM_ID = "2740";
const SHEET_ID  = "1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw";
const SHEET_GID = "1775447185";

// In-memory cache to survive rate limits within same serverless instance
let memCache = { data: null, ts: 0 };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { endpoint } = req.query;

  try {

    // ── Team roster ──────────────────────────────────────
    if (endpoint === "team") {
      // Serve from memory cache if fresh (< 11 minutes)
      const age = (Date.now() - memCache.ts) / 1000;
      if (memCache.data && age < 660) {
        res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
        res.setHeader("X-Cache", "HIT");
        res.status(200).json(memCache.data);
        return;
      }

      const r = await fetch(
        `${BASE}/public/clubs/${TEAM_ID}/0`,
        { headers: { "Authorization": ZRA_KEY } }
      );

      if (r.status === 429) {
        const retry = r.headers.get("Retry-After") || "600";
        // Return stale cache if we have it
        if (memCache.data) {
          res.setHeader("Cache-Control", "s-maxage=60");
          res.setHeader("X-Cache", "STALE");
          res.status(200).json(memCache.data);
        } else {
          res.status(429).json({
            error: "Too many requests",
            retryAfter: parseInt(retry),
            windowMinutes: 10,
            limit: 1
          });
        }
        return;
      }

      if (!r.ok) {
        res.status(r.status).json({ error: `ZRA returned ${r.status}` });
        return;
      }

      const data = await r.json();
      memCache = { data, ts: Date.now() };
      res.setHeader("Cache-Control", "s-maxage=660, stale-while-revalidate=120");
      res.setHeader("X-Cache", "MISS");
      res.status(200).json(data);
      return;
    }

    // ── Google Sheets TTT ────────────────────────────────
    if (endpoint === "ttt-sheet") {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=30");
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) {
        res.status(r.status).json({ error: `Sheet fetch failed: ${r.status}` });
        return;
      }
      const csv = await r.text();
      const lines = csv.trim().split("\n").map(l =>
        l.split(",").map(c => c.replace(/^"|"$/g, "").trim())
      );
      const headers = lines[0];
      const rows = lines.slice(1).filter(r => r.some(c => c)).map(row =>
        Object.fromEntries(headers.map((h, i) => [h, row[i] || ""]))
      );
      res.status(200).json({ headers, rows, count: rows.length });
      return;
    }

    res.status(400).json({ error: "Unknown endpoint", endpoint });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

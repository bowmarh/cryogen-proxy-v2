const BASE = "https://api.zwiftracing.app/api";
const ZRA_KEY = process.env.ZRA_API_KEY || "63e32b2550a0742a4aa04923";
const TEAM_ID = "2740";
const SHEET_ID = "1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw";
const SHEET_GID = "1775447185";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { endpoint } = req.query;

  try {
    // ── ZwiftRacing.app team roster ──────────────────────
    if (endpoint === "team") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=60");
      const r = await fetch(
        `${BASE}/public/clubs/${TEAM_ID}/0`,
        { headers: { "Authorization": ZRA_KEY } }
      );
      if (!r.ok) {
        res.status(r.status).json({ error: `ZRA returned ${r.status}` });
        return;
      }
      const data = await r.json();
      res.status(200).json(data);
      return;
    }

    // ── Google Sheets TTT data ────────────────────────────
    if (endpoint === "ttt-sheet") {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=30");
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) {
        res.status(r.status).json({ error: `Sheet fetch failed: ${r.status}` });
        return;
      }
      const csv = await r.text();
      // Parse CSV into rows
      const lines = csv.trim().split("\n").map(l =>
        l.split(",").map(c => c.replace(/^"|"$/g, "").trim())
      );
      const headers = lines[0];
      const rows = lines.slice(1).map(row =>
        Object.fromEntries(headers.map((h, i) => [h, row[i] || ""]))
      );
      res.status(200).json({ headers, rows });
      return;
    }

    // ── ZwiftPower stub (pending engineering access) ──────
    if (endpoint === "zpteam") {
      res.status(202).json({ error: "ZwiftPower access pending", stub: true });
      return;
    }

    res.status(400).json({ error: "Unknown endpoint", endpoint });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

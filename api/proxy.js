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

// Recursively search parsed JSON for an events array
function extractEvents(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    // Check if this looks like an events array
    if (obj.length > 0 && obj[0] && (obj[0].eventStart || obj[0].name || obj[0].eventName)) {
      return obj;
    }
    for (const item of obj) {
      const found = extractEvents(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Check common event container keys
  for (const key of ["events", "items", "data", "results", "list", "upcoming", "pageProps", "props"]) {
    if (obj[key]) {
      const found = extractEvents(obj[key], depth + 1);
      if (found) return found;
    }
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
      const ZH_URL = "https://zwifthacks.com/app/events/?key=" + ZWIFTHACKS_KEY;

      // Step 1: Fetch the ZwiftHacks page HTML
      const page = await fetch(ZH_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        }
      });
      const html = await page.text();

      // Step 2: Look for embedded JSON data (Next.js, Nuxt, inline state)
      const patterns = [
        { name: "next",  re: /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/ },
        { name: "nuxt",  re: /window\.__NUXT__\s*=\s*([\s\S]*?);\s*<\/script>/ },
        { name: "state", re: /window\.__STATE__\s*=\s*([\s\S]*?);\s*<\/script>/ },
        { name: "data",  re: /window\.initialData\s*=\s*([\s\S]*?);\s*<\/script>/ },
      ];

      for (const { name, re } of patterns) {
        const m = html.match(re);
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            // Dig into common structures to find events array
            const events = extractEvents(parsed);
            if (events && events.length > 0) {
              return res.status(200).json({ source: name, events });
            }
            // Return raw if we can't extract events but found data
            return res.status(200).json({ source: name, raw: parsed });
          } catch(e) { /* try next pattern */ }
        }
      }

      // Step 3: Check if page itself returned JSON
      try {
        const json = JSON.parse(html);
        const events = extractEvents(json);
        return res.status(200).json({ source: "json", events: events || json });
      } catch(e) { /* not json */ }

      // Step 4: Return page excerpt for debugging
      return res.status(200).json({
        source: "debug",
        pageLength: html.length,
        hasScript: html.includes("<script"),
        hint: "ZwiftHacks is a client-side SPA - event data loads after page render. See pagePreview.",
        pagePreview: html.substring(0, 500),
      });
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

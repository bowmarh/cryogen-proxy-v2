// api/proxy.js — CRYO-GEN API Proxy
// Endpoints confirmed from zpdatafetch source code:
//   Base:    https://api.zwiftracing.app/api
//   Team:    /public/clubs/{id}/0
//   Rider:   /public/riders/{id}
//   Results: /public/results/{id}
//   Batch:   POST /public/riders

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")    return res.status(405).json({ error: "Method not allowed" });

  const KEY     = process.env.ZRA_API_KEY || "63e32b2550a0742a4aa04923";
  const TEAM_ID = "2740";
  const BASE    = "https://api.zwiftracing.app/api";

  // Route
  const { endpoint = "team" } = req.query;

  let url;
  if (endpoint === "team") {
    // /public/clubs/{id}/0  — the trailing 0 is the rider offset
    url = `${BASE}/public/clubs/${TEAM_ID}/0`;
  } else if (endpoint === "rider") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing ?id= for rider endpoint" });
    url = `${BASE}/public/riders/${id}`;
  } else if (endpoint === "result") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing ?id= for result endpoint" });
    url = `${BASE}/public/results/${id}`;
  } else {
    return res.status(400).json({ error: `Unknown endpoint "${endpoint}". Use team, rider, or result.` });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        // Key used raw — no Bearer prefix (confirmed from source)
        Authorization: KEY,
        Accept:        "application/json",
        "User-Agent":  "CRYOGEN-Club-App/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    const text = await upstream.text();

    // Try to return JSON; fall back to raw text with debug info
    try {
      const json = JSON.parse(text);
      if (upstream.ok) {
        res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
      }
      return res.status(upstream.status).json(json);
    } catch {
      // Not JSON — return debug info so we can see what happened
      return res.status(upstream.status).json({
        error:       "Upstream returned non-JSON",
        http_status: upstream.status,
        url,
        preview:     text.slice(0, 500),
      });
    }

  } catch (err) {
    return res.status(502).json({ error: err.message, url });
  }
}

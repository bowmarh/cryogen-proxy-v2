// api/proxy.js  — DIAGNOSTIC VERSION
// Visit: https://cryogen-proxy-v2.vercel.app/api/proxy
// This will try every known endpoint + auth format and show what works.
// Replace with the production version once we know the correct combination.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const KEY     = process.env.ZRA_API_KEY || "63e32b2550a0742a4aa04923";
  const TEAM_ID = "2740";

  // Every known endpoint format from community research
  const ENDPOINTS = [
    `https://www.zwiftracing.app/api/clubs/${TEAM_ID}/riders`,
    `https://www.zwiftracing.app/api/teams/${TEAM_ID}/riders`,
    `https://zwift-ranking.herokuapp.com/public/clubs/${TEAM_ID}/riders`,
    `https://zwift-ranking.herokuapp.com/public/teams/${TEAM_ID}/riders`,
    `https://www.zwiftracing.app/api/club/${TEAM_ID}/riders`,
    `https://www.zwiftracing.app/clubs/${TEAM_ID}/riders`,
  ];

  // Every known auth header format
  const AUTH_FORMATS = [
    KEY,
    `Bearer ${KEY}`,
    `Token ${KEY}`,
    `Api-Key ${KEY}`,
  ];

  const results = [];

  for (const url of ENDPOINTS) {
    for (const auth of AUTH_FORMATS) {
      try {
        const upstream = await fetch(url, {
          headers: {
            Authorization: auth,
            Accept:        "application/json",
            "User-Agent":  "CRYOGEN-Club-App/1.0",
          },
          signal: AbortSignal.timeout(6000),
        });

        const text        = await upstream.text();
        const isJson      = upstream.headers.get("content-type")?.includes("json");
        const preview     = text.slice(0, 300);
        const looksRight  = isJson && upstream.status === 200;

        results.push({
          url,
          auth:        auth.startsWith("Bearer") ? "Bearer KEY" : auth.startsWith("Token") ? "Token KEY" : auth.startsWith("Api") ? "Api-Key KEY" : "KEY only",
          status:      upstream.status,
          contentType: upstream.headers.get("content-type"),
          isJson,
          looksRight,
          preview,
        });

        // Stop early if we found a winner
        if (looksRight) {
          return res.status(200).json({
            winner: { url, auth: auth.startsWith("Bearer") ? "Bearer KEY" : "KEY only" },
            data:   JSON.parse(text),
          });
        }

      } catch (err) {
        results.push({ url, auth: auth.slice(0, 10) + "…", error: err.message });
      }
    }
  }

  // No winner — return all results so we can see what happened
  return res.status(200).json({ winner: null, results });
}

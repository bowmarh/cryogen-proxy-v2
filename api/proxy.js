// api/proxy.js - Vercel Serverless Function (Node.js)
export default async function handler(req, res) {
  // Set CORS headers so your HTML portal can access it from anywhere
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { endpoint } = req.query;
  const ZRA_KEY = process.env.ZRA_API_KEY || '63e32b2550a0742a4aa04923'; // Set in Vercel Environment Variables

  try {
    // 1. Route: Team Roster from ZwiftRacing.app
    if (endpoint === 'team') {
      const zraRes = await fetch('https://api.zwiftracing.app/api/public/clubs/2740/0', {
        headers: {
          'Authorization': ZRA_KEY,
          'Accept': 'application/json',
          'User-Agent': 'CRYO-GEN/1.0 (+https://cryogen.team)'
        }
      });
      if (!zraRes.ok) throw new Error(`ZRA returned ${zraRes.status}`);
      const data = await zraRes.json();
      return res.status(200).json(data);
    }

    // 2. Route: Recent Results from ZwiftRacing.app
    if (endpoint === 'results') {
      const zraRes = await fetch('https://api.zwiftracing.app/api/public/clubs/2740/results', {
        headers: {
          'Authorization': ZRA_KEY,
          'Accept': 'application/json',
          'User-Agent': 'CRYO-GEN/1.0 (+https://cryogen.team)'
        }
      });
      if (!zraRes.ok) {
        // Fallback if results endpoint is empty
        return res.status(200).json({ results: [], derived: [] });
      }
      const data = await zraRes.json();
      return res.status(200).json(data);
    }

    // 3. Route: Social Rides from Google Sheets CSV
    if (endpoint === 'rides') {
      const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT1-example/pub?gid=0&single=true&output=csv';
      const csvRes = await fetch(SHEET_CSV_URL);
      if (!csvRes.ok) return res.status(200).json({ rides: [] });
      
      const csvText = await csvRes.text();
      const lines = csvText.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      
      const rides = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] || ''; });
        return row;
      });

      return res.status(200).json({ rides, updated: new Date().toISOString() });
    }

    return res.status(400).json({ error: `Unknown or missing endpoint: ${endpoint}` });

  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
}
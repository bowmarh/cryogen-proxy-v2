// api/proxy.js

// 1. Explicitly configure the Vercel maximum duration (up to 300s on Hobby tier)
export const config = {
  maxDuration: 60, // Set to 60 seconds
};

export default async function handler(req, res) {
  // CORS Headers for secure cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Pre-flight request handling
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint } = req.query;
  const ZRA_KEY = process.env.ZRA_API_KEY || '63e32b2550a0742a4aa04923';

  // 2. Fail-Fast Mechanism: Prevent infinite hangs with AbortController
  // Space Complexity: O(1)
  // Time Complexity: O(1) initialization
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 25000); // 25-second explicit timeout

  try {
    // Route 1: Team Roster
    if (endpoint === 'team') {
      const zraRes = await fetch('https://api.zwiftracing.app/api/public/clubs/2740/0', {
        signal: controller.signal,
        headers: {
          'Authorization': ZRA_KEY,
          'Accept': 'application/json',
          'User-Agent': 'CRYO-GEN/1.0 (+https://cryogen.team)'
        }
      });
      clearTimeout(fetchTimeout); // Clean up timeout on success

      if (!zraRes.ok) {
         throw new Error(`ZRA API Error: ${zraRes.status} ${zraRes.statusText}`);
      }
      
      const data = await zraRes.json();
      return res.status(200).json(data);
    }

    // Route 2: Recent Results
    if (endpoint === 'results') {
      const zraRes = await fetch('https://api.zwiftracing.app/api/public/clubs/2740/results', {
        signal: controller.signal,
        headers: {
          'Authorization': ZRA_KEY,
          'Accept': 'application/json',
          'User-Agent': 'CRYO-GEN/1.0 (+https://cryogen.team)'
        }
      });
      clearTimeout(fetchTimeout);

      if (!zraRes.ok) {
        return res.status(200).json({ results: [], derived: [] }); // Graceful degradation
      }
      const data = await zraRes.json();
      return res.status(200).json(data);
    }

    // Route 3: Rides from Google Sheets
    if (endpoint === 'rides') {
      const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT1-example/pub?gid=0&single=true&output=csv';
      const csvRes = await fetch(SHEET_CSV_URL, { signal: controller.signal });
      clearTimeout(fetchTimeout);

      if (!csvRes.ok) throw new Error(`Google Sheets Error: ${csvRes.status}`);
      
      const csvText = await csvRes.text();
      const lines = csvText.trim().split('\n');
      
      if (lines.length < 2) return res.status(200).json({ rides: [] });

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      
      // Time Complexity: O(N * M) where N = rows, M = columns
      const rides = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] || ''; });
        return row;
      });

      return res.status(200).json({ rides, updated: new Date().toISOString() });
    }

    // Unhandled endpoint
    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

  } catch (error) {
    // 3. Robust Error Handling
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream API timed out after 25 seconds.' });
    }
    return res.status(502).json({ error: 'Bad Gateway: ' + error.message });
  } finally {
    clearTimeout(fetchTimeout); // Ensure garbage collection
  }
}

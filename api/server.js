const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'api'); // the repository has the HTML under api/api/

// Map logical endpoints used by the frontend to real upstream URLs.
// Update these to point at your real Google Sheet / JSON endpoints.
const ENDPOINT_MAP = {
  rides: 'https://docs.google.com/spreadsheets/d/YOUR_SHEET/gviz/tq?tqx=out:json&sheet=Social%20Rides',
  'ttt-sheet': 'https://docs.google.com/spreadsheets/d/YOUR_SHEET/gviz/tq?tqx=out:json&sheet=TTT',
};

function sendJSON(res, statusCode, obj){
  const s = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(s);
}

function proxyFetch(targetUrl, res){
  try{
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = { method: 'GET', headers: { 'User-Agent': 'cryogen-proxy/1.0' } };
    const req = lib.request(targetUrl, opts, upstreamRes => {
      const chunks = [];
      upstreamRes.on('data', c => chunks.push(c));
      upstreamRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, upstreamRes.headers, { 'access-control-allow-origin': '*' });
        // Forward as-is but ensure we don't accidentally forward hop-by-hop headers that cause problems.
        delete headers['transfer-encoding'];
        res.writeHead(upstreamRes.statusCode || 200, headers);
        res.end(body);
      });
    });
    req.on('error', err => {
      sendJSON(res, 502, { error: 'Upstream request failed', message: err.message });
    });
    req.end();
  } catch (err) {
    sendJSON(res, 500, { error: 'Invalid URL', message: err.message });
  }
}

// Admin/moderator passwords come from environment variables, never from the page source.
const ROLE_PASSWORD_ENV = { admin: 'ADMIN_PASSWORD', mod: 'MOD_PASSWORD' };

function passwordMatches(given, expected){
  // Compare hashes so the comparison is constant-time regardless of input length.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function handleLogin(req, res){
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
    const envName = ROLE_PASSWORD_ENV[payload.role];
    if (!envName){
      sendJSON(res, 400, { error: 'unknown role' });
      return;
    }
    const expected = process.env[envName];
    if (!expected){
      sendJSON(res, 503, { error: 'login not configured', missing: envName });
      return;
    }
    if (typeof payload.password === 'string' && passwordMatches(payload.password, expected)){
      sendJSON(res, 200, { role: payload.role });
    } else {
      sendJSON(res, 401, { error: 'incorrect password' });
    }
  });
}

function serveStatic(req, res, reqPath){
  // Resolve file under PUBLIC_DIR
  const safeSuffix = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safeSuffix);
  // If path is a directory, try to serve proxy.html / index.html
  if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'proxy.html');

  // Try common fallbacks for the existing repo layout: proxy.html or proxy.js
  const tryFiles = [filePath, filePath.replace(/\.html$/, '.js'), path.join(PUBLIC_DIR, 'proxy.html'), path.join(PUBLIC_DIR, 'proxy.js'), path.join(PUBLIC_DIR, 'index.html')];
  for (const p of tryFiles){
    if (!p) continue;
    try{
      if (fs.existsSync(p) && fs.statSync(p).isFile()){
        const stream = fs.createReadStream(p);
        const ext = path.extname(p).toLowerCase();
        const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
        stream.pipe(res);
        return;
      }
    } catch(e){}
  }
  sendJSON(res, 404, { error: 'Not found' });
}

function handler(req, res){
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // Simple CORS preflight support
  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end();
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST'){
    handleLogin(req, res);
    return;
  }

  if (pathname === '/api/proxy'){
    // Only named endpoints are allowed, so the proxy can't be used to fetch arbitrary URLs.
    const endpoint = parsed.query.endpoint;
    const target = Object.prototype.hasOwnProperty.call(ENDPOINT_MAP, endpoint) ? ENDPOINT_MAP[endpoint] : null;
    if (!target){
      sendJSON(res, 400, { error: 'unknown endpoint', endpoint: endpoint || null });
      return;
    }
    proxyFetch(target, res);
    return;
  }

  // Static files (serve the frontend HTML/JS/CSS located in ./api)
  // If the request looks like a file path, attempt to serve it, otherwise serve the main page
  let reqPath = pathname;
  if (reqPath === '/') reqPath = '/proxy.html';
  serveStatic(req, res, reqPath);
}

// Vercel calls the exported handler; `npm start` runs a local server.
module.exports = handler;

if (require.main === module){
  http.createServer(handler).listen(PORT, () => console.log(`cryogen-proxy server listening on http://localhost:${PORT}`));
}

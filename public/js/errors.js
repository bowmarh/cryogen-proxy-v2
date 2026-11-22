'use strict';
// Tells the club when something in this page breaks, so it can be fixed before anyone has to complain. It sends the error message, the script and line,
// and which page of the app was open. Nothing about who you are. At most five reports per page load, and never the same error twice.
(function () {   // A refused request reads "Load failed" on Safari: say what it means, and offer a way back, instead of a dead page full of red.
  const real = window.fetch; if (!real) return;
  const note = on => {
    let b = document.getElementById('net-banner');
    if (!on) { if (b) b.remove(); return; }
    if (b || !document.body) return;
    b = document.createElement('div'); b.id = 'net-banner'; b.setAttribute('role', 'alert');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9997;background:#7c2d12;color:#fff;padding:8px 12px;font-size:13px;text-align:center';
    b.innerHTML = "Can't reach the club server right now. Check your Wi-Fi or mobile data. <button type='button' style='margin-left:8px;padding:2px 10px;border-radius:6px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer' onclick='location.reload()'>Try again</button>";
    document.body.appendChild(b);
  };
  window.fetch = function (input, opts) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const mine = url.startsWith('/api/') || url.startsWith(location.origin + '/api/');
    return real.call(this, input, opts).then(r => { if (mine) note(false); return r; }, e => {
      if (mine && e && e.name === 'TypeError') { note(true); const m = new TypeError("Can't reach the server. Check your connection and try again."); m.cause = e; throw m; }
      throw e;
    });
  };
})();
(function () {
  const sent = new Set(); let n = 0;
  const here = () => { try { const a = document.querySelector('.page.active'); return a ? a.id.replace(/^page-/, '') : (location.pathname || '/'); } catch (e) { return ''; } };
  function send(message, source, line) {
    try {
      if (n >= 5) return;
      message = String(message || '');
      // Errors from other origins show as "Script error." with nothing to act on, and browser extensions inject scripts of their own: both are ignored.
      // Network trouble (offline, a refused request) is not a bug in the page.
      if (/Failed to fetch|NetworkError|Load failed|Can't reach the server|AbortError|^Unhandled promise: (HTTP \d+|Shared storage|storage error|Sign in|You are signed out)/i.test(message)) return;
      if (!message || /^Script error\.?$/i.test(message) || (source && !String(source).startsWith(location.origin))) return;
      const key = message + '|' + source + '|' + line; if (sent.has(key)) return; sent.add(key); n++;
      fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ message, source, line, page: here() }) }).catch(() => {});
    } catch (e) { /* reporting must never break the page */ }
  }
  window.addEventListener('error', e => send(e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', e => { const r = e.reason; send('Unhandled promise: ' + String((r && (r.message || r)) || 'unknown'), '', 0); });
})();

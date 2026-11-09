'use strict';
// Tells the club when something in this page breaks, so it can be fixed before anyone has to complain. It sends the error message, the script and line,
// and which page of the app was open. Nothing about who you are. At most five reports per page load, and never the same error twice.
(function () {
  const sent = new Set(); let n = 0;
  const here = () => { try { const a = document.querySelector('.page.active'); return a ? a.id.replace(/^page-/, '') : (location.pathname || '/'); } catch (e) { return ''; } };
  function send(message, source, line) {
    try {
      if (n >= 5) return;
      message = String(message || '');
      // Errors from other origins show as "Script error." with nothing to act on, and browser extensions inject scripts of their own: both are ignored.
      // Network trouble (offline, a refused request) is not a bug in the page.
      if (/Failed to fetch|NetworkError|Load failed|AbortError|^Unhandled promise: (HTTP \d+|Shared storage|storage error|Sign in|You are signed out)/i.test(message)) return;
      if (!message || /^Script error\.?$/i.test(message) || (source && !String(source).startsWith(location.origin))) return;
      const key = message + '|' + source + '|' + line; if (sent.has(key)) return; sent.add(key); n++;
      fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ message, source, line, page: here() }) }).catch(() => {});
    } catch (e) { /* reporting must never break the page */ }
  }
  window.addEventListener('error', e => send(e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', e => { const r = e.reason; send('Unhandled promise: ' + String((r && (r.message || r)) || 'unknown'), '', 0); });
})();

// Put the club's live pages on the WordPress site. Paste this where you want them (a "Custom HTML" block):
//   <div data-cryogen="race"></div>   the live race results and radio
//   <div data-cryogen="join"></div>   the join form
//   <script src="https://<the club app>/embed.js" async></script>
(function () {
  var s = document.currentScript || document.querySelector('script[src$="/embed.js"]'), base = s ? new URL(s.src).origin : '';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ord = function (n) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); };
  function race(el) {
    function load() {
      fetch(base + '/api/public/race').then(function (r) { if (!r.ok) throw new Error('off'); return r.json(); }).then(function (d) {
        el.innerHTML = '<div style="font-family:system-ui,Arial,sans-serif;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;max-width:560px"><strong>' + (d.round ? esc(d.round) + ' · race ' + (d.week + 1) : 'Race day') + '</strong>' +
          '<table style="width:100%;border-collapse:collapse;margin-top:8px">' + (d.teams || []).map(function (t) { return '<tr><td style="padding:4px 0;border-top:1px solid #e5e7eb">' + esc(t.name) + '</td><td style="padding:4px 0;border-top:1px solid #e5e7eb;text-align:right">' + (t.result ? (t.result.pos ? ord(t.result.pos) : 'in') + (t.result.pts !== null && t.result.pts !== undefined ? ' · ' + esc(t.result.pts) + ' pts' : '') : 'waiting') + '</td></tr>'; }).join('') + '</table>' +
          (d.feed && d.feed.length ? '<div style="margin-top:8px;font-size:14px">' + d.feed.slice(0, 3).map(function (f) { return '<div>' + esc(f.text) + '</div>'; }).join('') + '</div>' : '') + '</div>';
      }).catch(function () { el.textContent = ''; });
    }
    load(); setInterval(load, 60000);
  }
  function join(el) { el.innerHTML = '<iframe src="' + base + '/join.html" title="Join Team CRYO-GEN" style="width:100%;max-width:520px;height:640px;border:0;border-radius:10px;background:#0b1220"></iframe>'; }
  Array.prototype.forEach.call(document.querySelectorAll('[data-cryogen]'), function (el) { var k = el.getAttribute('data-cryogen'); if (k === 'race') race(el); else if (k === 'join') join(el); });
})();

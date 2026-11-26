'use strict';
// "Your race week, in one place" ideas from the ECRO league app, using what this club already knows: your last race in a sentence (who you beat, who was just ahead,
// who held you off, by how much) and where you stand in the club by vELO with the gap to the riders around you. Members only; it reads data already on the page.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ord = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
  const gapText = s => (s == null ? '' : s < 60 ? (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'));
  const first = n => String(n || '').replace(/\s*[\[(].*$/, '').trim();
  function raceLine(r) {
    if (!r || r.pos == null && r.catPos == null) return '';
    const a = r.around || {}, parts = [];
    parts.push(`you finished <b>${ord(r.pos != null ? r.pos : r.catPos)}</b>${r.pos != null ? ' overall' : ` in ${E(r.cat || 'your category')}`}${r.pos != null && r.catPos ? ` (${ord(r.catPos)} in ${E(r.cat || 'your category')})` : ''}${r.field ? ` of ${r.field}` : ''}.`);
    if (a.beaten) parts.push(`You beat ${a.beaten} clubmate${a.beaten === 1 ? '' : 's'}.`);
    if (a.ahead) parts.push(`${E(first(a.ahead.name))} was just ahead${a.ahead.gap != null ? ` by ${gapText(a.ahead.gap)}` : ''}.`);
    if (a.behind) parts.push(`${E(first(a.behind.name))} ${a.behind.gap != null ? `was ${gapText(a.behind.gap)} behind you` : 'finished just behind you'}.`);
    return parts.join(' ');
  }
  function placeLine() {
    const me = typeof memberRider !== 'undefined' && memberRider, list = typeof riders !== 'undefined' ? riders : [];
    if (!me) return '';
    const all = list.filter(x => x.active && x.velo > 0).sort((a, b) => b.velo - a.velo), i = all.findIndex(x => String(x.id) === String(me.id));
    if (i < 0) return '';
    const you = all[i], up = all[i - 1], down = all[i + 1], fmt = n => Number(n).toLocaleString('en-GB');
    return `You are <b>#${i + 1}</b> of ${all.length} in the club by vELO (<b>${fmt(you.velo)}</b>).${up ? ` ${E(first(up.name))} is ${fmt(up.velo - you.velo)} ahead.` : ' You lead the club.'}${down ? ` ${E(first(down.name))} is ${fmt(you.velo - down.velo)} behind.` : ''}`;
  }
  // A racing streak, the Duolingo idea: how many weeks in a row (up to this week or last) you have raced. Like Duolingo's streak freeze, one missed week a
  // month is forgiven (it does not add to the count, it just does not break it), so a holiday or a bad week does not wipe out a long run.
  function streakInfo(list, now = Date.now()) {
    const wk = t => Math.floor((t * 1000 - 4 * 864e5) / (7 * 864e5)), weeks = new Set((list || []).filter(r => r.time).map(r => wk(r.time))), monthOf = w => new Date(w * 7 * 864e5 + 4 * 864e5).toISOString().slice(0, 7);
    let w = wk(now / 1000); if (!weeks.has(w)) w--;
    let n = 0, frozen = 0; const used = new Set();
    while (w > -1e9) {
      if (weeks.has(w)) { n++; w--; continue; }
      if (n > 0 && weeks.has(w - 1) && !used.has(monthOf(w))) { used.add(monthOf(w)); frozen++; w--; continue; }
      break;
    }
    return { n, frozen };
  }
  const streakOf = (list, now) => streakInfo(list, now).n;
  // A result worth sharing: plain text for WhatsApp, Discord or anywhere (the phone's share sheet when there is one, else copied).
  const plain = h => String(h).replace(/<[^>]+>/g, '');
  async function share() {
    const last = (results || []).find(r => r.pos != null || r.catPos != null); if (!last) return;
    const line = raceLine(last), t = `${last.title}: ${plain(line.charAt(0).toUpperCase() + line.slice(1))} 🚴 Team CRYO-GEN`;
    try { if (navigator.share) { await navigator.share({ text: t }); return; } await navigator.clipboard.writeText(t); } catch (e) { if (e && e.name === 'AbortError') return; }
    const b = document.getElementById('myplace-share'); if (b) { b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = '📤 Share'; }, 2000); }
  }
  let results = null, loaded = 0;
  async function load() {
    if (Date.now() - loaded < 300000 && results) return render();
    try { const r = await fetch('/api/me/results', { headers: typeof tttHeaders === 'function' ? tttHeaders() : {} }); if (r.ok) { results = (await r.json()).results || []; loaded = Date.now(); } } catch (e) { /* the place line still shows */ }
    render();
  }
  function render() {
    if (window.Milestones) window.Milestones.render(results || []);
    const el = document.getElementById('myplace-card'); if (!el) return;
    if ((window.role || sessionStorage.getItem('role')) !== 'member') { el.innerHTML = ''; return; }
    const last = (results || []).find(r => r.pos != null || r.catPos != null), race = last ? raceLine(last) : '', place = placeLine(), sk = streakInfo(results), streak = sk.n;
    if (!race && !place) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800;margin-bottom:6px">🏁 Where you stand</div>`
      + (race ? `<div style="font-size:13px;line-height:1.5;margin-bottom:6px"><span style="font-size:11px;font-weight:700;text-transform:uppercase;color:#8b95a5">Your last race · ${E(last.title)}</span><br>${race.charAt(0).toUpperCase() + race.slice(1)} <button type="button" id="myplace-share" onclick="MyPlace.share()" style="margin-left:6px;padding:2px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:none;color:var(--accent);cursor:pointer;font-size:12px">📤 Share</button></div>` : '')
      + (last && last.kudos ? `<div style="font-size:13px;margin-bottom:6px">👏 <b>${last.kudos}</b> clubmate${last.kudos === 1 ? '' : 's'} cheered your last race.</div>` : '') + (streak >= 2 ? `<div style="font-size:13px;margin-bottom:6px">🔥 <b>${streak}-week racing streak</b>${sk.frozen ? ` · 🧊 ${sk.frozen} missed week${sk.frozen === 1 ? '' : 's'} forgiven (one a month)` : ''}. Race this week to keep it going.</div>` : '') + (place ? `<div style="font-size:13px;line-height:1.5"><span style="font-size:11px;font-weight:700;text-transform:uppercase;color:#8b95a5">In the club</span><br>${place}</div>` : '') + '</div>';
  }
  function start() {
    const m = document.getElementById('main'); if (!m) return; let was = false;
    const check = () => { const on = !!document.querySelector('#page-dashboard.active'); if (on && !was) setTimeout(load, 600); was = on; };
    new MutationObserver(check).observe(m, { attributes: true, subtree: true, attributeFilter: ['class'] }); check();
  }
  window.addEventListener('load', () => setTimeout(start, 900));
  window.MyPlace = { load, render, raceLine, placeLine, share, streakOf, streakInfo };
})();

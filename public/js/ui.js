'use strict';
// Looks and personal settings for the dashboard: accent colour, spacing, text size, the page it opens on, which dashboard cards show and in what
// order, the club's own theme, the charts, avatars, the race-day screen and the season picture. A rider's choices live in this browser only.
(function () {
  const KEY = 'ui:prefs';
  const ACCENTS = { cyan: '#00D4FF', orange: '#FF8A1F', green: '#22C55E', purple: '#A78BFA', pink: '#F472B6', gold: '#FBBF24' };
  const CARDS = [
    { id: 'myweek', label: 'My week', sel: '#myweek-card' },
    { id: 'stats', label: 'Club numbers', sel: '[data-card="stats"]' },
    { id: 'charts', label: 'Charts', sel: '[data-card="charts"]' },
    { id: 'leaders', label: 'Top riders and categories', sel: '[data-card="leaders"]' },
    { id: 'results', label: 'Recent results', sel: '[data-card="results"]' },
  ];
  const STARTS = [['dashboard', 'Dashboard'], ['profile', 'My Profile'], ['zrl', 'ZRL'], ['ttt', 'TTT Week'], ['ladder', 'Ladder'], ['drs', 'DIRT Series'], ['rides', 'Social Rides']];
  const TEXT = { s: 0.92, m: 1, l: 1.1, xl: 1.2 };
  const DEFAULTS = { accent: 'club', density: 'comfortable', text: 'm', start: 'dashboard', order: CARDS.map(c => c.id), hidden: [] };
  let club = { accent: '', welcome: '', logo: '' };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function prefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { /* defaults */ }
    const order = Array.isArray(p.order) ? p.order.filter(id => CARDS.some(c => c.id === id)) : [];
    for (const c of CARDS) if (!order.includes(c.id)) order.push(c.id);
    return { ...DEFAULTS, ...p, order, hidden: Array.isArray(p.hidden) ? p.hidden.filter(id => CARDS.some(c => c.id === id)) : [] };
  }
  function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* not saved */ } }
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return `${n >> 16},${(n >> 8) & 255},${n & 255}`; };

  function apply() {
    const p = prefs(), root = document.documentElement;
    const hex = (ACCENTS[p.accent]) || (p.accent === 'club' && /^#[0-9a-f]{6}$/i.test(club.accent) ? club.accent : ACCENTS.cyan);
    root.style.setProperty('--accent', hex); root.style.setProperty('--accent-rgb', rgb(hex));
    root.dataset.density = p.density === 'compact' ? 'compact' : 'comfortable';
    root.style.setProperty('--text-zoom', String(TEXT[p.text] || 1));
    layout();
    welcome();
  }

  // Dashboard cards: order and visibility.
  function layout() {
    const p = prefs();
    p.order.forEach((id, i) => {
      const c = CARDS.find(x => x.id === id), el = c && document.querySelector(c.sel);
      if (!el) return;
      el.style.order = String(i);
      el.style.display = p.hidden.includes(id) ? 'none' : '';
    });
  }

  function welcome() {
    const el = document.getElementById('club-welcome');
    if (el) { el.textContent = club.welcome || ''; el.style.display = club.welcome ? '' : 'none'; }
    // The club logo replaces ours; if the address is not a picture that loads, the original comes straight back.
    document.querySelectorAll('img[src="/logo.png"],img[data-brand]').forEach(i => {
      i.dataset.brand = '1';
      i.onerror = () => { i.onerror = null; i.src = '/logo.png'; };
      const want = club.logo || '/logo.png';
      if (i.getAttribute('src') !== want) i.src = want;
    });
  }
  // True when the address loads as a picture.
  const isPicture = url => new Promise(ok => { const i = new Image(); const t = setTimeout(() => ok(false), 6000); i.onload = () => { clearTimeout(t); ok(true); }; i.onerror = () => { clearTimeout(t); ok(false); }; i.src = url; });

  async function loadClub() {
    try { const r = await fetch('/api/club/theme'); if (r.ok) club = await r.json(); } catch (e) { /* the default look */ }
    apply();
  }

  // The page the dashboard opens on (staff keep opening on This week).
  function startPage() {
    const p = prefs();
    if (p.start === 'dashboard') return;
    const btn = document.querySelector(`.navbtn[onclick*="showTab('${p.start}'"]`);
    if (btn && btn.offsetParent !== null && typeof showTab === 'function') showTab(p.start, btn);
  }

  // ── The customise window ──────────────────────────────────
  function open() {
    close();
    const p = prefs();
    const isAdmin = typeof role !== 'undefined' && role === 'admin';
    const sw = Object.entries(ACCENTS).map(([k, v]) => `<button type="button" aria-label="${k} accent" aria-pressed="${p.accent === k}" onclick="uiSet('accent','${k}')" style="width:30px;height:30px;border-radius:50%;background:${v};border:3px solid ${p.accent === k ? '#fff' : 'transparent'};cursor:pointer"></button>`).join('')
      + `<button type="button" aria-pressed="${p.accent === 'club'}" onclick="uiSet('accent','club')" style="padding:4px 10px;border-radius:99px;border:1px solid rgba(255,255,255,.25);background:${p.accent === 'club' ? 'rgba(255,255,255,.15)' : 'transparent'};color:#e5e7eb;font-size:12px;cursor:pointer">Club default</button>`;
    const sel = (name, opts, cur) => `<select class="inp" aria-label="${name}" onchange="uiSet('${name}',this.value)" style="width:auto">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const cards = p.order.map((id, i) => { const c = CARDS.find(x => x.id === id); return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid rgba(255,255,255,.06)"><label style="flex:1;font-size:13px"><input type="checkbox" ${p.hidden.includes(id) ? '' : 'checked'} onchange="uiToggle('${id}',this.checked)"/> ${esc(c.label)}</label><button type="button" aria-label="Move ${esc(c.label)} up" ${i === 0 ? 'disabled' : ''} onclick="uiMove('${id}',-1)" style="padding:2px 8px">↑</button><button type="button" aria-label="Move ${esc(c.label)} down" ${i === p.order.length - 1 ? 'disabled' : ''} onclick="uiMove('${id}',1)" style="padding:2px 8px">↓</button></div>`; }).join('');
    const clubBox = isAdmin ? `<div style="border-top:1px solid rgba(255,255,255,.1);padding-top:12px"><div class="lbl">Club look (everyone sees this)</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="color" id="ui-club-accent" aria-label="Club accent colour" value="${esc(club.accent || '#00d4ff')}" style="width:44px;height:30px;padding:0;border:none;background:none"/><span style="font-size:12px;color:#8b95a5">Accent colour</span></div>
        <input id="ui-club-welcome" class="inp" maxlength="140" placeholder="A welcome line for the dashboard" value="${esc(club.welcome)}" style="margin-bottom:8px"/>
        <input id="ui-club-logo" class="inp" placeholder="Logo address (https://…)" value="${esc(club.logo)}" style="margin-bottom:8px"/>
        <button type="button" class="btn-cyan" onclick="uiSaveClub()" style="width:auto;padding:7px 16px;font-size:13px">Save club look</button> <span id="ui-club-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div>` : '';
    const bg = document.createElement('div');
    bg.className = 'modal-bg'; bg.id = 'ui-modal'; bg.onclick = e => { if (e.target === bg) close(); };
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Customise" style="max-width:480px"><div class="modal-head"><span>🎨 Customise</span><button type="button" aria-label="Close" onclick="uiClose()" style="background:none;border:none;color:#9ca3af;font-size:18px">✕</button></div>
      <div class="modal-body">
        <div><div class="lbl">Accent colour</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${sw}</div></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap"><div><div class="lbl">Spacing</div>${sel('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], p.density)}</div><div><div class="lbl">Text size</div>${sel('text', [['s', 'Small'], ['m', 'Normal'], ['l', 'Large'], ['xl', 'Extra large']], p.text)}</div><div><div class="lbl">Open on</div>${sel('start', STARTS, p.start)}</div></div>
        <div><div class="lbl">Dashboard cards</div>${cards}</div>
        ${clubBox}
        <div><button type="button" onclick="uiReset()" style="padding:6px 12px;background:rgba(255,255,255,.05);color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:6px;font-size:12px">Back to the defaults</button></div>
      </div></div>`;
    document.body.appendChild(bg);
    const first = bg.querySelector('button'); if (first) first.focus();
    document.addEventListener('keydown', escClose);
  }
  const escClose = e => { if (e.key === 'Escape') close(); };
  function close() { const m = document.getElementById('ui-modal'); if (m) m.remove(); document.removeEventListener('keydown', escClose); }
  function set(name, value) { const p = prefs(); p[name] = value; save(p); apply(); open(); }
  function toggle(id, on) { const p = prefs(); p.hidden = on ? p.hidden.filter(x => x !== id) : [...new Set([...p.hidden, id])]; save(p); layout(); }
  function move(id, d) { const p = prefs(), i = p.order.indexOf(id), j = i + d; if (j < 0 || j >= p.order.length) return; [p.order[i], p.order[j]] = [p.order[j], p.order[i]]; save(p); layout(); open(); }
  function reset() { try { localStorage.removeItem(KEY); } catch (e) { /* nothing saved */ } apply(); open(); }
  async function saveClub() {
    const msg = document.getElementById('ui-club-msg');
    const body = { accent: document.getElementById('ui-club-accent').value, welcome: document.getElementById('ui-club-welcome').value, logo: document.getElementById('ui-club-logo').value.trim() };
    try {
      if (body.logo && !(await isPicture(body.logo))) throw new Error('That address is not a picture. Use the direct link to an image file (ending .png, .jpg or .svg), not a web page. Leave it empty to keep the CRYO-GEN logo.');
      const res = await fetch('/api/club/theme', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json(); if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
      club = d; apply(); msg.textContent = 'Saved.';
    } catch (e) { msg.textContent = e.message; }
  }

  // ── Charts ────────────────────────────────────────────────
  let trend = null, trendAt = 0;
  async function charts() {
    const el = document.querySelector('[data-card="charts"]'); if (!el) return;
    if (!trend || Date.now() - trendAt > 300000) {
      try { const r = await fetch('/api/club/trend'); if (r.ok) { trend = await r.json(); trendAt = Date.now(); } } catch (e) { /* drawn from what the page has */ }
    }
    const cc = typeof CAT_COLOR !== 'undefined' ? CAT_COLOR : {};
    const live = (typeof riders !== 'undefined' ? riders : []).filter(m => m.active);
    const cats = {}; live.forEach(m => { cats[m.cat] = (cats[m.cat] || 0) + 1; });
    el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:20px">
      <div class="card" style="padding:16px"><div class="lbl">Club vELO, last weeks</div>${spark(trend && trend.velo || [])}</div>
      <div class="card" style="padding:16px"><div class="lbl">Who rides what</div>${donut(cats, cc)}</div>
      <div class="card" style="padding:16px"><div class="lbl">Ride sign-ups per week</div>${bars(trend && trend.attendance || [])}</div></div>`;
  }
  function spark(pts) {
    if (pts.length < 2) return `<div style="font-size:12px;color:#8b95a5;padding:18px 0">The club's average is saved once a day. The line appears after the second day${pts.length ? ` (so far ${esc(pts[0].avg)})` : ''}.</div>`;
    const W = 220, H = 70, vs = pts.map(p => p.avg), lo = Math.min(...vs), hi = Math.max(...vs), span = Math.max(hi - lo, 1);
    const xy = pts.map((p, i) => [Math.round(i / (pts.length - 1) * W), Math.round(H - 6 - (p.avg - lo) / span * (H - 12))]);
    const d = xy.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ');
    const change = vs[vs.length - 1] - vs[0];
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Average vELO from ${vs[0]} to ${vs[vs.length - 1]}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0]}" cy="${xy[xy.length - 1][1]}" r="3.5" fill="var(--accent)"/></svg>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#8b95a5"><span>${pts[0].d.slice(5)}</span><b style="color:${change >= 0 ? '#10B981' : '#f87171'}">${vs[vs.length - 1]} (${change >= 0 ? '+' : ''}${change})</b></div>`;
  }
  function donut(cats, colors) {
    const keys = ['A+', 'A', 'B', 'C', 'D'].filter(k => cats[k]), total = keys.reduce((n, k) => n + cats[k], 0);
    if (!total) return '<div style="font-size:12px;color:#8b95a5;padding:18px 0">No riders yet.</div>';
    const R = 34, C = 2 * Math.PI * R; let off = 0;
    const arcs = keys.map(k => { const len = cats[k] / total * C, a = `<circle r="${R}" cx="50" cy="50" fill="none" stroke="${colors[k] || '#888'}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 50 50)"/>`; off += len; return a; }).join('');
    return `<div style="display:flex;align-items:center;gap:14px"><svg viewBox="0 0 100 100" width="96" height="96" role="img" aria-label="Riders by category: ${keys.map(k => k + ' ' + cats[k]).join(', ')}">${arcs}<text x="50" y="55" text-anchor="middle" font-size="18" font-weight="800" fill="currentColor">${total}</text></svg>
      <div style="font-size:12px">${keys.map(k => `<div><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colors[k] || '#888'};margin-right:6px"></span>${k} <b>${cats[k]}</b></div>`).join('')}</div></div>`;
  }
  function bars(weeks) {
    if (!weeks.length || !weeks.some(w => w.rsvps)) return '<div style="font-size:12px;color:#8b95a5;padding:18px 0">No ride sign-ups in the last eight weeks.</div>';
    const max = Math.max(...weeks.map(w => w.rsvps), 1);
    return `<div style="display:flex;gap:5px;align-items:flex-end;height:80px" role="img" aria-label="Ride sign-ups per week: ${weeks.map(w => w.rsvps).join(', ')}">${weeks.map(w => `<div style="flex:1;text-align:center"><div style="font-size:10px;color:#8b95a5">${w.rsvps || ''}</div><div style="height:${Math.round(w.rsvps / max * 54) + 3}px;background:var(--accent);border-radius:3px 3px 0 0;opacity:${w.rsvps ? 0.9 : 0.25}"></div></div>`).join('')}</div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#8b95a5;margin-top:3px"><span>${esc(weeks[0].week.slice(5))}</span><span>this week</span></div>`;
  }

  // ── Avatars and team colours ──────────────────────────────
  function avatar(name, cat) {
    const parts = String(name || '?').trim().split(/\s+/), ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    const c = (typeof CAT_COLOR !== 'undefined' && CAT_COLOR[cat]) || '#8b95a5';
    return `<span class="av" aria-hidden="true" style="--c:${c}">${esc(ini)}</span>`;
  }
  function teamColor(id) { let h = 0; for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 70% 55%)`; }

  // ── Race-day screen ───────────────────────────────────────
  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach(el => {
      const ms = Number(el.dataset.countdown) - Date.now(), a = Math.abs(ms), m = Math.floor(a / 60000), s = Math.floor(a % 60000 / 1000);
      el.textContent = ms <= 0 ? (a < 45 * 60000 ? 'Under way' : 'Started') : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    });
  }, 1000);
  // A big card for a race the rider is in that starts within three hours (or began in the last 45 minutes).
  function raceDay(items, penDone) {
    const now = Date.now();
    const u = (items || []).find(x => x.pen && x.timed && x.atMs - now < 3 * 3600000 && x.atMs - now > -45 * 60000 && x.state !== 'out');
    if (!u) return '';
    const id = u.pen.kind + ':' + u.pen.id, done = penDone && penDone.has(id);
    setTimeout(() => fillPen(u), 0);
    return `<div id="raceday" style="margin-top:10px;padding:16px;border-radius:12px;background:linear-gradient(135deg,rgba(var(--accent-rgb),.18),rgba(var(--accent-rgb),.05));border:1px solid rgba(var(--accent-rgb),.4);text-align:center">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent)">Race day · ${esc(u.kind)}</div>
      <div style="font-size:16px;font-weight:800;margin:4px 0">${esc(u.title)}</div>
      <div data-countdown="${u.atMs}" aria-live="off" style="font-size:38px;font-weight:900;font-family:monospace;letter-spacing:.04em">--:--:--</div>
      <div id="raceday-chips" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin:12px 0"></div>
      <button type="button" ${done ? 'disabled' : ''} onclick="myWeekPenTap('${esc(u.pen.kind)}','${esc(u.pen.id)}')" style="padding:12px 26px;font-size:16px;font-weight:800;border-radius:10px;cursor:pointer;border:2px solid #10B981;background:${done ? 'rgba(16,185,129,.25)' : '#10B981'};color:${done ? '#34d399' : '#04210f'}">${done ? '✅ You are in the pen' : "🏁 I'm in the pen"}</button>
      ${u.link ? `<div style="margin-top:8px;font-size:12px"><a href="${esc(u.link)}" target="_blank" rel="noopener">Open the event in Zwift</a></div>` : ''}</div>`;
  }
  async function fillPen(u) {
    const box = document.getElementById('raceday-chips'); if (!box) return;
    try {
      const r = await fetch(`/api/live/pen?kind=${encodeURIComponent(u.pen.kind)}&id=${encodeURIComponent(u.pen.id)}`, { headers: tttHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      box.innerHTML = d.riders.map(x => `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 4px;border-radius:99px;font-size:12px;border:1px solid ${x.inPen ? '#10B981' : 'rgba(255,255,255,.2)'};background:${x.inPen ? 'rgba(16,185,129,.15)' : 'transparent'}">${avatar(x.name, '')}${esc(x.name.split(' ')[0])}${x.inPen ? ' ✅' : ''}</span>`).join('');
    } catch (e) { /* the countdown and the button still work */ }
  }

  // ── Season picture ────────────────────────────────────────
  function ring(frac, label, big, color) {
    const R = 30, C = 2 * Math.PI * R, f = Math.max(0, Math.min(1, frac || 0));
    return `<div style="text-align:center"><svg viewBox="0 0 80 80" width="84" height="84" role="img" aria-label="${esc(label)}: ${esc(big)}"><circle cx="40" cy="40" r="${R}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="9"/><circle cx="40" cy="40" r="${R}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(f * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="45" text-anchor="middle" font-size="15" font-weight="800" fill="currentColor">${esc(big)}</text></svg><div style="font-size:11px;color:#8b95a5">${esc(label)}</div></div>`;
  }
  function seasonFacts(d) {
    const z = d.zrl || {}, t = d.ttt || {}, r = d.rides || {};
    const podiums = (z.podiums || 0) + (t.podiums || 0);
    return { z, t, r, podiums, flame: (d.highlights || []).some(h => /every ZRL race/.test(h)),
      pick: z.races ? z.picked / z.races : 0, ans: z.weeks ? z.answered / z.weeks : 0, rides: Math.min((r.attended || 0) / 10, 1) };
  }
  function seasonVisual(d) {
    const f = seasonFacts(d);
    const medals = f.podiums ? '🥇'.repeat(Math.min(f.podiums, 5)) + (f.podiums > 5 ? ` +${f.podiums - 5}` : '') : '';
    return `<div class="card" style="padding:16px;margin-bottom:10px"><div style="display:flex;gap:14px;justify-content:space-around;flex-wrap:wrap;align-items:center">
      ${ring(f.pick, 'ZRL races picked', f.z.races ? `${f.z.picked}/${f.z.races}` : '—', 'var(--accent)')}${ring(f.ans, 'Answers given', f.z.weeks ? `${f.z.answered}/${f.z.weeks}` : '—', '#10B981')}${ring(f.rides, 'Social rides (of 10)', String(f.r.attended || 0), '#FBBF24')}
      <div style="text-align:center;min-width:90px"><div style="font-size:26px">${f.flame ? '🔥' : '🚴'}</div><div style="font-size:12px;color:#8b95a5">${f.flame ? 'Raced every race' : 'Keep going'}</div>${medals ? `<div style="font-size:18px;margin-top:4px" aria-label="${f.podiums} podiums">${medals}</div>` : ''}</div></div>
      <div style="text-align:center;margin-top:10px"><button type="button" onclick="uiSeasonShare(this)" style="padding:6px 14px;font-size:12px;background:rgba(255,255,255,.05);color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:6px;cursor:pointer">🖼️ Save my season as a picture</button></div></div>`;
  }
  let lastSeason = null;
  async function seasonShare(btn) {
    const d = lastSeason; if (!d) return;
    const f = seasonFacts(d), W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00D4FF';
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#060a14'); bg.addColorStop(1, '#10203a'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = accent; g.fillRect(0, 0, W, 14);
    g.textAlign = 'center'; g.fillStyle = accent; g.font = '700 38px system-ui,sans-serif'; g.fillText('TEAM CRYO-GEN', W / 2, 110);
    g.fillStyle = '#fff'; g.font = '800 76px system-ui,sans-serif'; g.fillText(String(d.name || 'My season').slice(0, 24), W / 2, 230);
    g.fillStyle = '#9ca3af'; g.font = '500 34px system-ui,sans-serif'; g.fillText('My season', W / 2, 285);
    const rings = [[f.pick, 'ZRL races picked', f.z.races ? `${f.z.picked}/${f.z.races}` : '—', accent], [f.ans, 'Answers given', f.z.weeks ? `${f.z.answered}/${f.z.weeks}` : '—', '#10B981'], [f.rides, 'Social rides', String(f.r.attended || 0), '#FBBF24']];
    rings.forEach(([fr, label, big, col], i) => {
      const cx = 190 + i * 350, cy = 560, R = 120;
      g.lineWidth = 34; g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = col; g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, Math.min(1, fr))); g.stroke();
      g.fillStyle = '#fff'; g.font = '800 54px system-ui,sans-serif'; g.fillText(big, cx, cy + 18);
      g.fillStyle = '#9ca3af'; g.font = '500 28px system-ui,sans-serif'; g.fillText(label, cx, cy + R + 60);
    });
    g.font = '90px system-ui,sans-serif'; g.fillStyle = '#fff';
    g.fillText(f.flame ? '🔥' : '🚴', W / 2, 930);
    g.font = '700 40px system-ui,sans-serif'; g.fillStyle = '#e5e7eb'; g.fillText(f.flame ? 'Raced every race' : 'Keep going', W / 2, 1000);
    if (f.podiums) { g.font = '70px system-ui,sans-serif'; g.fillText('🥇'.repeat(Math.min(f.podiums, 6)), W / 2, 1110); g.font = '500 30px system-ui,sans-serif'; g.fillStyle = '#9ca3af'; g.fillText(`${f.podiums} podium${f.podiums === 1 ? '' : 's'}`, W / 2, 1160); }
    g.fillStyle = '#8b95a5'; g.font = '500 26px system-ui,sans-serif'; g.fillText('club.cryo-gen.team', W / 2, 1290);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const file = new File([blob], 'my-cryogen-season.png', { type: 'image/png' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'My CRYO-GEN season' }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (btn) btn.textContent = '✅ Saved';
  }

  window.uiSet = set; window.uiToggle = toggle; window.uiMove = move; window.uiReset = reset; window.uiClose = close; window.uiOpen = open; window.uiSaveClub = saveClub;
  window.uiCharts = charts; window.uiAvatar = avatar; window.uiTeamColor = teamColor; window.uiRaceDay = raceDay; window.uiSeasonVisual = d => { lastSeason = d; return seasonVisual(d); };
  window.uiSeasonShare = seasonShare; window.uiStartPage = startPage; window.uiApply = apply; window.uiPrefs = prefs;
  apply(); loadClub();
})();

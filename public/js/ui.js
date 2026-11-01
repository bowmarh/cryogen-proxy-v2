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
  const DEFAULTS = { accent: 'club', density: 'comfortable', text: 'm', start: 'dashboard', order: CARDS.map(c => c.id), hidden: [], series: false, palette: 'default', motion: 'auto', pins: [] };
  // One-tap looks: they set the theme, accent, spacing, text size and the colour and motion options together.
  const PRESETS = {
    night: { label: '🌙 Night', theme: 'dark', accent: 'cyan', density: 'comfortable', text: 'm', palette: 'default', motion: 'auto' },
    daylight: { label: '☀️ Daylight', theme: 'light', accent: 'orange', density: 'comfortable', text: 'm', palette: 'default', motion: 'auto' },
    neon: { label: '💜 Neon', theme: 'dark', accent: 'pink', density: 'compact', text: 'm', palette: 'default', motion: 'auto' },
    contrast: { label: '🔆 High contrast', theme: 'dark', accent: 'gold', density: 'comfortable', text: 'l', palette: 'cb', motion: 'reduce' },
  };
  // Category colours that stay apart for most kinds of colour blindness (the Okabe-Ito set).
  const CB_CATS = { 'A+': '#F0E442', A: '#D55E00', B: '#0072B2', C: '#009E73', D: '#CC79A7' };
  // Each series can use its own colour when the rider turns that on.
  const SERIES = { zrl: '#A78BFA', ttt: '#FBBF24', season: '#FBBF24', ladder: '#22C55E', drs: '#FF8A1F', rides: '#00D4FF', events: '#00D4FF' };
  const MONTH_KIND = { TTT: '#FBBF24', ZRL: '#A78BFA', Ladder: '#22C55E', DIRT: '#FF8A1F', Ride: '#00D4FF', Cover: '#8b95a5' };
  let origCats = null, emojis = {}, stars = new Set();
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

  const baseAccent = p => (ACCENTS[p.accent]) || (p.accent === 'club' && /^#[0-9a-f]{6}$/i.test(club.accent) ? club.accent : ACCENTS.cyan);
  function setAccent(hex) { const root = document.documentElement; root.style.setProperty('--accent', hex); root.style.setProperty('--accent-rgb', rgb(hex)); }
  // Called whenever the rider changes page: with "a colour for each series" on, the accent follows the series.
  function seriesAccent(id) { const p = prefs(); setAccent(p.series && SERIES[id] ? SERIES[id] : baseAccent(p)); }
  function palette(p) {
    if (typeof CAT_COLOR === 'undefined') return;
    if (!origCats) origCats = { ...CAT_COLOR };
    const want = p.palette === 'cb' ? CB_CATS : origCats;
    if (Object.keys(want).some(k => CAT_COLOR[k] !== want[k])) { Object.assign(CAT_COLOR, want); try { if (typeof renderAll === 'function' && document.getElementById('top10')) renderAll(); } catch (e) { /* redrawn on the next change */ } }
  }
  function apply() {
    const p = prefs(), root = document.documentElement;
    setAccent(baseAccent(p));
    root.dataset.density = p.density === 'compact' ? 'compact' : 'comfortable';
    root.dataset.motion = p.motion === 'reduce' ? 'reduce' : 'auto';
    palette(p);
    pins();
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

  // Up to four dated looks: a name, the first and last day (the year is ignored), an accent colour and a welcome line.
  function seasonRows() {
    const list = (club.seasons || []).slice(0, 4);
    while (list.length < 3) list.push({ label: '', from: '', to: '', accent: '#ff0000', welcome: '' });
    return list.map((x, i) => `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;margin-bottom:6px" data-season="${i}">
      <input class="inp" aria-label="Name of look ${i + 1}" placeholder="Name (e.g. Christmas)" maxlength="30" value="${esc(x.label)}" data-f="label"/>
      <input type="date" class="inp" aria-label="First day of look ${i + 1}" value="${x.from ? '2000-' + esc(x.from) : ''}" data-f="from" style="width:auto"/>
      <input type="date" class="inp" aria-label="Last day of look ${i + 1}" value="${x.to ? '2000-' + esc(x.to) : ''}" data-f="to" style="width:auto"/>
      <input type="color" aria-label="Accent colour of look ${i + 1}" value="${esc(x.accent || '#ff0000')}" data-f="accent" style="width:40px;height:34px;padding:0;border:none;background:none"/>
      <input class="inp" aria-label="Welcome line of look ${i + 1}" placeholder="Welcome line for this look" maxlength="140" value="${esc(x.welcome)}" data-f="welcome" style="grid-column:1 / -1"/></div>`).join('');
  }
  function seasonQuick(kind) {
    const rows = [...document.querySelectorAll('[data-season]')], row = rows.find(r => !r.querySelector('[data-f="label"]').value) || rows[0]; if (!row) return;
    const set = (f, v) => { row.querySelector(`[data-f="${f}"]`).value = v; };
    if (kind === 'christmas') { set('label', 'Christmas'); set('from', '2000-12-01'); set('to', '2000-01-01'); set('accent', '#d9202b'); set('welcome', 'Happy Christmas from Team CRYO-GEN! 🎄'); }
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
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="color" id="ui-club-accent" aria-label="Club accent colour" value="${esc((club.base && club.base.accent) || club.accent || '#00d4ff')}" style="width:44px;height:30px;padding:0;border:none;background:none"/><span style="font-size:12px;color:#8b95a5">Accent colour</span></div>
        <input id="ui-club-welcome" class="inp" maxlength="140" placeholder="A welcome line for the dashboard" value="${esc((club.base && club.base.welcome) != null ? club.base.welcome : club.welcome)}" style="margin-bottom:8px"/>
        <input id="ui-club-logo" class="inp" placeholder="Logo address (https://…)" value="${esc(club.logo)}" style="margin-bottom:8px"/>
        <div class="lbl" style="margin-top:6px">Seasonal looks (they take over between two dates every year)${club.active ? ` · on now: ${esc(club.active)}` : ''}</div>
        ${seasonRows()}
        <button type="button" onclick="uiSeasonQuick('christmas')" style="padding:4px 10px;font-size:12px;border-radius:99px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#e5e7eb;cursor:pointer;margin-bottom:10px">＋ Christmas</button>
        <button type="button" class="btn-cyan" onclick="uiSaveClub()" style="width:auto;padding:7px 16px;font-size:13px">Save club look</button> <span id="ui-club-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div>` : '';
    const bg = document.createElement('div');
    bg.className = 'modal-bg'; bg.id = 'ui-modal'; bg.onclick = e => { if (e.target === bg) close(); };
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Customise" style="max-width:480px"><div class="modal-head"><span>🎨 Customise</span><button type="button" aria-label="Close" onclick="uiClose()" style="background:none;border:none;color:#9ca3af;font-size:18px">✕</button></div>
      <div class="modal-body">
        <div><div class="lbl">One-tap looks</div><div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(PRESETS).map(([k, v]) => `<button type="button" onclick="uiPreset('${k}')" style="padding:6px 12px;border-radius:99px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#e5e7eb;font-size:12px;cursor:pointer">${v.label}</button>`).join('')}</div></div>
        <div><div class="lbl">Accent colour</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${sw}</div></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap"><div><div class="lbl">Spacing</div>${sel('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], p.density)}</div><div><div class="lbl">Text size</div>${sel('text', [['s', 'Small'], ['m', 'Normal'], ['l', 'Large'], ['xl', 'Extra large']], p.text)}</div><div><div class="lbl">Open on</div>${sel('start', STARTS, p.start)}</div></div>
        <div><label style="font-size:13px"><input type="checkbox" ${p.series ? 'checked' : ''} onchange="uiSet('series',this.checked)"/> A colour for each series (ZRL purple, TTT gold, Ladder green, DIRT orange)</label></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap"><div><div class="lbl">Category colours</div>${sel('palette', [['default', 'Standard'], ['cb', 'Colour-blind safe']], p.palette)}</div><div><div class="lbl">Motion</div>${sel('motion', [['auto', 'Follow my device'], ['reduce', 'Reduce animation']], p.motion)}</div></div>
        <div><div class="lbl">Pinned pages (shown at the top of the menu)</div>${pinList(p)}</div>
        ${typeof role !== 'undefined' && role === 'member' ? `<div><div class="lbl">My avatar</div><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${['🦊', '🐻', '🦁', '🐺', '🦅', '🚴', '⚡', '🔥', '❄️', '🏔️', '🐢', '🚀'].map(e => `<button type="button" aria-label="Use ${e}" onclick="uiAvatarSet('${e}')" style="font-size:20px;padding:2px 6px;border-radius:8px;border:1px solid ${emojis[myZwid()] === e ? '#fff' : 'rgba(255,255,255,.15)'};background:transparent;cursor:pointer">${e}</button>`).join('')}<button type="button" onclick="uiAvatarSet('')" style="padding:4px 10px;font-size:12px;border-radius:99px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#e5e7eb;cursor:pointer">None</button></div><div style="font-size:11px;color:#8b95a5;margin-top:4px">Other members see it next to your name.</div></div>` : ''}
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
    const seasons = [...document.querySelectorAll('[data-season]')].map(r => { const g = f => r.querySelector(`[data-f="${f}"]`).value; return { label: g('label'), from: g('from').slice(5), to: g('to').slice(5), accent: g('accent'), welcome: g('welcome') }; }).filter(x => x.from && x.to);
    const body = { accent: document.getElementById('ui-club-accent').value, welcome: document.getElementById('ui-club-welcome').value, logo: document.getElementById('ui-club-logo').value.trim(), seasons };
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
  function avatar(name, cat, zwid) {
    const c0 = (typeof CAT_COLOR !== 'undefined' && CAT_COLOR[cat]) || '#8b95a5', star = zwid && stars.has(String(zwid)) ? '<span title="Club supporter" aria-label="Club supporter" style="margin-right:4px;font-size:11px">⭐</span>' : '';
    if (zwid && emojis[String(zwid)]) return star + `<span class="av" aria-hidden="true" style="--c:${c0};font-size:13px;background:rgba(255,255,255,.12)">${esc(emojis[String(zwid)])}</span>`;
    const parts = String(name || '?').trim().split(/\s+/), ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    const c = (typeof CAT_COLOR !== 'undefined' && CAT_COLOR[cat]) || '#8b95a5';
    return star + `<span class="av" aria-hidden="true" style="--c:${c}">${esc(ini)}</span>`;
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


  // ── Presets, pins, avatars ────────────────────────────────
  function preset(name) {
    const v = PRESETS[name]; if (!v) return;
    try { localStorage.setItem('theme', v.theme); } catch (e) { /* the page default */ }
    const p = prefs(); Object.assign(p, { accent: v.accent, density: v.density, text: v.text, palette: v.palette, motion: v.motion }); save(p);
    if (typeof themeApply === 'function') themeApply();
    apply(); open();
  }
  const navButtons = () => [...document.querySelectorAll('#main-nav .navbtn')].filter(b => !b.dataset.pin && /showTab\('/.test(b.getAttribute('onclick') || '') && b.offsetParent !== null);
  const tabOf = b => ((/showTab\('([^']+)'/.exec(b.getAttribute('onclick') || '')) || [])[1];
  const labelOf = b => b.textContent.replace(/\s+\d+\s*$/, '').trim();
  function pinList(p) {
    const items = navButtons();
    if (!items.length) return '<div style="font-size:12px;color:#8b95a5">Open the dashboard first.</div>';
    return items.map(b => { const id = tabOf(b); return `<label style="display:inline-block;margin:2px 10px 2px 0;font-size:13px"><input type="checkbox" ${p.pins.includes(id) ? 'checked' : ''} onchange="uiPin('${id}',this.checked)"/> ${esc(labelOf(b))}</label>`; }).join('');
  }
  function pin(id, on) { const p = prefs(); p.pins = on ? [...new Set([...p.pins, id])].slice(-4) : p.pins.filter(x => x !== id); save(p); pins(); open(); }
  // Pinned pages sit at the top of the menu, under a small heading.
  function pins() {
    const nav = document.getElementById('main-nav'); if (!nav) return;
    let box = document.getElementById('pinned-nav');
    if (!box) { box = document.createElement('div'); box.id = 'pinned-nav'; nav.prepend(box); }
    const wanted = prefs().pins, real = navButtons();
    const btns = wanted.map(id => real.find(b => tabOf(b) === id)).filter(Boolean);
    box.innerHTML = btns.length ? '<div class="navgroup">Pinned</div>' : '';
    btns.forEach(b => { const c = document.createElement('button'); c.className = 'navbtn'; c.dataset.pin = '1'; c.textContent = '⭐ ' + labelOf(b).replace(/^\S+\s/, ''); c.onclick = () => b.click(); box.appendChild(c); });
  }
  async function loadAvatars() {
    try { const r = await fetch('/api/avatars', { headers: tttHeaders() }); if (r.ok) { const d = await r.json(); emojis = d.avatars || {}; stars = new Set(d.supporters || []); } } catch (e) { /* initials are shown */ }
  }
  const myZwid = () => (typeof memberRider !== 'undefined' && memberRider && memberRider.id != null ? String(memberRider.id) : '');
  async function avatarSet(emoji) {
    try {
      const res = await fetch('/api/me/avatar', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save.');
      await loadAvatars(); open();
      if (typeof renderAll === 'function') renderAll();
    } catch (e) { alert(e.message); }
  }

  // ── Empty states: a picture word, a sentence and the next thing to do ──
  function empty(icon, title, text, label, onclick) {
    return `<div style="text-align:center;padding:26px 16px"><div style="font-size:42px" aria-hidden="true">${icon}</div><div style="font-weight:800;margin:6px 0 4px">${esc(title)}</div><div style="font-size:13px;color:#8b95a5;max-width:360px;margin:0 auto 12px">${esc(text)}</div>${label ? `<button type="button" onclick="${onclick}" class="btn-cyan" style="width:auto;padding:8px 18px;font-size:13px">${esc(label)}</button>` : ''}</div>`;
  }

  // ── Month calendar (My week) ──────────────────────────────
  async function calendarInto(el) {
    if (!el) return;
    el.innerHTML = '<div style="font-size:12px;color:#8b95a5;padding:8px">Loading…</div>';
    let d; try { const r = await fetch('/api/me/week?days=42', { headers: tttHeaders() }); d = await r.json(); if (!r.ok) throw new Error(d.error || ''); } catch (e) { el.innerHTML = '<div style="font-size:12px;color:#f87171;padding:8px">Could not load the calendar.</div>'; return; }
    const tz = typeof tzZone === 'function' ? tzZone() : 'UTC';
    const key = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
    const byDay = {}; d.items.forEach(u => { const k = u.timed ? key(u.atMs) : u.date; (byDay[k] = byDay[k] || []).push(u); });
    const today = key(Date.now()), start = new Date(today + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    let html = '<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;font-size:11px" role="grid" aria-label="Next six weeks">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div role="columnheader" style="text-align:center;color:#8b95a5;padding:2px">${x}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const day = new Date(start); day.setUTCDate(start.getUTCDate() + i); const k = day.toISOString().slice(0, 10), its = byDay[k] || [], past = k < today;
      html += `<div role="gridcell" style="min-height:62px;padding:3px;border-radius:6px;border:1px solid ${k === today ? 'var(--accent)' : 'rgba(255,255,255,.07)'};background:${its.some(u => u.state === 'todo') ? 'rgba(251,191,36,.08)' : 'transparent'};opacity:${past ? .5 : 1}"><div style="color:#8b95a5">${day.getUTCDate()}</div>${its.slice(0, 3).map(u => `<div title="${esc(u.kind + ': ' + u.title)}" style="margin-top:2px;padding:1px 4px;border-radius:4px;background:${MONTH_KIND[u.kind] || '#8b95a5'}33;border-left:3px solid ${MONTH_KIND[u.kind] || '#8b95a5'};overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(u.title)}</div>`).join('')}${its.length > 3 ? `<div style="color:#8b95a5">+${its.length - 3} more</div>` : ''}</div>`;
    }
    el.innerHTML = html + '</div>' + (d.items.length ? '' : '<div style="font-size:12px;color:#8b95a5;margin-top:8px">Nothing planned for you in the next six weeks.</div>');
  }
  function monthBox() {
    return `<details style="margin-top:10px" ontoggle="if(this.open) uiCalendarInto(this.querySelector('.mw-cal'))"><summary style="cursor:pointer;font-size:13px;color:#9ca3af">📆 Month view</summary><div class="mw-cal" style="margin-top:8px"></div></details>`;
  }

  // ── Results as pictures: podium and points over the round ──
  function podium(g) {
    const top = g.teams.filter(t => t.rank <= 3 && t.total > 0).slice(0, 3);
    if (top.length < 2) return '';
    const order = [top[1], top[0], top[2]].filter(Boolean), h = { 1: 64, 2: 46, 3: 32 }, medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
    return `<div style="display:flex;gap:8px;align-items:flex-end;justify-content:center;margin:6px 0 10px" role="img" aria-label="Podium: ${top.map(t => t.rank + ' ' + t.name).join(', ')}">${order.map(t => `<div style="text-align:center;width:30%;max-width:130px"><div style="font-size:12px;font-weight:700;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(t.name.replace(/^CRYO-GEN\s+/, ''))}</div><div style="font-size:11px;color:#8b95a5">${t.total} pts</div><div style="height:${h[t.rank] || 28}px;background:${teamColor(t.id || t.name)};border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:center;font-size:22px">${medal[t.rank] || ''}</div></div>`).join('')}</div>`;
  }
  function pointsChart(g, dates) {
    const teams = g.teams.filter(t => t.total > 0).slice(0, 6), n = (dates || []).length;
    if (!teams.length || n < 2) return '';
    const W = 300, H = 90, series = teams.map(t => { let run = 0; return { t, pts: t.weeks.map(w => (run += (w && Number(w.pts)) || 0)) }; });
    const max = Math.max(...series.map(x => x.pts[x.pts.length - 1]), 1);
    const x = i => Math.round(i / (n - 1) * W), y = v => Math.round(H - 6 - v / max * (H - 14));
    return `<div style="margin:0 0 8px"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Team points after each race">${series.map(({ t, pts }) => `<path d="${pts.map((v, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(v)).join(' ')}" fill="none" stroke="${teamColor(t.id || t.name)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>
      <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#9ca3af">${series.map(({ t }) => `<span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${teamColor(t.id || t.name)};margin-right:4px"></span>${esc(t.name.replace(/^CRYO-GEN\s+/, ''))}</span>`).join('')}</div></div>`;
  }

  // ── Pictures to post: a line-up and a results table ──────
  async function shareCanvas(c, name, title) {
    const blob = await new Promise(res => c.toBlob(res, 'image/png')); if (!blob) return;
    const file = new File([blob], name, { type: 'image/png' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const accentNow = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00D4FF';
  function card(W, H) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), a = accentNow();
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#060a14'); bg.addColorStop(1, '#10203a'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = a; g.fillRect(0, 0, W, 12); g.textAlign = 'center';
    return { c, g, a };
  }
  function lineupCard(team, sub, names) {
    const list = (Array.isArray(names) ? names : []).slice(0, 10), H = 420 + list.length * 96, { c, g, a } = card(1080, H);
    g.fillStyle = a; g.font = '700 34px system-ui,sans-serif'; g.fillText('TEAM CRYO-GEN · LINE-UP', 540, 100);
    g.fillStyle = '#fff'; g.font = '800 68px system-ui,sans-serif'; g.fillText(String(team || '').slice(0, 26), 540, 200);
    g.fillStyle = '#9ca3af'; g.font = '500 34px system-ui,sans-serif'; g.fillText(String(sub || '').slice(0, 60), 540, 255);
    list.forEach((n, i) => { const y = 330 + i * 96; g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(140, y - 56, 800, 78); g.fillStyle = a; g.font = '800 40px system-ui,sans-serif'; g.textAlign = 'left'; g.fillText(String(i + 1), 170, y); g.fillStyle = '#fff'; g.font = '700 42px system-ui,sans-serif'; g.fillText(String(n).slice(0, 28), 240, y); g.textAlign = 'center'; });
    g.fillStyle = '#7b8494'; g.font = '500 26px system-ui,sans-serif'; g.fillText('club.cryo-gen.team', 540, H - 40);
    return shareCanvas(c, 'cryogen-lineup.png', 'Line-up');
  }
  function resultsCard(title, rows) {
    const list = (Array.isArray(rows) ? rows : []).slice(0, 10), H = 380 + list.length * 90, { c, g, a } = card(1080, H);
    g.fillStyle = a; g.font = '700 34px system-ui,sans-serif'; g.fillText('TEAM CRYO-GEN · STANDINGS', 540, 100);
    g.fillStyle = '#fff'; g.font = '800 64px system-ui,sans-serif'; g.fillText(String(title || '').slice(0, 28), 540, 200);
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
    list.forEach((r, i) => { const y = 300 + i * 90; g.fillStyle = i < 3 ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.05)'; g.fillRect(100, y - 54, 880, 74); g.textAlign = 'left'; g.font = '40px system-ui,sans-serif'; g.fillStyle = '#fff'; g.fillText(medal[r.rank] || String(r.rank), 130, y); g.font = '700 40px system-ui,sans-serif'; g.fillText(String(r.name).slice(0, 24), 230, y); g.textAlign = 'right'; g.fillStyle = a; g.font = '800 42px system-ui,sans-serif'; g.fillText(r.total + ' pts', 950, y); g.textAlign = 'center'; });
    g.fillStyle = '#7b8494'; g.font = '500 26px system-ui,sans-serif'; g.fillText('club.cryo-gen.team', 540, H - 40);
    return shareCanvas(c, 'cryogen-results.png', 'Results');
  }

  // ── Small line charts for the staff page and the rider profile ──
  function mini(points, label, color, unit) {
    const vs = points.filter(v => v != null);
    if (vs.length < 2) return `<div style="flex:1;min-width:150px"><div class="lbl">${esc(label)}</div><div style="font-size:22px;font-weight:900">${vs.length ? esc(vs[vs.length - 1]) : '—'}</div><div style="font-size:11px;color:#8b95a5">The line appears after the second day.</div></div>`;
    const W = 160, H = 46, lo = Math.min(...vs), hi = Math.max(...vs), span = Math.max(hi - lo, 1), n = points.length;
    const d = points.map((v, i) => v == null ? null : [Math.round(i / (n - 1) * W), Math.round(H - 4 - (v - lo) / span * (H - 8))]).filter(Boolean).map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ');
    return `<div style="flex:1;min-width:150px"><div class="lbl">${esc(label)}</div><div style="font-size:22px;font-weight:900">${esc(vs[vs.length - 1])}${unit || ''}</div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}: ${esc(vs[0])} to ${esc(vs[vs.length - 1])}"><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  }
  async function staffTrend(el) {
    if (!el) return;
    try {
      const r = await fetch('/api/staff/trend', { headers: tttHeaders() }); if (!r.ok) { el.innerHTML = ''; return; }
      const days = (await r.json()).days;
      el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800;margin-bottom:8px">📈 How the club is doing <span style="font-size:11px;font-weight:600;color:#8b95a5">one point a day</span></div><div style="display:flex;gap:16px;flex-wrap:wrap">${mini(days.map(x => x.attention), 'Needs attention', '#FBBF24')}${mini(days.map(x => x.racing), 'ZRL riders racing', 'var(--accent)')}${mini(days.map(x => x.unplaced), 'Riders without a team', '#f87171')}</div></div>`;
    } catch (e) { el.innerHTML = ''; }
  }
  // My Profile: the power curve (from the numbers already on the page) and my vELO over the last weeks.
  async function profileCharts(el, pow, own) {
    if (!el) return;
    const pts = [['5s', pow.wkg5], ['15s', pow.wkg15], ['30s', pow.wkg30], ['1m', pow.wkg60], ['5m', pow.wkg300], ['20m', pow.wkg1200]].map(([l, v]) => [l, Number(v) || 0]);
    const W = 300, H = 110, max = Math.max(...pts.map(p => p[1]), 1);
    const xy = pts.map((p, i) => [Math.round(10 + i / (pts.length - 1) * (W - 20)), Math.round(H - 22 - p[1] / max * (H - 40))]);
    const curve = pts.some(p => p[1]) ? `<div style="flex:2;min-width:240px"><div class="lbl">Power curve (W/kg)</div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Power curve: ${pts.map(p => p[0] + ' ' + p[1].toFixed(2)).join(', ')}"><path d="${xy.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${xy.map((q, i) => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="var(--accent)"/><text x="${q[0]}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#8b95a5">${pts[i][0]}</text>`).join('')}</svg></div>` : '';
    let velo = '';
    if (own) { try { const r = await fetch('/api/me/velo', { headers: tttHeaders() }); if (r.ok) velo = mini((await r.json()).history.map(x => x.v), 'My vELO', '#10B981'); } catch (e) { /* the curve still shows */ } }
    el.innerHTML = curve || velo ? `<div class="card" style="padding:16px;margin-bottom:16px"><div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">${curve}${velo}</div></div>` : '';
  }

  // A square picture for a post (Instagram needs one): the headline and a few lines on the club colours, as base64 PNG for the studio.
  async function postCardPng(title, lines) {
    const W = 1080, c = document.createElement('canvas'); c.width = W; c.height = W; const g = c.getContext('2d'), a = accentNow();
    const bg = g.createLinearGradient(0, 0, W, W); bg.addColorStop(0, '#060a14'); bg.addColorStop(1, '#10203a'); g.fillStyle = bg; g.fillRect(0, 0, W, W);
    g.fillStyle = a; g.fillRect(0, 0, W, 16); g.textAlign = 'left';
    g.font = '700 38px system-ui,sans-serif'; g.fillText('TEAM CRYO-GEN', 80, 120);
    g.fillStyle = '#fff'; g.font = '800 78px system-ui,sans-serif';
    const wrap = (t, max, font) => { g.font = font; const words = String(t).split(/\s+/), out = []; let cur = ''; for (const w of words) { if (g.measureText((cur + ' ' + w).trim()).width > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); } if (cur) out.push(cur); return out; };
    let y = 240; for (const l of wrap(title, 920, '800 78px system-ui,sans-serif').slice(0, 3)) { g.fillText(l, 80, y); y += 92; }
    y += 20; g.font = '500 44px system-ui,sans-serif'; g.fillStyle = '#d1d5db';
    for (const line of (lines || []).slice(0, 6)) for (const l of wrap(line, 920, '500 44px system-ui,sans-serif').slice(0, 2)) { if (y > 940) break; g.fillText(l, 80, y); y += 60; }
    g.fillStyle = '#7b8494'; g.font = '500 30px system-ui,sans-serif'; g.fillText('club.cryo-gen.team', 80, 1020);
    const blob = await new Promise(res => c.toBlob(res, 'image/png')); if (!blob) throw new Error('Could not draw the picture.');
    const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  // Called once a rider is signed in: avatars, pinned pages, charts.
  async function afterLogin() { await loadAvatars(); pins(); try { if (typeof renderAll === 'function') renderAll(); } catch (e) { /* drawn later */ } }

  window.uiLineupCard = lineupCard; window.uiResultsCard = resultsCard; window.uiStaffTrend = staffTrend; window.uiProfileCharts = profileCharts; window.uiSeasonQuick = seasonQuick;
  window.uiPreset = preset; window.uiPin = pin; window.uiAvatarSet = avatarSet; window.uiEmpty = empty; window.uiMonthBox = monthBox; window.uiCalendarInto = calendarInto;
  window.uiPodium = podium; window.uiPointsChart = pointsChart; window.uiSeries = seriesAccent; window.uiLogin = afterLogin;
  window.uiSet = set; window.uiToggle = toggle; window.uiMove = move; window.uiReset = reset; window.uiClose = close; window.uiOpen = open; window.uiSaveClub = saveClub;
  window.uiCharts = charts; window.uiAvatar = avatar; window.uiTeamColor = teamColor; window.uiRaceDay = raceDay; window.uiSeasonVisual = d => { lastSeason = d; return seasonVisual(d); };
  window.uiSeasonShare = seasonShare; window.uiStartPage = startPage; window.uiApply = apply; window.uiPrefs = prefs;
  apply(); loadClub();
})();

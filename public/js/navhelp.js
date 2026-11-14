'use strict';
// Getting around: one place that makes the app easy to navigate for everyone, without changing what any page does.
//  - "What would you like to do?": big buttons on Home for the things this person actually does (members and staff see different ones).
//  - "Go to": type what you want ("sign up", "emails", "my team") and jump there. Button in the header, or press G (or Ctrl/Cmd+K for riders; staff keep Ctrl/Cmd+K for rider search).
//  - "You are here": a slim strip on every page with where you are and, in a sentence, what the page is for (each can be dismissed).
//  - Phones: a bottom bar (Home, Races, Me, Go to, Staff) that opens short lists, instead of a strip of 25 small buttons.
// Everything is built from the menu that is already on the page, so a page the person cannot see is never offered.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).toLowerCase();
  // What each page is for, in plain words, and the words people would use to look for it.
  const PAGES = {
    dashboard: ['Your starting point: club numbers, your week and anything that needs you.', 'home start overview results standings stats club'],
    week: ['Everything coming up for you in the next seven days, in one list.', 'my week upcoming calendar this week schedule todo'],
    upgrade: ['Ask to become a full member of the club.', 'become member upgrade join associate full'],
    profile: ['Your own rider page: results, power, badges, calendar link and notifications.', 'my profile stats power ftp badges avatar calendar discord notifications'],
    mydetails: ['Your name, email choices and requests to the club: changes, leaving, questions.', 'my details email preferences unsubscribe newsletter name change leave request password account'],
    plan: ['Your training plan, week by week, built from your power.', 'my plan training season ftp workouts'],
    captain: ['For team captains: who has answered, the line-up, and one-tap reminders.', 'my team captain lineup line-up availability remind'],
    coach: ['An AI coach that looks at your recent riding and suggests what to do next.', 'coach ai training advice'],
    racing: ['How the club is doing across all racing: leaders, categories and form.', 'racing leaderboard results category rankings'],
    zrl: ['Zwift Racing League team racing: sign up, your team, availability each race week.', 'zrl zwift racing league team sign up availability weeks off change team results'],
    ttt: ['This week\'s team time trial: sign up, see your team and the result.', 'ttt team time trial sign up this week'],
    season: ['The team time trial season: points, history and standings.', 'ttt season standings points history'],
    ladder: ['Head-to-head ladder matches against other club riders.', 'ladder challenge match head to head'],
    drs: ['The DIRT series: gravel and mixed-surface racing.', 'dirt drs gravel series squad'],
    events: ['Every event and ride you can join, with sign-up buttons.', 'events sign up signup join races calendar book enter'],
    rides: ['Relaxed social group rides, ride leaders and ride cover.', 'social rides group ride leader cover'],
    members: ['The club roster: find a rider, see their details and status.', 'members riders roster find search people directory'],
    standard: ['The club\'s fair-play standard and how to keep your racing above board.', 'fair play rules standard dual recording honesty'],
    comms: ['Messages to members: Discord links, reminders and what has been sent.', 'comms messages discord reminders notifications announcements'],
    fair: ['Staff: possible fair-play flags to look at.', 'fair play flags cheating weight checks investigate'],
    clubstats: ['Staff: how healthy the club is: activity, joiners and leavers.', 'club health stats numbers growth engagement'],
    studio: ['Staff: write and schedule posts for Discord and social channels.', 'studio posts social media announcements write'],
    control: ['Staff: race day at a glance, join requests, systems and settings.', 'control room race day join requests systems health settings security access welcome'],
    aidesk: ['Staff: AI helpers for line-ups, replies and reports.', 'ai desk assistant lineups replies reports radio certificates'],
    mail: ['Staff: write and send emails to members, check recipients first.', 'email mail newsletter send campaign recipients'],
    inv: ['Staff: look into a case about a rider, with all the evidence in one place.', 'investigations cases evidence fit file'],
  };
  const GROUP = { dashboard: 'Home', upgrade: 'Home' };
  const isStaff = () => ['admin', 'mod'].includes(window.role || sessionStorage.getItem('role'));
  const nav = () => document.getElementById('main-nav');
  const shown = b => b && b.style.display !== 'none' && getComputedStyle(b).display !== 'none';
  const idOf = b => { const m = /showTab\('([a-z]+)'/.exec(b.getAttribute('onclick') || ''); return m ? m[1] : ''; };
  const labelOf = b => b.textContent.replace(/\s+/g, ' ').replace(/\d+$/, '').trim();
  const plain = b => labelOf(b).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // The visible menu, with each button's group heading, in menu order.
  function menu() {
    const out = []; let group = '';
    for (const el of (nav() || { children: [] }).children) {
      if (el.classList.contains('navgroup')) { group = el.textContent.trim(); continue; }
      if (!el.classList.contains('navbtn')) continue;
      const id = idOf(el); if (!id || !shown(el)) continue;
      out.push({ id, btn: el, group: group || GROUP[id] || 'Home', label: plain(el), icon: (labelOf(el).match(/^\p{Extended_Pictographic}️?/u) || [''])[0], desc: (PAGES[id] || [''])[0], words: (PAGES[id] || ['', ''])[1] });
    }
    return out;
  }
  const go = id => { const m = menu().find(x => x.id === id); if (m && typeof showTab === 'function') { closeAll(); showTab(id, m.btn); const main = document.getElementById('main'); if (main) { main.scrollTop = 0; main.focus({ preventScroll: true }); } } };
  window.navGo = go;

  // ── "Go to" ──
  function closeAll() { for (const id of ['go-box', 'sheet-box']) { const d = document.getElementById(id); if (d) d.remove(); } }
  function openGo() {
    closeAll();
    const d = document.createElement('div'); d.id = 'go-box'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', 'Go to a page');
    d.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(5,10,20,.82);display:flex;align-items:flex-start;justify-content:center;padding:10vh 12px 12px';
    d.innerHTML = `<div style="background:#0f172a;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px;max-width:520px;width:100%;color:#e5e7eb"><label for="go-q" style="font-weight:800;font-size:15px">Where would you like to go?</label><input id="go-q" type="search" class="inp" placeholder="e.g. sign up, my team, emails, results" autocomplete="off" style="margin:8px 0" aria-controls="go-list"/><div id="go-list" role="listbox" aria-label="Pages" style="max-height:55vh;overflow:auto"></div><div style="font-size:11px;color:#8b95a5;margin-top:8px">↑ ↓ to choose, Enter to go, Esc to close</div></div>`;
    document.body.appendChild(d); d.onclick = e => { if (e.target === d) closeAll(); };
    const q = document.getElementById('go-q'), list = document.getElementById('go-list'); let rows = [], at = 0;
    const draw = () => {
      const words = norm(q.value).split(/\s+/).filter(Boolean), all = menu();
      const stem = w => (w.length > 3 ? w.replace(/(ing|es|s)$/, '') : w);   // "emails" finds "email", "line-ups" finds "line-up"
      rows = all.filter(m => { const hay = norm(`${m.label} ${m.desc} ${m.words} ${m.group}`); return words.every(w => hay.includes(w) || hay.includes(stem(w))); });
      if (!words.length) rows = all;
      at = Math.min(at, Math.max(0, rows.length - 1));
      list.innerHTML = rows.length ? rows.map((m, i) => `<div role="option" id="go-${i}" aria-selected="${i === at}" data-id="${E(m.id)}" style="display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:8px;cursor:pointer;${i === at ? 'background:rgba(var(--accent-rgb),.14)' : ''}"><span aria-hidden="true" style="font-size:18px">${E(m.icon)}</span><span><b>${E(m.label)}</b> <span style="font-size:11px;color:#8b95a5">${E(m.group)}</span><div style="font-size:12px;color:#9ca3af">${E(m.desc)}</div></span></div>`).join('') : '<div style="padding:10px;font-size:13px;color:#8b95a5">Nothing matches that. Try a simpler word, like "race", "email" or "profile".</div>';
      q.setAttribute('aria-activedescendant', rows.length ? `go-${at}` : '');
    };
    q.oninput = () => { at = 0; draw(); };
    q.onkeydown = e => { if (e.key === 'ArrowDown') { at = Math.min(rows.length - 1, at + 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { at = Math.max(0, at - 1); draw(); e.preventDefault(); } else if (e.key === 'Enter' && rows[at]) go(rows[at].id); else if (e.key === 'Escape') closeAll(); };
    list.onclick = e => { const r = e.target.closest('[data-id]'); if (r) go(r.dataset.id); };
    draw(); q.focus();
  }
  window.navOpenGo = openGo;

  // ── Phone bottom bar and its lists ──
  function sheet(title, groups) {
    closeAll();
    const d = document.createElement('div'); d.id = 'sheet-box'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title);
    d.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(5,10,20,.7);display:flex;align-items:flex-end;justify-content:center';
    const all = menu(), sel = groups.map(g => [g, all.filter(m => m.group === g)]).filter(([, l]) => l.length);
    d.innerHTML = `<div style="background:#0f172a;border-top:1px solid rgba(255,255,255,.14);border-radius:16px 16px 0 0;padding:14px 14px 18px;width:100%;max-height:75vh;overflow:auto;color:#e5e7eb"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b style="font-size:16px">${E(title)}</b><button type="button" id="sheet-x" aria-label="Close" style="background:none;border:none;color:#9ca3af;font-size:22px;padding:4px 8px">×</button></div>${sel.map(([g, l]) => `${groups.length > 1 ? `<div class="navgroup" style="padding:8px 0 2px">${E(g)}</div>` : ''}${l.map(m => `<button type="button" data-id="${E(m.id)}" style="display:flex;gap:12px;align-items:center;width:100%;text-align:left;padding:11px 8px;background:none;border:none;border-bottom:1px solid rgba(255,255,255,.06);color:#e5e7eb"><span aria-hidden="true" style="font-size:20px;width:26px">${E(m.icon)}</span><span><b style="font-size:14px">${E(m.label)}</b><span style="display:block;font-size:12px;color:#9ca3af">${E(m.desc)}</span></span></button>`).join('')}`).join('') || '<div style="padding:10px;color:#8b95a5;font-size:13px">Nothing here for you yet.</div>'}</div>`;
    document.body.appendChild(d); d.onclick = e => { if (e.target === d || e.target.id === 'sheet-x') return closeAll(); const b = e.target.closest('[data-id]'); if (b) go(b.dataset.id); };
    d.onkeydown = e => { if (e.key === 'Escape') closeAll(); }; const x = document.getElementById('sheet-x'); if (x) x.focus();
  }
  function buildBar() {
    if (document.getElementById('bottom-bar')) return;
    const b = document.createElement('nav'); b.id = 'bottom-bar'; b.setAttribute('aria-label', 'Quick menu');
    const item = (id, icon, label, fn) => `<button type="button" id="bb-${id}" onclick="${fn}"><span aria-hidden="true" style="font-size:20px;line-height:1">${icon}</span><span>${label}</span></button>`;
    b.innerHTML = item('home', '🏠', 'Home', "navGo('dashboard')") + item('races', '🏁', 'Races', "navSheet('races')") + item('me', '🙋', 'Me', "navSheet('me')") + item('staff', '🛠️', 'Staff', "navSheet('staff')") + item('go', '🧭', 'Go to', 'navOpenGo()');
    document.body.appendChild(b);
  }
  window.navSheet = which => sheet({ races: 'Races and rides', me: 'Me', staff: 'Staff tools' }[which], { races: ['Racing', 'Rides'], me: ['Me', 'Club'], staff: ['Staff tools'] }[which]);

  // ── "You are here" strip ──
  const dismissed = () => { try { return JSON.parse(localStorage.getItem('cgHelpOff') || '{}'); } catch (e) { return {}; } };
  function here(id) {
    let el = document.getElementById('page-help'); const mainBox = document.querySelector('#main > div'); if (!mainBox) return;
    if (!el) { el = document.createElement('div'); el.id = 'page-help'; el.setAttribute('role', 'note'); mainBox.insertBefore(el, mainBox.firstChild); }
    const m = menu().find(x => x.id === id);
    if (!m || id === 'dashboard') { el.style.display = 'none'; return; }
    const off = dismissed()[id];
    el.style.cssText = 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin:0 0 14px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);font-size:12px;color:#9ca3af';
    el.innerHTML = `<nav aria-label="You are here" style="white-space:nowrap"><a href="#" onclick="navGo('dashboard');return false" style="color:var(--accent)">🏠 Home</a> › ${m.group !== 'Home' ? E(m.group) + ' › ' : ''}<b style="color:#e5e7eb">${E(m.label)}</b></nav>${off || !m.desc ? '' : `<span style="flex:1;min-width:180px">${E(m.desc)}</span><button type="button" onclick="navHelpOff('${E(id)}')" title="Hide this hint" style="background:none;border:none;color:#8b95a5;font-size:12px;padding:0 4px">Got it ✕</button>`}`;
  }
  window.navHelpOff = id => { const d = dismissed(); d[id] = 1; try { localStorage.setItem('cgHelpOff', JSON.stringify(d)); } catch (e) { /* the hint just comes back next time */ } here(id); };

  // ── "What would you like to do?" on Home ──
  const TILES_MEMBER = [['events', 'Sign up for a race or ride'], ['week', 'See my week'], ['zrl', 'ZRL team racing'], ['ttt', 'This week\'s team time trial'], ['drs', 'DIRT racing'], ['rides', 'Social rides'], ['captain', 'Look after my team'], ['profile', 'My profile and stats'], ['mydetails', 'My details and emails'], ['plan', 'My training plan'], ['upgrade', 'Become a full member']];
  const TILES_STAFF = [['control', 'Race day and club health'], ['members', 'Find a member'], ['mail', 'Send an email'], ['week', 'See the week ahead'], ['aidesk', 'AI helpers'], ['studio', 'Write a post'], ['comms', 'Message members'], ['clubstats', 'How the club is doing'], ['fair', 'Fair-play flags'], ['inv', 'Open a case']];
  function launcher() {
    const page = document.getElementById('page-dashboard'); if (!page) return;
    let el = document.getElementById('home-launch'); if (!el) { el = document.createElement('div'); el.id = 'home-launch'; page.insertBefore(el, page.firstChild); }
    const all = menu(), want = (isStaff() ? TILES_STAFF : TILES_MEMBER), tiles = want.map(([id, hint]) => [all.find(m => m.id === id), hint]).filter(([m]) => m).slice(0, 8);
    if (!tiles.length) { el.innerHTML = ''; return; }
    const open = (() => { try { return localStorage.getItem('cgHomeOpen') !== '0'; } catch (e) { return true; } })();
    el.innerHTML = `<details ${open ? 'open' : ''} class="card" style="padding:12px 14px;margin-bottom:14px" ontoggle="try{localStorage.setItem('cgHomeOpen',this.open?'1':'0')}catch(e){}"><summary style="cursor:pointer;font-weight:800;font-size:15px">What would you like to do?</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px">${tiles.map(([m, hint]) => `<button type="button" onclick="navGo('${E(m.id)}')" style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#e5e7eb"><span aria-hidden="true" style="font-size:22px">${E(m.icon)}</span><b style="font-size:13px">${E(hint)}</b></button>`).join('')}</div><div style="font-size:11px;color:#8b95a5;margin-top:8px">Looking for something else? Press <b>G</b> or use <b>🧭 Go to</b> and type what you want.</div></details>`;
  }

  // ── Tooltips, header button, wiring ──
  function decorate() {
    for (const m of menu()) { m.btn.title = m.desc || ''; }
    const hdr = document.getElementById('role-display');
    if (hdr && !document.getElementById('go-btn')) { const b = document.createElement('button'); b.id = 'go-btn'; b.type = 'button'; b.onclick = openGo; b.setAttribute('aria-label', 'Go to a page (press G)'); b.title = 'Go to a page (press G)'; b.textContent = '🧭 Go to'; b.style.cssText = 'padding:5px 11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#9ca3af;font-size:11px'; hdr.insertBefore(b, document.getElementById('badge-wrap') || hdr.children[1] || null); }
    const staffBtn = document.getElementById('bb-staff'); if (staffBtn) staffBtn.style.display = menu().some(m => m.group === 'Staff tools') ? '' : 'none';
  }
  function refresh() { try { const app = document.getElementById('app'); document.body.classList.toggle('in-app', !!app && getComputedStyle(app).display !== 'none'); decorate(); launcher(); const cur = (document.querySelector('.page.active') || {}).id || ''; here(cur.replace(/^page-/, '')); } catch (e) { /* navigation helpers must never stop the app */ } }
  document.addEventListener('keydown', e => {
    const t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (document.getElementById('app') && getComputedStyle(document.getElementById('app')).display === 'none') return;
    if (document.getElementById('welcome-gate')) return;
    if (!typing && e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openGo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !isStaff()) { e.preventDefault(); openGo(); }
    else if (e.key === 'Escape') closeAll();
  });
  let fromBack = false;
  window.addEventListener('popstate', e => { const id = e.state && e.state.tab; if (!id) return; const m = menu().find(x => x.id === id); if (m) { fromBack = true; try { showTab(id, m.btn); } finally { fromBack = false; } } });
  function wrap() {
    if (typeof window.showTab === 'function' && !window.showTab.__nav) {
      const orig = window.showTab;
      window.showTab = function (id, btn) {
        const r = orig.apply(this, arguments); here(id);
        // The browser's Back button (and a phone's Back gesture) goes to the page before, instead of leaving the app; the tab title says where you are.
        try { const m = menu().find(x => x.id === id); document.title = (m ? m.label + ' · ' : '') + 'CRYO-GEN'; if (!fromBack && (history.state || {}).tab !== id) history.pushState({ tab: id }, '', location.pathname + location.search); } catch (e) { /* history is a convenience */ }
        return r;
      }; window.showTab.__nav = 1;
    }
    if (typeof window.launchApp === 'function' && !window.launchApp.__nav) { const orig = window.launchApp; window.launchApp = function () { const r = orig.apply(this, arguments); setTimeout(refresh, 0); setTimeout(refresh, 1200); return r; }; window.launchApp.__nav = 1; }
  }
  document.addEventListener('DOMContentLoaded', () => { buildBar(); wrap(); refresh(); setTimeout(refresh, 800); });
})();

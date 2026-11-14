'use strict';
// Getting around, part two. The grouped menu, "Go to" (the 🔎 button or "/") and the phone bottom bar are in quickfind.js and tabbar.js; this adds what they do not:
//  - "What would you like to do?": big buttons on Home for the things this person actually does (members and staff see different ones).
//  - "You are here": a slim strip on every page with where you are and, in a sentence, what the page is for (each can be dismissed).
//  - The browser's Back button (and a phone's Back gesture) goes to the previous page inside the app; the tab title shows the page.
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
  const go = id => { const m = menu().find(x => x.id === id); if (m && typeof showTab === 'function') { showTab(id, m.btn); const main = document.getElementById('main'); if (main) { main.scrollTop = 0; main.focus({ preventScroll: true }); } } };
  window.navGo = go;

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
    el.innerHTML = `<details ${open ? 'open' : ''} class="card" style="padding:12px 14px;margin-bottom:14px" ontoggle="try{localStorage.setItem('cgHomeOpen',this.open?'1':'0')}catch(e){}"><summary style="cursor:pointer;font-weight:800;font-size:15px">What would you like to do?</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px">${tiles.map(([m, hint]) => `<button type="button" onclick="navGo('${E(m.id)}')" style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#e5e7eb"><span aria-hidden="true" style="font-size:22px">${E(m.icon)}</span><b style="font-size:13px">${E(hint)}</b></button>`).join('')}</div><div style="font-size:11px;color:#8b95a5;margin-top:8px">Looking for something else? Press <b>/</b> or tap the <b>🔎</b> button and type a page name.</div></details>`;
  }

  // ── Tooltips, header button, wiring ──
  function decorate() { for (const m of menu()) { m.btn.title = m.desc || ''; } }
  function refresh() { try { decorate(); launcher(); const cur = (document.querySelector('.page.active') || {}).id || ''; here(cur.replace(/^page-/, '')); } catch (e) { /* navigation helpers must never stop the app */ } }
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
  document.addEventListener('DOMContentLoaded', () => { wrap(); refresh(); setTimeout(refresh, 800); });
})();

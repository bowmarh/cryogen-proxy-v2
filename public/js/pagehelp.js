'use strict';
// "What is this page?": one plain sentence at the top of every page, plus the words that page uses (vELO, FTP, cat…) in plain English.
// It opens by itself the first time a person visits a page and stays closed after that (they can open it again any time). Nothing is sent anywhere.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const W = {
    cat: 'Cat: race category, A+ (strongest) down to D.', velo: 'vELO: the ZwiftRacing.app rating. It goes up when you beat riders rated higher than you.', tier: 'Tier: the named band a vELO rating falls in (Diamond, Ruby, Emerald, Sapphire, Amethyst, Platinum, Gold, Silver, Bronze, Copper).',
    ftp: 'FTP: roughly the most power you can hold for an hour, in watts.', wkg: 'W/kg: your power divided by your weight. It matters most on climbs.', phen: 'Phenotype: the kind of rider the numbers say you are (sprinter, climber, all-rounder…).',
    full: 'Full or Associate: Full members can use everything. Associates have limited access until the club approves them as full members.', ttt: 'TTT: team time trial, where a team rides together against the clock.', zrl: 'ZRL: Zwift Racing League, the team league the club enters.',
  };
  const HELP = {
    dashboard: ['Your home screen: what is happening in the club, your next races and anything that needs your answer.', []],
    week: ['What needs your attention, and what is coming up in the next seven days.', []],
    racing: ['Live club results and rankings from ZwiftRacing.app: who has raced, how they placed and how riders are rated.', ['velo', 'tier', 'cat']],
    zrl: ['Zwift Racing League: your team, the next race, who is available and the line-up.', ['zrl', 'cat']],
    ttt: ['Team time trial week: sign up, see who is riding in each team, and the results.', ['ttt']],
    season: ['Team time trial results for the whole season: standings, and who has ridden most.', ['ttt']],
    ladder: ['The Club Ladder: five-rider head-to-head races. See the challenges, line-ups and results.', ['velo', 'tier']],
    drs: ['The DIRT Racing Series: stages, scoring and standings.', []],
    events: ['Race series and team events you can sign up for.', []],
    rides: ['Social rides: who is covering the ride, the club calendar, and who has said they are coming.', []],
    members: ['Everyone in the club. Search by name or Zwift ID, narrow with the buttons, and open a rider for their details.', ['full', 'cat', 'velo', 'ftp', 'wkg', 'phen']],
    standard: ['The club\'s fair play standard: what we expect from everyone who races under the club name.', []],
    profile: ['Your own page: your details, your picture, and which messages you get.', []],
    mydetails: ['The details the club holds about you. Check they are right and ask for a change if not.', []],
    plan: ['Your training plan, built from your own FTP and the hours you have each week.', ['ftp']],
    captain: ['Your team as captain: who has said yes, maybe or no, and the suggested line-up.', ['zrl']],
    coach: ['Training help from the club\'s AI coach.', ['ftp']],
    upgrade: ['How to become a full member of the club.', ['full']],
    comms: ['Messages to riders: reminders by Discord, and who gets which messages. Import Discord IDs from here too.', []],
    mail: ['Write, check and send email to everyone, a group or one rider.', []],
    studio: ['Drafts of posts for the club\'s channels. Read, change and approve each one before anything goes out.', []],
    control: ['The control room: how the systems are doing, errors, and the settings for administrators.', []],
    aidesk: ['Ask the club\'s AI to do a club job for you, for example move a ZRL rider. It shows you the plan first.', []],
    clubstats: ['Numbers on how the club is doing: who is active, who has joined, and who has gone quiet.', ['cat']],
    fair: ['Results the fair play checks flagged, for a person to look at.', []],
    inv: ['Look into a case in detail and keep notes on it.', []],
  };
  const KEY = 'cg:help:seen';
  const seen = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
  const mark = id => { try { const s = seen(); s[id] = 1; localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* not kept: it opens again next time */ } };
  function addTo(page) {
    const id = page.id.replace(/^page-/, ''), h = HELP[id]; if (!h || page.querySelector(':scope > .pagehelp')) return;
    const d = document.createElement('details'); d.className = 'pagehelp';
    d.style.cssText = 'margin:0 0 12px;font-size:13px;color:#9aa3b2;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:6px 12px;background:rgba(255,255,255,.02)';
    const words = h[1].map(k => W[k]).filter(Boolean);
    d.innerHTML = `<summary style="cursor:pointer;font-size:12px;font-weight:700;list-style:none">ℹ️ What is this page?</summary><p style="margin:6px 0 2px;line-height:1.5;color:#cbd5e1">${E(h[0])}</p>${words.length ? `<ul style="margin:6px 0 2px 18px;padding:0;line-height:1.5;font-size:12px">${words.map(w => `<li>${E(w)}</li>`).join('')}</ul>` : ''}`;
    if (!seen()[id]) d.open = true;
    d.addEventListener('toggle', () => { if (!d.open) mark(id); });
    page.insertBefore(d, page.firstChild);
  }
  // The first visit leaves it open; leaving the page counts as read, so it is closed next time.
  function sweep() { document.querySelectorAll('.page').forEach(addTo); }
  function leave() { document.querySelectorAll('.page:not(.active) > .pagehelp[open]').forEach(d => { const id = d.parentNode.id.replace(/^page-/, ''); mark(id); d.open = false; }); }
  const start = () => { sweep(); const m = document.getElementById('main'); if (m) new MutationObserver(leave).observe(m, { attributes: true, subtree: true, attributeFilter: ['class'] }); };
  window.addEventListener('load', () => setTimeout(start, 600));
  window.PageHelp = { HELP, sweep };
})();

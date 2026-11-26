'use strict';
// "What's new": a small dismissible card shown once per release on each device, after sign-in. Add a note at the TOP of NOTES when something members or staff will notice ships;
// the id is the key that remembers it was seen. Nothing is sent anywhere.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'cg:whatsnew:seen';
  const NOTES = [
    { id: '2026-12-01', title: "What's new", all: ['The Go to box (press /) now lists the pages you opened lately first.'],
      staff: [] },
    { id: '2026-11-30', title: "What's new", all: ['Home now celebrates a new personal best finish and your first podium.'],
      staff: [] },
    { id: '2026-11-29', title: "What's new", all: ['Keyboard shortcuts: press ? for the list, or g then a letter to jump to a page (g z for ZRL).', 'Pages now show a soft placeholder while they load instead of a bare "Loading…".'],
      staff: [] },
    { id: '2026-11-28', title: "What's new", all: ['Home has a ☀️ Today strip: what is on for you today, in time order.', 'Your racing streak now forgives one missed week a month (🧊).', 'Every Monday the bell carries a one-line recap of the club\'s week.'],
      staff: [] },
    { id: '2026-11-27', title: "What's new", all: ['Home has a club challenge: everyone\'s race finishes this month against a team goal, with a progress bar.'],
      staff: [] },
    { id: '2026-11-26', title: "What's new", all: ['Home has a weekly goal ring, race badges and a "My season so far" recap.', 'Results have a 👏 button: give a clubmate kudos for a good race. If someone cheers yours, Home tells you.'],
      staff: [] },
    { id: '2026-11-25', title: "What's new", all: ['Results now have a monthly points league: 3 points a finish, +1 for a top 10, and +4/+6/+10 for a podium. Most points wins the month.', 'Race two weeks in a row and Home shows your 🔥 racing streak.', 'Results read from ZwiftRacing.app carry a ✓ Verified badge.'],
      staff: [] },
    { id: '2026-11-24', title: "What's new", all: [],
      staff: ['ZRL results: copy the table straight off the WTRL page and paste it. No heading row needed; your teams are found by name and the place beside each one.'] },
    { id: '2026-11-23', title: "What's new", all: ['Your Home page now has "Where you stand": your last race in a sentence (who you beat, who was just ahead, by how much) and your place in the club by vELO, with a Share button.'],
      staff: [] },
    { id: '2026-11-22', title: "What's new", all: ['My Profile now shows your Zwift ID and your time zone, with a Change button (on a phone it used to be hidden behind the ⋯ menu).', 'The race-day card says when the race starts in your time zone, with a link if the zone is wrong.', 'On a phone, prompts like "Stay signed in" now sit at the top so they never cover the bottom controls, and can be closed with ×.'],
      staff: [] },
    { id: '2026-11-20', title: "What's new", all: [],
      staff: ['TTT is every Thursday: new weeks now default to Thursday. If this week shows another day, TTT Week has a "Move to Thursday" button (sign-ups and line-ups stay).'] },
    { id: '2026-11-19', title: "What's new", all: ['🔔 The bell at the top shows the latest club news, such as "rosters are out", with a count of what is new.', '📺 If you stream your races, add your link on the ZRL page; everyone can see who is streaming, grouped by team.', 'TTT invitations now have "Not this week", so they stop nagging.', 'The ZRL page can show links to the league\'s RacePass, results and standings.'],
      staff: ['Staff can post a line to everyone\'s bell, and an administrator adds the ZRL league links on the ZRL page.'] },
    { id: '2026-11-18', title: "What's new", all: ['Click the logo or "Team CRYO-GEN" at the top to go to the home page.', 'On a narrow window the menu no longer disappears: tap the ☰ button to open it.', 'Pinned pages now sit below Home and your own pages.', 'Racing: the # is now each rider\'s real place by vELO, and each rider shows their own phenotype.', 'Sign out now clears this device properly and tells you when it is done.'],
      staff: [] },
    { id: '2026-11-17', title: "What's new", all: [],
      staff: ['Discord matching is smarter (joined-up names, tags, typos, a Zwift ID in the name).', 'Comms → Import Discord IDs: one click writes an email to everyone who has not linked their Discord yet, so they link themselves.', 'The Discord CSV now keeps the full ID numbers in Excel.'] },
    { id: '2026-11-16', title: "What's new", all: ['Every page now has a "What is this page?" box at the top that says what it is for and explains words like vELO and FTP.', 'New one-minute tour: open Go to (the 🔎 button or the / key) and pick Quick tour.', 'Column headings explain themselves when you hover over them.'],
      staff: ['The Discord member list can be downloaded as a CSV from Comms → Import Discord IDs.'] },
    { id: '2026-11-15', title: "What's new", all: ['Easier menu: pages are grouped (Me, Racing, Rides, Club). Dashboard is now called Home.', 'Press / (or tap the 🔎 button) and type a page name to jump straight to it.', 'On a phone the menu is now a bar at the bottom, with More for everything else.'],
      staff: ['Staff pages are together under "Staff tools".', 'Download the Discord member list as a CSV from Comms → Import Discord IDs.'] },
    { id: '2026-11-14', title: "What's new", all: ['Quicker sign-in: stay signed in with a passcode or Face ID / fingerprint.', 'Search boxes on most lists: type a name, a Zwift ID or a category.'],
      staff: ['Click a column heading to sort. Staff can also download any list as a spreadsheet file.', 'Type name:ann or score>20 in a list filter to filter one column.', 'Quick views on Members (for example Associates, Not on ZwiftPower). Saved views follow you between devices.'] },
  ];
  const TIPS = ['Lists have a search box: type a name, a Zwift ID or a category to narrow them.', 'If you see an Install app button at the top, it puts the club app on your home screen.', 'After you sign in, you can choose to stay signed in with a passcode or Face ID / fingerprint.'];
  const staff = () => ['admin', 'mod'].includes(window.role || sessionStorage.getItem('role'));
  const seen = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return NOTES[0].id; } };
  const mark = id => { try { localStorage.setItem(KEY, id); } catch (e) { /* not kept: it shows again next time */ } };
  function show() {
    const n = NOTES[0]; if (!n || seen() === n.id || document.getElementById('whatsnew')) return;
    const first = seen() === '';   // a brand-new device: no change list; a rider gets a few first-visit tips instead, once
    if (first) { mark(n.id); if (staff()) return; }
    const items = first ? TIPS : [...n.all, ...(staff() ? n.staff : [])], title = first ? 'Quick tips' : n.title;
    if (!items.length) { mark(n.id); return; }   // nothing in this release for this person
    const host = document.querySelector('.page.active') || document.body;
    const d = document.createElement('div'); d.id = 'whatsnew'; d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;max-width:440px;width:calc(100% - 32px);background:#0f1a2e;border:1px solid rgba(0,212,255,.35);border-radius:12px;padding:12px 14px;color:#e5e7eb;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    d.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b>✨ ${E(title)}</b><button type="button" id="whatsnew-x" aria-label="Dismiss" style="background:none;border:0;color:#9ca3af;font-size:18px;cursor:pointer">×</button></div><ul style="margin:8px 0 0 18px;padding:0;line-height:1.5">${items.map(i => `<li>${E(i)}</li>`).join('')}</ul>`;
    if (first && window.Tour) { const tb = document.createElement('button'); tb.type = 'button'; tb.textContent = '🎬 Take the one-minute tour'; tb.className = 'btn-cyan'; tb.style.cssText = 'width:auto;margin-top:10px;padding:7px 14px'; tb.onclick = () => { d.remove(); Tour.start(); }; d.appendChild(tb); }
    (host === document.body ? host : document.body).appendChild(d);
    document.getElementById('whatsnew-x').onclick = () => { mark(n.id); d.remove(); };
  }
  window.WhatsNew = { show, NOTES };
  // Shown a few seconds after the app opens (the sign-in screen has gone by then).
  const tick = () => { const ls = document.getElementById('login-screen'); if (ls && ls.offsetParent !== null) return setTimeout(tick, 3000); show(); };
  window.addEventListener('load', () => setTimeout(tick, 4000));
})();

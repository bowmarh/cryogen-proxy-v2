'use strict';
// Phone bottom bar: the five things most people want, one tap away, in thumb reach. "More" opens the Go to list of every page. It only shows on phones held upright
// (the CSS decides); on bigger screens the side menu is used and this bar stays hidden.
(function () {
  const TABS = [['dashboard', '🏠', 'Home'], ['week', '📌', 'Week'], ['racing', '🏆', 'Racing'], ['events', '📅', 'Events'], ['members', '👥', 'Members']];
  const btnFor = id => [...document.querySelectorAll('#main-nav > button.navbtn')].find(b => !b.dataset.pin && new RegExp(`showTab\\('${id}'`).test(b.getAttribute('onclick') || ''));
  function build() {
    const app = document.getElementById('app'); if (!app || document.getElementById('tabbar')) return;
    const bar = document.createElement('nav'); bar.id = 'tabbar'; bar.setAttribute('aria-label', 'Main');
    bar.innerHTML = TABS.map(([id, ico, lab]) => `<button type="button" data-tab="${id}"><span aria-hidden="true">${ico}</span><span>${lab}</span></button>`).join('') + '<button type="button" data-more="1" aria-haspopup="dialog"><span aria-hidden="true">☰</span><span>More</span></button>';
    app.appendChild(bar);
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.more) { if (window.QuickFind) QuickFind.open(); return; }
      const nb = btnFor(b.dataset.tab); if (nb) nb.click();
    });
    sync();
  }
  function sync() {
    const bar = document.getElementById('tabbar'); if (!bar) return;
    const page = document.querySelector('.page.active'), id = page ? page.id.replace(/^page-/, '') : '';
    let any = false;
    bar.querySelectorAll('button[data-tab]').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('on', on); if (on) { b.setAttribute('aria-current', 'page'); any = true; } else b.removeAttribute('aria-current'); const nb = btnFor(b.dataset.tab); b.style.display = nb && nb.style.display === 'none' ? 'none' : ''; });
    const more = bar.querySelector('[data-more]'); if (more) more.classList.toggle('on', !any);   // on a page that is not one of the four: "More" is where you are
  }
  const wrap = () => { if (typeof window.showTab !== 'function' || window.showTab.__tb) return; const o = window.showTab; window.showTab = function () { const r = o.apply(this, arguments); sync(); return r; }; window.showTab.__tb = true; };
  let queued = false; const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; sync(); }); };
  // The app switches pages and shows or hides menu items in many places; watching the page and menu classes and styles keeps the bar right without touching each one.
  function watch() { const app = document.getElementById('app'); if (app) new MutationObserver(recs => { const bar = document.getElementById('tabbar'); if (recs.some(r => !bar || !bar.contains(r.target))) later(); }).observe(app, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] }); }
  window.addEventListener('load', () => { wrap(); build(); watch(); setTimeout(() => { build(); sync(); }, 800); });

  // The side menu as a drawer on narrow windows (CSS shows the ☰ button and hides the menu until it is opened).
  function menuEls() { return [document.getElementById('sidebar'), document.getElementById('menu-scrim'), document.getElementById('menu-btn')]; }
  function setMenu(open) {
    const [sb, sc, btn] = menuEls(); if (!sb) return;
    sb.classList.toggle('open', open); if (sc) sc.classList.toggle('open', open); document.body.classList.toggle('menu-open', open);
    if (btn) { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu'); }
    if (open) { const f = sb.querySelector('.navbtn:not([style*="display: none"])'); if (f) setTimeout(() => f.focus(), 60); } else if (btn && document.activeElement && sb.contains(document.activeElement)) btn.focus();
  }
  window.toggleMenu = () => { const sb = document.getElementById('sidebar'); setMenu(!(sb && sb.classList.contains('open'))); };
  window.closeMenu = () => setMenu(false);
  // The logo and the title take you home, as people expect.
  window.goHome = () => { const b = btnFor('dashboard'); if (b) b.click(); closeMenu(); };
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#main-nav .navbtn')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const sb = document.getElementById('sidebar'); if (sb && sb.classList.contains('open')) setMenu(false); } });
  window.addEventListener('resize', () => { if (window.innerWidth > 900) setMenu(false); });
  window.TabBar = { build, sync };
})();

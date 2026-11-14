'use strict';
// A one-minute guided tour: a spotlight on the menu, the Go to button and the feedback button, with a sentence about each. Open it from the Go to box ("Quick tour")
// or from the first-visit tips. It changes nothing in the app and sends nothing anywhere.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const staff = () => ['admin', 'mod'].includes(window.role || sessionStorage.getItem('role'));
  const shown = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? el : null; };
  const phone = () => !!shown(document.getElementById('tabbar'));
  function steps() {
    const s = [{ title: 'Welcome to the club app', text: 'A one-minute look around. You can leave at any time with Esc or Skip.' }];
    s.push(phone()
      ? { el: () => shown(document.getElementById('tabbar')), title: 'Your main pages', text: 'This bar has the pages most people use. Tap More for every other page.' }
      : { el: () => shown(document.getElementById('sidebar')), title: 'Your menu', text: 'Pages are grouped by purpose: Racing, Rides and Club' + (staff() ? ', and Staff tools for the club\'s admin pages.' : '.') });
    s.push({ el: () => shown(document.getElementById('find-btn')), title: 'Lost? Go to any page', text: 'Tap here, or press / on a keyboard, and type where you want to go, for example "events" or "my details". With nothing typed it lists every page.' });
    s.push({ title: 'What is this page?', text: 'At the top of every page is a small "What is this page?" box. It says in plain words what the page is for and explains words like vELO and FTP.' });
    s.push({ el: () => shown(document.getElementById('fb-btn')), title: 'Something wrong or confusing?', text: 'Tell us here. It goes straight to the people who run the club app.' });
    s.push({ title: 'That is it', text: 'You can run this tour again any time: open Go to and pick "Quick tour".' });
    return s;
  }
  let i = 0, list = [], root = null;
  function close(done) { if (root) { root.remove(); root = null; } document.removeEventListener('keydown', onKey, true); try { if (done) localStorage.setItem('cg:tour:done', '1'); } catch (e) { /* not kept */ } }
  function onKey(e) { if (!root) return; if (e.key === 'Escape') { e.stopPropagation(); close(true); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); } }
  function go(d) { i += d; if (i < 0) i = 0; if (i >= list.length) return close(true); draw(); }
  function draw() {
    const st = list[i], el = st.el ? st.el() : null;
    root.innerHTML = '';
    const spot = document.createElement('div'); spot.setAttribute('aria-hidden', 'true');
    const card = document.createElement('div');
    card.style.cssText = 'position:fixed;z-index:10001;max-width:340px;width:calc(100% - 24px);background:#0f172a;color:#e5e7eb;border:1px solid rgba(var(--accent-rgb),.5);border-radius:14px;padding:14px 16px;box-shadow:0 10px 40px rgba(0,0,0,.6);font-size:14px;line-height:1.5';
    card.innerHTML = `<div style="font-size:11px;color:#9aa3b2;margin-bottom:2px">Step ${i + 1} of ${list.length}</div><div id="tour-t" style="font-weight:800;font-size:16px;margin-bottom:4px">${E(st.title)}</div><div>${E(st.text)}</div><div style="display:flex;gap:8px;margin-top:12px;align-items:center"><button type="button" id="tour-skip" style="background:none;border:0;color:#9aa3b2;cursor:pointer;font-size:12px;padding:6px 4px">Skip</button><span style="flex:1"></span>${i ? '<button type="button" id="tour-back" class="btn-ghost" style="padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:none;color:#e5e7eb;cursor:pointer">Back</button>' : ''}<button type="button" id="tour-next" class="btn-cyan" style="width:auto;padding:7px 16px">${i === list.length - 1 ? 'Done' : 'Next'}</button></div>`;
    if (el) {
      const r = el.getBoundingClientRect(), pad = 6;
      spot.style.cssText = `position:fixed;z-index:10000;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;border-radius:12px;box-shadow:0 0 0 9999px rgba(5,10,20,.75);border:2px solid var(--accent);pointer-events:none`;
      root.append(spot, card);
      const ch = card.offsetHeight || 160, below = r.bottom + 12 + ch < innerHeight;
      if (r.height > innerHeight * 0.5 && r.right + 14 + 340 < innerWidth) { card.style.top = Math.max(70, r.top + 60) + 'px'; card.style.left = (r.right + 14) + 'px'; }   // a tall target such as the side menu: the card goes beside it
      else { card.style.top = Math.max(8, below ? r.bottom + 12 : r.top - ch - 12) + 'px'; card.style.left = Math.min(Math.max(12, r.left), Math.max(12, innerWidth - 352)) + 'px'; }
    } else {
      spot.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(5,10,20,.75)';
      root.append(spot, card); card.style.top = '30%'; card.style.left = '50%'; card.style.transform = 'translateX(-50%)';
    }
    card.querySelector('#tour-next').onclick = () => go(1); card.querySelector('#tour-skip').onclick = () => close(true);
    const b = card.querySelector('#tour-back'); if (b) b.onclick = () => go(-1);
    const nx = card.querySelector('#tour-next'); setTimeout(() => nx.focus(), 60);   // not at once: the Enter that opened the tour must not also press Next
  }
  function start() {
    close(false); list = steps(); i = 0;
    root = document.createElement('div'); root.id = 'tour'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Quick tour'); root.style.cssText = 'position:fixed;inset:0;z-index:9999';
    document.body.appendChild(root); document.addEventListener('keydown', onKey, true); draw();
  }
  window.Tour = { start, close };
})();

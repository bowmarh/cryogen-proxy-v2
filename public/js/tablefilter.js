'use strict';
// A filter box for every long list. A table with MIN or more rows gets "Filter…" above it; typing hides the rows that do not contain every word typed. It matches
// anything in the row: names, Zwift IDs (also the ID behind a rider name), teams, status, dates. Tables that already have their own search are left alone, and
// so is anything marked data-nofilter. A list made of cards instead of a table opts in with data-filterable (its direct children are the items). When the app
// redraws a list the box is kept and re-applied, so what was typed is not lost. Pure display: nothing is sent anywhere.
(function () {
  const MIN = 8, kept = new Map();
  const norm = s => String(s == null ? '' : s).toLowerCase();
  const ownSearch = scope => !!scope && [...scope.querySelectorAll('input')].some(i => !i.classList.contains('tf-input') && /search|filter/i.test(i.placeholder || '') );
  const hay = el => norm(el.textContent) + ' ' + [...el.querySelectorAll('[data-rid],[data-rkey],[title]')].map(x => (x.dataset.rid || '') + ' ' + (x.dataset.rkey || '') + ' ' + (x.getAttribute('title') || '')).join(' ').toLowerCase();

  function makeBox(sig, kind) {
    const box = document.createElement('div'); box.className = 'tf-box'; box.dataset.sig = sig;
    box.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px';
    box.innerHTML = `<input type="search" class="inp tf-input" aria-label="Filter this ${kind}" placeholder="🔎 Filter: name, Zwift ID, anything…" autocomplete="off" style="width:100%;max-width:320px;font-size:13px"><span class="tf-count" aria-live="polite" style="font-size:11px;color:#8b95a5"></span>`;
    return box;
  }
  const items = target => target.tagName === 'TABLE' ? [...target.querySelectorAll('tr')].filter(r => r.querySelector('td')) : [...target.children].filter(c => !c.classList.contains('tf-box'));
  function apply(box) {
    const t = box.__target; if (!t || !t.isConnected) return;
    const q = norm(box.querySelector('input').value).split(/\s+/).filter(Boolean), rows = items(t); let shown = 0, last = true;
    for (const r of rows) {
      const detail = t.tagName === 'TABLE' && r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1;   // an expanding detail row follows its parent row
      const ok = detail ? last : q.every(w => hay(r).includes(w));
      r.hidden = !ok; if (!detail) { last = ok; if (ok) shown++; }
    }
    box.querySelector('.tf-count').textContent = q.length ? `${shown} of ${rows.filter(r => !(t.tagName === 'TABLE' && r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1)).length}` : '';
    kept.set(box.dataset.sig, box.querySelector('input').value);
  }
  function attach(target, kind) {
    let anchor = target;
    if (target.tagName === 'TABLE' && target.parentElement && /overflow/.test(target.parentElement.getAttribute('style') || '') && target.parentElement.children.length === 1) anchor = target.parentElement;
    if (!anchor.parentNode) return;
    const page = target.closest('.page'), heads = target.tagName === 'TABLE' ? [...target.querySelectorAll('th')].map(h => h.textContent.trim()).join('|') : (target.id || target.className || '');
    const sig = `${page ? page.id : ''}|${kind}|${heads}`.slice(0, 200);
    let box = anchor.previousElementSibling && anchor.previousElementSibling.classList.contains('tf-box') ? anchor.previousElementSibling : null;   // the app redrew the list: keep the box
    if (!box) { box = makeBox(sig, kind); anchor.parentNode.insertBefore(box, anchor); box.querySelector('input').addEventListener('input', () => apply(box)); const was = kept.get(sig); if (was) box.querySelector('input').value = was; }
    box.__target = target; target.dataset.tf = '1'; apply(box);
  }
  function scan() {
    for (const t of document.querySelectorAll('table:not([data-tf])')) {
      if (t.closest('[data-nofilter],[role=dialog],.modal,#login-screen,.tf-box')) continue;
      if (items(t).length < MIN) continue;
      const scope = t.closest('.card,.page'); if (ownSearch(scope)) { t.dataset.tf = 'own'; continue; }
      attach(t, 'list');
    }
    for (const c of document.querySelectorAll('[data-filterable]:not([data-tf])')) { if (items(c).length >= MIN || c.dataset.filterable === 'always') attach(c, 'list'); }
    for (const b of document.querySelectorAll('.tf-box')) if (!b.__target || !b.__target.isConnected) b.remove();   // its list was replaced and no new one took the box
  }
  // Long dropdowns (a rider to pick, a time zone): a box above narrows the choices as you type. The chosen value is kept, and nothing is sent until the app's own
  // onchange fires. Short dropdowns (under SELECT_MIN choices) and multi-selects are left alone.
  const SELECT_MIN = 25;
  function enhanceSelect(sel) {
    sel.dataset.sf = '1';
    const original = sel.innerHTML, clones = [...sel.options].map(o => o.cloneNode(true));
    const box = document.createElement('input'); box.type = 'search'; box.className = 'inp sf-input'; box.autocomplete = 'off'; box.placeholder = '🔎 Type to narrow the list…';
    box.setAttribute('aria-label', 'Narrow the choices in the list below'); box.style.cssText = 'display:block;width:100%;max-width:' + (sel.style.maxWidth || '320px') + ';font-size:12px;margin:0 0 4px';
    box.__sel = sel; sel.parentNode.insertBefore(box, sel);
    box.addEventListener('input', () => {
      const q = norm(box.value).split(/\s+/).filter(Boolean), cur = sel.value;
      if (!q.length) { sel.innerHTML = original; sel.value = cur; return; }
      const keep = clones.filter(o => o.value === cur || q.every(w => norm(o.textContent + ' ' + o.value).includes(w)));
      sel.innerHTML = ''; for (const o of keep) sel.appendChild(o.cloneNode(true)); sel.value = cur;
    });
  }
  function scanSelects() {
    for (const sel of document.querySelectorAll('select:not([data-sf]):not([multiple])')) { if (sel.options.length >= SELECT_MIN && !sel.closest('[data-nofilter]') && sel.parentNode) enhanceSelect(sel); }
    for (const b of document.querySelectorAll('.sf-input')) if (!b.__sel || !b.__sel.isConnected) b.remove();
  }

  let timer = null; const later = () => { clearTimeout(timer); timer = setTimeout(() => { scan(); scanSelects(); }, 120); };
  const start = () => { scan(); scanSelects(); new MutationObserver(later).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.TableFilter = { scan };
})();

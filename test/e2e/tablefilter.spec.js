// @ts-check
// Long lists get a filter box: tables, card lists and long dropdowns. A table that already has its own search is left alone.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function open(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
}
const fixture = page => page.evaluate(() => {
  const host = document.createElement('div'); host.id = 'tf-test'; host.className = 'page active'; host.style.cssText = 'position:fixed;top:60px;left:0;right:0;background:#111;z-index:5;overflow:auto;max-height:80vh';
  const rows = n => Array.from({ length: n }, (_, i) => `<tr><td>Rider ${i}</td><td><span class="rname" data-rid="${9000 + i}">Name ${i}</span></td><td>${i % 2 ? 'active' : 'left'}</td></tr>`).join('');
  host.innerHTML = `<div class="card" id="c1"><table id="t1"><thead><tr><th>Name</th><th>Rider</th><th>Status</th></tr></thead><tbody>${rows(20)}</tbody></table></div>
    <div class="card" id="c2"><table id="t2"><thead><tr><th>A</th></tr></thead><tbody>${rows(3)}</tbody></table></div>
    <div class="card" id="c3"><input placeholder="Search name…"><table id="t3"><thead><tr><th>A</th></tr></thead><tbody>${rows(20)}</tbody></table></div>
    <div class="card" id="c4"><div id="list4" data-filterable>${Array.from({ length: 10 }, (_, i) => `<div>Item number ${i}</div>`).join('')}</div></div>
    <div class="card" id="c5"><select id="s1">${Array.from({ length: 40 }, (_, i) => `<option value="${i}">Zone ${i}</option>`).join('')}</select><select id="s2"><option>a</option><option>b</option></select></div>`;
  document.body.appendChild(host);
});

test('tables, card lists and long dropdowns get a filter; short ones and ones with their own search do not', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page, baseURL); await fixture(page);
  const box = page.locator('#c1 .tf-input'); await expect(box).toBeVisible();
  await expect(page.locator('#c2 .tf-input'), 'a short table has no filter').toHaveCount(0);
  await expect(page.locator('#c3 .tf-input'), 'a table with its own search is left alone').toHaveCount(0);

  await box.fill('rider 1'); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(11);   // Rider 1 and Rider 10 to 19
  await box.fill('rider 1 active'); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(6);   // every word must match: of Rider 1 and 10 to 19, the odd ones (1, 11, 13, 15, 17, 19) are active
  await box.fill('9007'); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(1);   // the Zwift ID behind a rider name
  await expect(page.locator('#c1 .tf-count')).toHaveText('1 of 20');
  await box.fill(''); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(20);

  const list = page.locator('#c4 .tf-input'); await expect(list).toBeVisible(); await list.fill('number 7'); await expect(page.locator('#list4 > div:visible')).toHaveCount(1);

  const narrow = page.locator('#c5 .sf-input'); await expect(narrow).toHaveCount(1);   // only the 40-choice dropdown
  await page.locator('#s1').selectOption('12'); await narrow.fill('zone 3');
  expect(await page.locator('#s1 option').allTextContents()).toEqual(['Zone 3', 'Zone 12', 'Zone 13', 'Zone 23', ...Array.from({ length: 10 }, (_, k) => `Zone ${30 + k}`)]);   // every word must appear ("3" is also in 13 and 23), plus the chosen one kept
  expect(await page.locator('#s1').inputValue(), 'the chosen value is kept while narrowing').toBe('12');
  await narrow.fill(''); await expect(page.locator('#s1 option')).toHaveCount(40);
  expect(errors).toEqual([]);
});

test('a list the app redraws keeps its box and what was typed', async ({ page, baseURL }) => {
  await open(page, baseURL); await fixture(page);
  await page.locator('#c1 .tf-input').fill('rider 5');
  await page.evaluate(() => { const c = document.getElementById('c1'); const html = c.innerHTML; const tableHtml = c.querySelector('table').outerHTML; c.querySelector('table').outerHTML = tableHtml; });   // the app replaces the table
  await expect(page.locator('#c1 .tf-input')).toHaveCount(1);
  await expect(page.locator('#c1 .tf-input')).toHaveValue('rider 5');
  await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(2);   // Rider 5 and Rider 15
});

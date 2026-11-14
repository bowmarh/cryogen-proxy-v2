// @ts-check
// Sorting, saved views and CSV download on long lists; the Members search by Zwift ID and its export.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function open(page, baseURL, role = 'admin') {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(([t, r]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', r); } }, [tok, role]);
  await page.goto(baseURL); await page.evaluate(r => launchApp(r), role);
}
const DATA = [['Rider 10', 100, '2026-11-03'], ['Rider 2', 20, '2026-11-01'], ['Rider 1', 5, '2026-11-02'], ['=HYPERLINK("http://x")', 7, '2026-10-30'], ['Rider 3', '', '2026-11-04'],
  ['Rider 4', 40, '2026-11-05'], ['Rider 5', 3, '2026-11-06'], ['Rider 6', 60, '2026-11-07'], ['Rider 7', 8, '2026-11-08'], ['Rider 8', 9, '2026-11-09']];
const fixture = page => page.evaluate(rows => {
  document.getElementById('tf-test')?.remove();
  const host = document.createElement('div'); host.id = 'tf-test'; host.className = 'page active'; host.style.cssText = 'position:fixed;top:60px;left:0;right:0;background:#111;z-index:5;overflow:auto;max-height:85vh';
  host.innerHTML = `<h2>Test list</h2><div class="card" id="c1"><table id="t1"><thead><tr><th>Name</th><th>Score</th><th>Seen</th></tr></thead><tbody>${rows.map(r => `<tr><td><span class="rname" data-rid="${9000 + r[1]}">${r[0]}</span></td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table></div>
    <div class="card" id="c2"><table id="t2"><thead><tr><th onclick="void 0">Name</th><th>Score</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table></div>`;
  document.body.appendChild(host);
}, DATA);
const names = page => page.locator('#t1 tbody tr:visible td:first-child').allTextContents();

test('click a heading to sort: numbers as numbers, again to reverse, a third time for the original order; tables that sort themselves are left alone', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page, baseURL); await fixture(page);
  const score = page.locator('#t1 th', { hasText: 'Score' }); await expect(score).toHaveAttribute('aria-sort', 'none');
  const original = await names(page);
  await score.click();
  expect(await names(page)).toEqual(['Rider 5', 'Rider 1', '=HYPERLINK("http://x")', 'Rider 7', 'Rider 8', 'Rider 2', 'Rider 4', 'Rider 6', 'Rider 10', 'Rider 3']);   // 3 5 7 8 9 20 40 60 100, the empty one last
  await expect(score).toHaveAttribute('aria-sort', 'ascending');
  await score.click(); expect((await names(page)).slice(0, 3)).toEqual(['Rider 10', 'Rider 6', 'Rider 4']); await expect(score).toHaveAttribute('aria-sort', 'descending');
  await score.click(); expect(await names(page)).toEqual(original); await expect(score).toHaveAttribute('aria-sort', 'none');
  await page.locator('#t1 th', { hasText: 'Name' }).click(); expect((await names(page)).slice(0, 4)).toEqual(['=HYPERLINK("http://x")', 'Rider 1', 'Rider 2', 'Rider 3']);   // text order, "Rider 2" before "Rider 10"
  await page.locator('#t1 th', { hasText: 'Seen' }).click(); expect((await names(page))[0]).toBe('=HYPERLINK("http://x")');   // 30 Oct is the earliest date
  await expect(page.locator('#t2 th').nth(1), 'a table whose headings already do something is not changed').not.toHaveAttribute('aria-sort', /./);
  expect(errors).toEqual([]);
});

test('a filter and sort can be saved as a named view on this device, brought back later, and deleted', async ({ page, baseURL }) => {
  await open(page, baseURL); await fixture(page);
  await page.evaluate(() => localStorage.removeItem('cg:tf:views:v1'));
  await page.locator('#c1 .tf-input').fill('rider 1'); await page.locator('#t1 th', { hasText: 'Score' }).click();
  page.once('dialog', d => d.accept('Rider 1s by score')); await page.locator('#c1 .tf-save').click();
  const views = page.locator('#c1 .tf-views'); await expect(views).toBeVisible(); await expect(views).toContainText('Rider 1s by score');
  await page.locator('#c1 .tf-input').fill(''); await page.locator('#t1 th', { hasText: 'Score' }).click(); await page.locator('#t1 th', { hasText: 'Score' }).click();   // clear filter and sort
  await views.selectOption({ label: 'Rider 1s by score' });
  await expect(page.locator('#c1 .tf-input')).toHaveValue('rider 1'); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(9);   // every word must match somewhere in the row: all nine rider rows (the dates contain a 1)
  expect((await names(page)).slice(0, 3)).toEqual(['Rider 5', 'Rider 1', 'Rider 7']);   // and the sort by score came back: 3, 5, 8
  await fixture(page); await page.waitForTimeout(300);   // the page is redrawn: the saved view is still offered
  await expect(page.locator('#c1 .tf-views')).toContainText('Rider 1s by score');
  page.once('dialog', d => d.accept()); await page.locator('#c1 .tf-views').selectOption({ label: 'Rider 1s by score' }); await page.locator('#c1 .tf-del').click();
  await expect(page.locator('#c1 .tf-views')).toBeHidden();
});

test('staff download what is shown as a spreadsheet file: filtered rows only, the Zwift ID added, formulas defused; riders get no download button', async ({ page, baseURL }) => {
  await open(page, baseURL); await fixture(page);
  await page.locator('#c1 .tf-input').fill('rider'); await page.locator('#t1 th', { hasText: 'Score' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#c1 .tf-csv').click()]);
  expect(dl.suggestedFilename()).toMatch(/^cryogen-test-list-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await dl.path(), 'utf8'); expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split('\r\n'); expect(lines[0]).toBe('Name,Score,Seen,Zwift ID');
  expect(lines.length).toBe(1 + 9);   // the 9 rows containing "rider" (the formula row does not match)
  expect(lines[1]).toBe('Rider 5,3,2026-11-06,9003');   // sorted by score ascending
  await page.locator('#c1 .tf-input').fill('hyperlink');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#c1 .tf-csv').click()]);
  const t2 = fs.readFileSync(await dl2.path(), 'utf8'); expect(t2).toContain(`"'=HYPERLINK(""http://x"")"`);   // a leading = is defused with an apostrophe
});

test('a rider has no CSV button on the same list', async ({ page, baseURL }) => {
  await open(page, baseURL, 'standard'.replace('standard', 'mod')); await page.evaluate(() => sessionStorage.setItem('role', 'member')); await fixture(page);
  await expect(page.locator('#c1 .tf-input')).toBeVisible(); await expect(page.locator('#c1 .tf-csv')).toHaveCount(0);
});

test('Members: search finds a Zwift ID and other fields; staff export everyone matching, not just the page', async ({ page, baseURL }) => {
  await open(page, baseURL); await page.waitForFunction(() => typeof riders !== 'undefined' && riders.length >= 3, null, { timeout: 15000 });
  await page.evaluate(() => showTab('members', document.getElementById('nav-members')));
  const q = page.locator('#m-search'); await expect(q).toHaveAttribute('placeholder', /Zwift ID/);
  await q.fill('1002'); await expect(page.locator('#members-body')).toContainText('Rider'); const count = await page.locator('#members-body tr').count(); expect(count).toBe(1);
  await q.fill(''); await expect(page.locator('#m-export')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#m-export').click()]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').slice(1).trim().split('\r\n');
  expect(lines[0]).toBe('Name,Zwift ID,Level,Status,Category,ZwiftRacing tier,FTP (W),W/kg,vELO,Phenotype,Country,On the club roster,Off-boarded: Discord,Off-boarded: Facebook,Off-boarded: ZwiftPower');
  const all = await page.evaluate(() => [...riders, ...wpOnly].length); expect(lines.length).toBe(1 + all);
});

test('"Select all" on a filtered list ticks only the rows shown, never the ones the filter hides', async ({ page, baseURL }) => {
  await open(page, baseURL); await page.evaluate(() => staffReady());
  await page.evaluate(() => {
    window.renderTidy = () => {};   // keep the test rows in place
    window.tidyInactive = () => Array.from({ length: 12 }, (_, i) => ({ zwid: String(100 + i) }));
    tidySel = new Set();
    const host = document.createElement('div'); host.id = 'tf-test'; host.className = 'page active'; host.style.cssText = 'position:fixed;top:60px;left:0;right:0;background:#111;z-index:5';
    host.innerHTML = `<div class="card"><div data-filterable>${Array.from({ length: 12 }, (_, i) => `<div data-tidyz="${100 + i}">${i < 4 ? 'Alice' : 'Bob'} ${100 + i}</div>`).join('')}</div></div>`;
    document.body.appendChild(host);
  });
  await page.locator('#tf-test .tf-input').fill('alice');
  await expect(page.locator('#tf-test [data-tidyz]:visible')).toHaveCount(4);
  await page.evaluate(() => tidyAll(true));
  expect(await page.evaluate(() => [...tidySel].sort())).toEqual(['100', '101', '102', '103']);
  await page.locator('#tf-test .tf-input').fill('nobody here');
  await page.evaluate(() => { tidySel = new Set(); tidyAll(true); });
  expect(await page.evaluate(() => tidySel.size), 'a filter that shows nothing selects nothing').toBe(0);
});

test('Members quick views: one click narrows the list, a second click clears it', async ({ page, baseURL }) => {
  await open(page, baseURL); await page.waitForFunction(() => typeof riders !== 'undefined' && riders.length >= 3, null, { timeout: 15000 });
  await page.evaluate(() => showTab('members', document.getElementById('nav-members')));
  const chips = page.locator('#m-quick button'); expect(await chips.count()).toBeGreaterThanOrEqual(7);   // staff see all seven
  const all = await page.evaluate(() => [...riders, ...wpOnly].length);
  const expected = await page.evaluate(() => [...riders, ...wpOnly].filter(m => m.tier === 'half' || m.tier === 'associate').length);
  await page.locator('#m-quick button', { hasText: 'Associates' }).click();
  await expect(page.locator('#members-sub')).toContainText(`Showing ${expected} of ${all}`);
  await page.locator('#m-quick button', { hasText: 'Associates' }).click();
  await expect(page.locator('#members-sub')).toContainText(`Showing ${all} of ${all}`);
});

test('staff views are kept on the server and come back on a device that has none', async ({ page, baseURL }) => {
  let stored = {}; const posts = [];
  await page.route('**/api/tableviews', async route => {
    const req = route.request();
    if (req.method() === 'POST') { const b = req.postDataJSON(); posts.push(b); if (b.views.length) stored[b.sig] = b.views; else delete stored[b.sig]; }
    await route.fulfill({ json: { views: stored } });
  });
  await open(page, baseURL); await fixture(page);
  await page.evaluate(() => localStorage.removeItem('cg:tf:views:v1'));
  await page.locator('#c1 .tf-input').fill('rider 5');
  page.once('dialog', d => d.accept('Five')); await page.locator('#c1 .tf-save').click();
  await expect.poll(() => posts.length).toBe(1); expect(posts[0].views[0].name).toBe('Five'); expect(posts[0].views[0].q).toBe('rider 5');
  await page.evaluate(() => localStorage.removeItem('cg:tf:views:v1'));   // a different device: nothing saved locally
  await page.reload(); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(600); await fixture(page); await page.waitForTimeout(300);
  await expect(page.locator('#c1 .tf-views')).toContainText('Five');
});

test('column filters: "score>20", "name:rider score<10"; a word that names no column is an ordinary word', async ({ page, baseURL }) => {
  await open(page, baseURL); await fixture(page);
  const q = page.locator('#c1 .tf-input');
  await q.fill('score>20'); expect((await names(page)).sort()).toEqual(['Rider 10', 'Rider 4', 'Rider 6']);
  await q.fill('name:rider score<10'); expect((await names(page)).sort()).toEqual(['Rider 1', 'Rider 5', 'Rider 7', 'Rider 8']);
  await q.fill('seen:2026-11-09'); expect(await names(page)).toEqual(['Rider 8']);
  await q.fill('nosuchcolumn:x'); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(0);
  await q.fill(''); await expect(page.locator('#t1 tbody tr:visible')).toHaveCount(10);
});

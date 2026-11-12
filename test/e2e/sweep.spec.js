// @ts-check
// A sweep of every page: sign in as an administrator and as a rider, open each menu page, and fail on any script error, any server error (HTTP 5xx) from
// the API, or any page that shows the "could not load" style failure. This is the check that catches a page that quietly stopped working.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function sweep(page, baseURL, who) {
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push('script: ' + e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(baseURL); await page.evaluate(r => launchApp(r), who);
  const ids = await page.evaluate(() => [...document.querySelectorAll('.navbtn')].filter(b => b.offsetParent !== null || getComputedStyle(b).display !== 'none').map(b => b.id).filter(Boolean));
  expect(ids.length).toBeGreaterThan(3);
  const shown = [];
  for (const id of ids) {
    const btn = page.locator('#' + id); if (!(await btn.isVisible())) continue;
    await btn.click(); await page.waitForTimeout(350); await page.waitForLoadState('networkidle').catch(() => {}); shown.push(id);
    const active = page.locator('.page.active'); await expect(active).toHaveCount(1);
    const text = (await active.innerText()).trim(); expect(text.length, `${id} shows something`).toBeGreaterThan(5);
    expect(text, `${id} has no uncaught failure text`).not.toMatch(/undefined|\[object Object\]|NaN\b/);
  }
  expect(errors, `script errors while visiting ${shown.join(', ')}`).toEqual([]); expect(bad, 'server errors').toEqual([]);
  return shown;
}

test('an administrator can open every page without a script error or a server error', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  const shown = await sweep(page, baseURL, 'admin'); expect(shown).toEqual(expect.arrayContaining(['nav-control', 'nav-aidesk', 'nav-mail']));
});

test('a moderator can open every page they can see without a script error or a server error', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'mod', password: h.BASE_ENV.MOD_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'mod'); } }, tok);
  await sweep(page, baseURL, 'mod');
});

test('a rider can open every page without a script error or a server error', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push('script: ' + e.message)); page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.navbtn')].map(b => b.id).filter(Boolean));
  for (const id of ids) { const btn = page.locator('#' + id); if (!(await btn.isVisible())) continue; await btn.click(); await page.waitForTimeout(350); await page.waitForLoadState('networkidle').catch(() => {}); }
  expect(errors).toEqual([]); expect(bad).toEqual([]);
});

test('the public pages load: the club page, the open race page, the join form and the live board', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const p of ['/club.html', '/race.html', '/join.html', '/live.html']) { const r = await page.goto(baseURL + p); expect(r && r.status(), p).toBe(200); await page.waitForTimeout(300); }
  expect(errors).toEqual([]);
});

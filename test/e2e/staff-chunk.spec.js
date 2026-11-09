// @ts-check
// The staff-only code is in its own file (js/staff.js): riders never download it, and staff get working Fair play, Admin and Health pages from it.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

test('a rider never downloads the staff code', async ({ page, baseURL }) => {
  const asked = [];
  page.on('request', r => { if (/\/js\/staff\.js/.test(r.url())) asked.push(r.url()); });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);
  expect(asked).toEqual([]);
});

test('staff get the staff code after signing in, and the Fair play, Admin and Health pages work from it', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const loaded = page.waitForRequest(/\/js\/staff\.js/);
  await page.goto(baseURL);
  await page.evaluate(() => launchApp('admin'));
  await loaded;
  // The real functions have replaced the stubs.
  await expect.poll(() => page.evaluate(() => !String(loadFair).includes('staffReady'))).toBe(true);
  await page.locator('#nav-fair').click();
  await expect(page.locator('#fair-content')).toContainText('Fair play');
  await page.evaluate(() => openAdmin());
  await expect(page.locator('#admin-modal, .modal-head').first()).toBeVisible();
  await expect(page.locator('.modal-head').first()).toContainText('Admin');
  await page.evaluate(() => loadHealth());
  await expect(page.locator('body')).toContainText(/Shared storage|Daily usage|Health/i, { timeout: 15000 });
  expect(errors).toEqual([]);
});

test('a staff tool used before the code has arrived waits for it instead of failing', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.route(/\/js\/staff\.js/, async route => { await new Promise(r => setTimeout(r, 1200)); await route.continue(); });   // a slow connection
  await page.goto(baseURL);
  await page.evaluate(() => launchApp('admin'));
  await page.evaluate(() => { openAdmin(); });   // called straight away, before staff.js has arrived
  await expect(page.locator('.modal-head').first()).toContainText('Admin', { timeout: 15000 });
});

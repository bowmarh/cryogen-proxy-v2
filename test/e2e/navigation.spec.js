// @ts-check
// Getting around, part two (the grouped menu, Go to and the phone bar are tested in nav.spec.js and quickfind.spec.js): the "What would you like to do?" buttons on Home,
// the "You are here" strip, and the Back button.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();
const rider = async (page, baseURL) => { await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`); await expect(page.locator('#app')).toBeVisible({ timeout: 15000 }); };
const active = page => page.evaluate(() => (document.querySelector('.page.active') || {}).id);

test('a rider: Home offers what they do, and every page shows a breadcrumb', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await rider(page, baseURL);
  const home = page.locator('#home-launch'); await expect(home).toContainText('What would you like to do?'); await expect(home).toContainText('Sign up for a race or ride'); await expect(home).not.toContainText('Race day and club health');   // staff tiles are not shown to a rider
  await home.getByRole('button', { name: /ZRL team racing/ }).click(); expect(await active(page)).toBe('page-zrl');
  const strip = page.locator('#page-help'); await expect(strip).toContainText('Home'); await expect(strip).toContainText('Racing'); await expect(strip).toContainText('ZRL');
  await strip.getByRole('link', { name: /Home/ }).click(); expect(await active(page)).toBe('page-dashboard');
  expect(errors).toEqual([]);
});

test('staff see staff tiles on Home, and the Control room tabs are grouped Today, Set up, Numbers', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: h.BASE_ENV.OWNER_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('owner', '1'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.evaluate(() => navGo('dashboard'));   // staff open on This week
  await expect(page.locator('#home-launch')).toContainText('Race day and club health'); await expect(page.locator('#home-launch')).toContainText('Send an email');
  await page.locator('#home-launch').getByRole('button', { name: /Race day and club health/ }).click(); expect(await active(page)).toBe('page-control');
  await page.locator('#control-content [role=tablist]').waitFor({ timeout: 15000 });
  const labels = await page.evaluate(() => [...document.querySelectorAll('#control-content [role=tablist] > *')].map(e => e.getAttribute('role') === 'presentation' ? '#' + e.textContent.trim() : e.textContent.trim().replace(/\s*\(\d+\)$/, '')));
  expect(labels.filter(l => l.startsWith('#'))).toEqual(['#Today', '#Set up', '#Numbers']);
  expect(labels.indexOf('🏁 Now')).toBeLessThan(labels.indexOf('#Set up')); expect(labels.indexOf('🛡️ Security')).toBeGreaterThan(labels.indexOf('#Set up')); expect(labels.indexOf('📈 Engagement')).toBeGreaterThan(labels.indexOf('#Numbers'));
});

test('the Back button returns to the page before instead of leaving the app, and the tab title says where you are', async ({ page, baseURL }) => {
  await rider(page, baseURL);
  await page.evaluate(() => navGo('zrl')); await page.evaluate(() => navGo('ttt')); expect(await active(page)).toBe('page-ttt'); await expect(page).toHaveTitle(/TTT Week/);
  await page.goBack(); await expect.poll(() => active(page)).toBe('page-zrl'); await expect(page).toHaveTitle(/ZRL/);
  await page.goBack(); await expect(page.locator('#app')).toBeVisible();   // still in the app
});

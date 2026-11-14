// @ts-check
// Getting around: the "What would you like to do?" buttons, "Go to", the "You are here" strip, the grouped menu, and on a phone the bottom bar and its lists.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();
const rider = async (page, baseURL) => { await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`); await expect(page.locator('#app')).toBeVisible({ timeout: 15000 }); };
const active = page => page.evaluate(() => (document.querySelector('.page.active') || {}).id);

test('a rider: Home offers what they do, Go to finds a page by plain words, and every page says where you are', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await rider(page, baseURL);
  const home = page.locator('#home-launch'); await expect(home).toContainText('What would you like to do?'); await expect(home).toContainText('Sign up for a race or ride'); await expect(home).not.toContainText('Race day and club health');   // staff tiles are not shown to a rider
  await home.getByRole('button', { name: /ZRL team racing/ }).click(); expect(await active(page)).toBe('page-zrl');
  const strip = page.locator('#page-help'); await expect(strip).toContainText('Home'); await expect(strip).toContainText('ZRL'); await expect(strip).toContainText('Zwift Racing League');
  await strip.getByRole('button', { name: /Got it/ }).click(); await expect(strip).not.toContainText('Zwift Racing League');   // dismissed, the where-you-are line stays
  await page.keyboard.press('g'); const box = page.locator('#go-box'); await expect(box).toBeVisible();
  await box.locator('#go-q').fill('sign up'); await expect(box.getByRole('option').first()).toContainText(/Events|ZRL|TTT/);
  await box.locator('#go-q').fill('emails'); await expect(box.getByRole('option').first()).toContainText('My details');   // a rider is never offered the staff Email page
  await box.locator('#go-q').press('Enter'); await expect(box).toBeHidden(); expect(await active(page)).toBe('page-mydetails');
  await page.keyboard.press('g'); await page.locator('#go-q').fill('zzzzqq'); await expect(page.locator('#go-list')).toContainText('Nothing matches'); await page.keyboard.press('Escape'); await expect(page.locator('#go-box')).toBeHidden();
  const groups = await page.evaluate(() => [...document.querySelectorAll('#main-nav .navgroup')].filter(g => g.style.display !== 'none').map(g => g.textContent.trim())); expect(groups).toEqual(expect.arrayContaining(['Me', 'Racing', 'Rides', 'Club'])); expect(groups).not.toContain('Staff tools');
  expect(errors).toEqual([]);
});

test('staff see staff tools grouped, staff tiles on Home, and can reach the Control room by typing "race day"', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: h.BASE_ENV.OWNER_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('owner', '1'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await expect(page.locator('#home-launch')).toContainText('Race day and club health'); await expect(page.locator('#home-launch')).toContainText('Send an email');
  const groups = await page.evaluate(() => [...document.querySelectorAll('#main-nav .navgroup')].filter(g => g.style.display !== 'none').map(g => g.textContent.trim())); expect(groups).toContain('Staff tools');
  await page.locator('#go-btn').click(); await page.locator('#go-q').fill('race day'); await expect(page.getByRole('option').first()).toContainText('Control room'); await page.keyboard.press('Enter'); expect(await active(page)).toBe('page-control');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('a bottom bar replaces the strip of small buttons, and its lists lead to every page', async ({ page, baseURL }) => {
    await rider(page, baseURL);
    const bar = page.locator('#bottom-bar'); await expect(bar).toBeVisible(); await expect(page.locator('#sidebar')).toBeHidden();
    await expect(bar.getByRole('button', { name: /Staff/ })).toBeHidden();   // a rider has no staff tools
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
    await bar.getByRole('button', { name: /Races/ }).click(); const sheet = page.locator('#sheet-box'); await expect(sheet).toContainText('ZRL'); await expect(sheet).toContainText('Social Rides');
    await sheet.getByRole('button', { name: /ZRL/ }).first().click(); await expect(sheet).toBeHidden(); expect(await active(page)).toBe('page-zrl');
    await bar.getByRole('button', { name: /Me/ }).click(); await expect(page.locator('#sheet-box')).toContainText('My Profile'); await page.keyboard.press('Escape'); await expect(page.locator('#sheet-box')).toBeHidden();
    await bar.getByRole('button', { name: /Go to/ }).click(); await expect(page.locator('#go-box')).toBeVisible(); await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: /Home/ }).click(); expect(await active(page)).toBe('page-dashboard');
  });
});

test('the Back button returns to the page before instead of leaving the app, and the tab title says where you are', async ({ page, baseURL }) => {
  await rider(page, baseURL);
  await page.evaluate(() => navGo('zrl')); await page.evaluate(() => navGo('ttt')); expect(await active(page)).toBe('page-ttt'); await expect(page).toHaveTitle(/TTT Week/);
  await page.goBack(); await expect.poll(() => active(page)).toBe('page-zrl'); await expect(page).toHaveTitle(/ZRL/);
  await page.goBack(); await expect(page.locator('#app')).toBeVisible();   // still in the app
});

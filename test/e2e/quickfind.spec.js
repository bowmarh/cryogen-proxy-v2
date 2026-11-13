// @ts-check
// Staff quick find: a name or Zwift ID finds the rider and opens their profile; riders do not get it.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

test('staff find a rider by name or Zwift ID with the button or the / key, and open the profile', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await expect(page.locator('#find-btn')).toBeVisible();
  await page.waitForFunction(() => typeof riders !== 'undefined' && riders.length > 0, null, { timeout: 15000 });
  await page.locator('#find-btn').click();
  const q = page.locator('#qf-q'); await expect(q).toBeFocused();
  await q.fill('rider two'); await expect(page.locator('#qf-r [data-i]').first()).toContainText('Rider Two');
  await q.fill('1003'); await expect(page.locator('#qf-r [data-i]')).toHaveCount(1); await expect(page.locator('#qf-r')).toContainText('ID 1003');
  await q.fill('zzzz'); await expect(page.locator('#qf-r')).toContainText('No rider matches');
  await page.keyboard.press('Escape'); await expect(page.locator('#qf')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 300 } }); await page.keyboard.press('/'); await expect(page.locator('#qf')).toHaveCount(1);
  await page.locator('#qf-q').fill('1002'); await page.keyboard.press('Enter');
  await expect(page.locator('#qf')).toHaveCount(0); await expect(page.locator('#riderModal')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a rider does not see the quick find', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#find-btn')).toBeHidden(); await page.keyboard.press('/'); await expect(page.locator('#qf')).toHaveCount(0);
});

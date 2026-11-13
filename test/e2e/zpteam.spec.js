// @ts-check
// Club health shows the ZwiftPower team card for staff.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

test('the Club health page shows the ZwiftPower team card', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-clubstats').click();
  await expect(page.locator('#zp-card')).toContainText('ZwiftPower team', { timeout: 10000 });
  await expect(page.locator('#zp-card a[href*="zwiftpower.com/team.php"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

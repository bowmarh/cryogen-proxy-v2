// @ts-check
// Stay signed in with a passcode: offered after sign-in, then on reopening the app the passcode signs you back in with no password.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

test('choose a passcode after signing in; reopening the app asks for it and signs you in; a wrong one is refused', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.goto(baseURL);
  await page.evaluate(t => { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('justSignedIn', '1'); localStorage.removeItem('cg:stay'); localStorage.removeItem('cg:stay:ask'); }, tok);
  await page.evaluate(() => launchApp('admin'));
  const m = page.locator('#stay-banner');
  await expect(m).toContainText('Stay signed in on this device?', { timeout: 5000 });
  await m.getByRole('button', { name: /Passcode/ }).click();
  await page.locator('#stay-pin').fill('2468'); await page.locator('#stay-ok').click();
  await page.locator('#stay-pin').fill('2468'); await page.locator('#stay-ok').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cg:stay') || '{}').lock)).toBe('pin');
  expect(await page.evaluate(() => localStorage.getItem('cg:stay'))).not.toContain('refresh', 'the renewal token is stored encrypted only');

  // Close the app (a new tab has no session), open it again.
  await page.evaluate(() => sessionStorage.clear());
  page.once('dialog', d => d.accept());   // the wrong-passcode notice
  await page.reload();
  await page.locator('#stay-pin').fill('0000'); await page.locator('#stay-ok').click();
  await page.locator('#stay-pin').fill('2468'); await page.locator('#stay-ok').click();
  await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => sessionStorage.getItem('role'))).toBe('admin');
  expect(errors).toEqual([]);
});

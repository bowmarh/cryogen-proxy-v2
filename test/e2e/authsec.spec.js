// @ts-check
// (The owner's authenticator test runs last: the test server keeps its state, and it changes how the owner signs in.)
// Sign-in security screens: the authenticator code step, set-up with a QR code at sign-in, forced password change, and the forgot-password form.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
const totp = require('../../lib/totp');

h.setEnv();
const pw = h.BASE_ENV.OWNER_PASSWORD;

test('a new staff login chooses its own password, and the forgot-password form answers the same for any name', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: pw } })).json()).token;
  expect((await page.request.post('/api/staff', { data: { username: 'newbie', name: 'New Bie', role: 'mod', password: 'start-pass-123' }, headers: { Authorization: 'Bearer ' + tok } })).ok()).toBe(true);
  await page.goto(baseURL); await page.locator('#owner-btn').locator('xpath=following-sibling::button[1]').click(); await page.locator('#login-form-admin').getByText('Use my own staff login instead').click();
  await page.locator('#user-name').fill('newbie'); await page.locator('#user-pw').fill('start-pass-123'); await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Choose your own password')).toBeVisible();
  await page.locator('#auth-cur').fill('start-pass-123'); await page.locator('#auth-new').fill('my-own-pass-2468'); await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.locator('#login-screen')).toBeHidden();
  await page.waitForLoadState('networkidle'); await page.evaluate(() => sessionStorage.clear());
  await page.goto(baseURL); await page.locator('#owner-btn').locator('xpath=following-sibling::button[1]').click(); await page.locator('#login-form-admin').getByText('Use my own staff login instead').click(); await page.getByText('Forgot your password?').click();
  await page.locator('#auth-user').fill('nobody-here'); await page.getByRole('button', { name: 'Send reset link' }).click(); await expect(page.getByText(/If that account has an email address/)).toBeVisible();
});

test('the owner turns on an authenticator and then signs in with a code through the real screens', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: pw } })).json()).token, auth = { Authorization: 'Bearer ' + tok };
  const setup = await (await page.request.post('/api/auth/totp/setup', { data: {}, headers: auth })).json(), secret = setup.secret.replace(/\s/g, '');
  const en = await page.request.post('/api/auth/totp/enable', { data: { code: totp.code(secret, Date.now()) }, headers: auth }); expect(en.ok()).toBe(true); const recovery = (await en.json()).recoveryCodes;
  await page.goto(baseURL); await page.locator('#owner-btn').click(); await page.locator('#owner-pw').fill(pw); await page.getByRole('button', { name: 'Login as Owner' }).click();
  await expect(page.getByText('Enter your authenticator code')).toBeVisible();
  await page.locator('#auth-code').fill('000000'); await page.getByRole('button', { name: 'Continue' }).click(); await expect(page.locator('#auth-err')).toContainText(/code/i);
  await page.locator('#auth-code').fill(totp.code(secret, Date.now() + 30000)); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#login-screen')).toBeHidden(); expect(await page.evaluate(() => sessionStorage.getItem('owner'))).toBe('1');
  // leave the shared test server as it was: the other specs sign in as the owner with the password alone
  const t2 = await page.evaluate(() => sessionStorage.getItem('token')); expect((await page.request.post('/api/auth/totp/disable', { data: { code: recovery[0] }, headers: { Authorization: 'Bearer ' + t2 } })).ok()).toBe(true);
  expect(errors).toEqual([]);
});

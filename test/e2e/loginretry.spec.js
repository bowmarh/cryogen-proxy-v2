// @ts-check
// A dropped connection during sign-in is retried once; if it still fails the message says what to check.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

test('a dropped connection is retried once and the owner login still works', async ({ page, baseURL }) => {
  let calls = 0;
  await page.route('**/api/login', route => { calls++; if (calls === 1) return route.abort('connectionreset'); return route.continue(); });
  await page.goto(baseURL); await page.locator('#owner-btn').click(); await page.locator('#owner-pw').fill(h.BASE_ENV.OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Login as Owner' }).click();
  await expect(page.locator('#login-screen')).toBeHidden({ timeout: 10000 });
  expect(calls).toBe(2);
});

test('when the connection stays down the message says what to check; a wrong password is still a wrong password', async ({ page, baseURL }) => {
  await page.route('**/api/login', route => route.abort('connectionreset'));
  await page.goto(baseURL); await page.locator('#owner-btn').click(); await page.locator('#owner-pw').fill('x');
  await page.getByRole('button', { name: 'Login as Owner' }).click();
  await expect(page.locator('#login-err')).toContainText('Could not reach the login server. Check your connection', { timeout: 10000 });
  await page.unroute('**/api/login');
  await page.getByRole('button', { name: 'Login as Owner' }).click();
  await expect(page.locator('#login-err')).toContainText('Incorrect password');
});

// @ts-check
// The Go-to box offers the pages you opened last, first, when nothing is typed.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

test('pages you opened lately are offered first in the Go-to box, newest first, not the page you are on', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(([t]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); localStorage.setItem('cg:whatsnew:seen', '9999-01-01'); } }, [tok]);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await expect(page.locator('.page.active').first()).toBeVisible({ timeout: 15000 });
  await page.keyboard.press('g'); await page.keyboard.press('z');
  await expect(page.locator('#page-zrl.active')).toBeVisible();
  await page.keyboard.press('g'); await page.keyboard.press('r');
  await expect(page.locator('#page-racing.active')).toBeVisible();
  await page.keyboard.press('/');
  const box = page.locator('#qf'); await expect(box).toBeVisible();
  await expect(box).toContainText('Recent');
  const recent = await page.evaluate(() => window.QuickFind.recentIds());
  expect(recent.slice(0, 2)).toEqual(['racing', 'zrl']);
  const first = await box.locator('[role=option]').first().innerText();
  expect(first).toMatch(/ZRL/i);   // racing is where you are now, so the newest other page comes first
  expect(errors).toEqual([]);
});

// @ts-check
// Keyboard shortcuts: ? lists them, "g" then a letter goes to a page, and nothing fires while typing in a box.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function open(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(([t]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); localStorage.setItem('cg:whatsnew:seen', '9999-01-01'); } }, [tok]);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
}

test('? opens the shortcut list, Escape closes it, and g then z goes to ZRL', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await open(page, baseURL);
  await expect(page.locator('.page.active').first()).toBeVisible({ timeout: 15000 });
  await page.keyboard.press('?');
  await expect(page.locator('#kbd-help')).toContainText('Keyboard shortcuts');
  await expect(page.locator('#kbd-help')).toContainText('ZRL');
  await page.keyboard.press('Escape'); await expect(page.locator('#kbd-help')).toHaveCount(0);
  await page.keyboard.press('g'); await page.keyboard.press('z');
  await expect(page.locator('#page-zrl.active')).toBeVisible();
  await page.keyboard.press('g'); await page.keyboard.press('h');
  await expect(page.locator('#page-dashboard.active')).toBeVisible();
  expect(errors).toEqual([]);
});

test('typing a g and a z in a text box does not jump pages', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await expect(page.locator('.page.active').first()).toBeVisible({ timeout: 15000 });
  const before = await page.evaluate(() => document.querySelector('.page.active').id);
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'kb-test'; document.body.appendChild(i); i.focus(); });
  await page.keyboard.type('gz');
  expect(await page.evaluate(() => document.querySelector('.page.active').id)).toBe(before);
  await expect(page.locator('#kb-test')).toHaveValue('gz');
});

// @ts-check
// On a phone the header keeps its title on one line and the look, theme and time-zone buttons sit behind a "⋯" menu.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('phone header: one-line title, tools behind the menu, menu opens and closes', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  const bar = page.locator('.brand-bar');
  expect((await bar.boundingBox()).height, 'the header is one compact row').toBeLessThan(70);
  const title = page.getByText('TEAM CRYO-GEN', { exact: true });
  expect((await title.boundingBox()).height, 'the title is on one line').toBeLessThan(24);
  await expect(page.locator('#theme-btn')).toBeHidden(); await expect(page.locator('#tz-btn')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  await page.locator('#more-btn').click();
  await expect(page.locator('#theme-btn')).toBeVisible(); await expect(page.locator('#tz-btn')).toBeVisible(); await expect(page.locator('#ui-btn')).toBeVisible();
  await expect(page.locator('#more-btn')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape'); await expect(page.locator('#theme-btn')).toBeHidden();
  await page.locator('#more-btn').click(); await page.locator('#tz-btn').click();   // choosing one closes the menu
  await expect(page.locator('#theme-btn')).toBeHidden();
  expect(errors).toEqual([]);
});

test('on a wide screen nothing changes: the buttons are in the header and there is no menu button', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await expect(page.locator('#theme-btn')).toBeVisible(); await expect(page.locator('#more-btn')).toBeHidden();
});

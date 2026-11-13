// @ts-check
// "Install app" in the header: shown on phones that can install, explains the steps for an iPhone, and warns about in-app browsers.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
async function open(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
}

test.describe('iPhone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: IPHONE });
  test('the menu offers Install app and shows the Share, Add to Home Screen steps', async ({ page, baseURL }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await open(page, baseURL);
    await page.locator('#more-btn').click(); await expect(page.locator('#install-btn')).toBeVisible();
    await page.locator('#install-btn').click();
    const help = page.locator('#install-help'); await expect(help).toContainText('Add to Home Screen'); await expect(help).toContainText('Share');
    await page.locator('#install-help-close').click(); await expect(help).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('in-app browser', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: IPHONE + ' [FBAN/FBIOS;FBAV/450.0]' });
  test('a browser inside another app is told to open Safari or Chrome', async ({ page, baseURL }) => {
    await open(page, baseURL); await page.locator('#more-btn').click(); await page.locator('#install-btn').click();
    await expect(page.locator('#install-help')).toContainText('Safari');
  });
});

test('a desktop browser with no install offer shows no Install app button', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await open(page, baseURL);
  await expect(page.locator('#install-btn')).toBeHidden();
});

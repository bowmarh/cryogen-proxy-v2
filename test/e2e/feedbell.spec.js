// @ts-check
// The notification bell and the streams list.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function admin(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(1200);
}

test('the bell: staff post a line, it shows with a new-count for others, and Mark all as read clears it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await admin(page, baseURL);
  const bell = page.locator('#bell-btn'); await expect(bell).toBeVisible();
  await bell.click(); const panel = page.locator('#bell-panel'); await expect(panel).toBeVisible();
  const line = 'Roster for race 2 is up ' + Date.now().toString(36);   // unique: the same line twice within ten minutes is deliberately kept once
  await panel.locator('#bell-post').fill(line); await panel.locator('#bell-send').click();
  await expect(panel).toContainText(line); await expect(panel).toContainText('News');
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
  // another visit: the line is older than the "read up to here" mark, so nothing is new; a newer one is
  await page.evaluate(() => localStorage.setItem('cg:feed:seen', String(Date.now() - 3600000)));   // last looked an hour ago
  await page.evaluate(() => Bell.load()); await expect(bell).toHaveAttribute('aria-label', /[1-9]\d* new/);
  await bell.click(); await page.locator('#bell-read').click(); await expect(bell).toHaveAttribute('aria-label', 'Notifications');
});

test('a rider adds a stream link on the ZRL page; a bad one is refused; it can be removed', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => showTab('zrl', document.querySelector('#main-nav button[onclick*="zrl"]')));
  const box = page.locator('#zrl-streams'); await expect(box).toBeVisible({ timeout: 15000 });
  await box.locator('#st-url').fill('https://example.com/nope'); await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('#st-msg')).toContainText('Twitch, YouTube, Kick or Facebook');
  await box.locator('#st-url').fill('https://twitch.tv/ridertwo'); await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByRole('link', { name: /Rider/ })).toHaveAttribute('href', 'https://twitch.tv/ridertwo');
  await expect(box).toContainText('Twitch');
  await box.getByRole('button', { name: 'Remove' }).click(); await expect(box).toContainText('Nobody has added a stream yet');
});

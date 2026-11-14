// @ts-check
// The "What's new" card: shown once per release to a device that has seen an older one; a brand-new device is not greeted with a change list.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function open(page, baseURL, seen, role = 'admin') {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(([t, s, r]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', r); if (s) localStorage.setItem('cg:whatsnew:seen', s); else localStorage.removeItem('cg:whatsnew:seen'); } }, [tok, seen, role]);
  await page.goto(baseURL); await page.evaluate(r => launchApp(r), role);
}

test('a device that saw an older release gets the card once; dismissing it keeps it away', async ({ page, baseURL }) => {
  await open(page, baseURL, '2026-01-01');
  const card = page.locator('#whatsnew'); await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText('Click a column heading to sort');   // staff see the staff notes too
  await page.locator('#whatsnew-x').click(); await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cg:whatsnew:seen'))).toBe(await page.evaluate(() => window.WhatsNew.NOTES[0].id));
});

test('a brand-new device is not shown a change list; staff see nothing, a rider gets first-visit tips once', async ({ page, baseURL }) => {
  await open(page, baseURL, '');
  await page.waitForTimeout(7000);
  await expect(page.locator('#whatsnew')).toHaveCount(0);   // staff: nothing
  expect(await page.evaluate(() => localStorage.getItem('cg:whatsnew:seen'))).toBe(await page.evaluate(() => window.WhatsNew.NOTES[0].id));
});

test('a rider on a brand-new device gets the quick tips, not the change list', async ({ page, baseURL }) => {
  await open(page, baseURL, '', 'member');
  const card = page.locator('#whatsnew'); await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText('Quick tips'); await expect(card).not.toContainText('column heading');
  await page.locator('#whatsnew-x').click(); await expect(card).toHaveCount(0);
});

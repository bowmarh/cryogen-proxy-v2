// @ts-check
// Navigation: the side menu is grouped by purpose (Me / Racing / Rides / Club / Staff tools); on a phone held upright the menu is a bottom bar with a "More" list.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function admin(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
}

test('the side menu is grouped: Home first, then Me (riders only), Racing, Rides, Club and Staff tools; staff pages sit under Staff tools', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await admin(page, baseURL);
  const kids = await page.evaluate(() => [...document.querySelectorAll('#main-nav > *')].filter(e => e.id !== 'pinned-nav' && getComputedStyle(e).display !== 'none').map(e => e.classList.contains('navgroup') ? '#' + e.textContent.trim() : e.textContent.trim().replace(/\s+/g, ' ')));
  expect(kids[0]).toMatch(/Home/);
  const groups = kids.filter(k => k.startsWith('#')); expect(groups).toEqual(['#Racing', '#Rides', '#Club', '#Staff tools'])   // an administrator has no "Me" pages of their own: that group only shows for riders;
  const staffAt = kids.indexOf('#Staff tools'); const after = kids.slice(staffAt + 1).join(' | ');
  for (const w of ['Comms', 'Email', 'Control room', 'Club health']) expect(after).toContain(w);
  expect(kids.slice(0, staffAt).join(' | ')).not.toContain('Control room');
});

test('on a phone held upright the menu is a bottom bar: four main pages, and More opens the list of every page', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await admin(page, baseURL);
  const bar = page.locator('#tabbar'); await expect(bar).toBeVisible({ timeout: 15000 }); await expect(page.locator('#sidebar')).toBeHidden();
  await expect(bar.locator('[data-tab=week]')).toHaveClass(/on/);   // staff open on This week
  await bar.locator('[data-tab=racing]').click(); await expect(page.locator('#page-racing')).toHaveClass(/active/); await expect(bar.locator('[data-tab=racing]')).toHaveClass(/on/);
  await bar.locator('[data-more]').click(); await expect(page.locator('#qf')).toBeVisible();
  await page.locator('#qf-q').fill('control'); await page.keyboard.press('Enter');
  await expect(page.locator('#page-control')).toHaveClass(/active/); await expect(bar.locator('[data-more]')).toHaveClass(/on/);   // a page outside the four: More is highlighted
});

test('on a wide screen the bottom bar is hidden and the side menu is used', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await admin(page, baseURL); await page.waitForTimeout(1200);
  await expect(page.locator('#tabbar')).toBeHidden(); await expect(page.locator('#sidebar')).toBeVisible();
});

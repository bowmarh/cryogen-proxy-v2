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

test('a TTT invitation in My week can be answered "Not this week" (and "I\'m riding"), not just left to nag', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await admin(page, baseURL);
  const posts = [];
  await page.route('**/api/ttt/signup', async route => { posts.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/ttt/repeat', async route => { posts.push({ repeat: true }); await route.fulfill({ status: 200, json: { ok: true } }); });
  await page.evaluate(() => {
    showTab('dashboard', document.querySelector('#main-nav button[onclick*="dashboard"]'));
    myWeek = { windowDays: 7, todo: 1, generated: new Date().toISOString(), name: 'T', items: [{ kind: 'TTT', title: 'Weekly TTT', state: 'todo', note: 'Sign-ups are open. Are you riding?', atMs: Date.now() + 86400000, date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), timed: false, link: 'ttt' }] };
    renderMyWeek();
  });
  const card = page.locator('#myweek-card');
  await expect(card.getByRole('button', { name: /Not this week/ })).toBeVisible();
  await card.getByRole('button', { name: /Not this week/ }).click(); await expect.poll(() => posts.length).toBe(1); expect(posts[0]).toEqual({ available: false });
  await page.evaluate(() => renderMyWeek());
  await card.getByRole('button', { name: /I'm riding/ }).click(); await expect.poll(() => posts.length).toBe(2); expect(posts[1]).toEqual({ repeat: true });
});

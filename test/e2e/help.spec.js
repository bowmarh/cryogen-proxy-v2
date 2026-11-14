// @ts-check
// Help for newcomers: a "What is this page?" box on every page (open the first time, closed after), the one-minute tour, and plain-language tooltips on column headings.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

async function admin(page, baseURL) {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(900);
}

test('every page has a "What is this page?" box: open the first time, closed once you have left, and it explains the words used', async ({ page, baseURL }) => {
  await admin(page, baseURL);
  await page.evaluate(() => localStorage.removeItem('cg:help:seen')); await page.reload(); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(900);
  const missing = await page.evaluate(() => [...document.querySelectorAll('.page')].filter(p => !p.querySelector(':scope > .pagehelp')).map(p => p.id));
  expect(missing).toEqual([]);   // all 26 pages have one
  await page.evaluate(() => showTab('members', document.getElementById('nav-members')));
  const box = page.locator('#page-members > .pagehelp'); await expect(box).toHaveAttribute('open', '');
  await expect(box).toContainText('Everyone in the club'); await expect(box).toContainText('vELO'); await expect(box).toContainText('FTP');
  await page.evaluate(() => showTab('racing', document.querySelector('#main-nav button[onclick*="racing"]')));   // leave it: counts as read
  await page.evaluate(() => showTab('members', document.getElementById('nav-members')));
  await expect(box).not.toHaveAttribute('open', '');
  await box.locator('summary').click(); await expect(box).toHaveAttribute('open', '');   // and it can be opened again
});

test('column headings explain themselves on hover and say "Rating tier" instead of "ZRA Tier"', async ({ page, baseURL }) => {
  await admin(page, baseURL);
  await page.evaluate(() => showTab('members', document.getElementById('nav-members')));
  await expect(page.locator('#members-table-head th', { hasText: 'vELO' })).toHaveAttribute('title', /ZwiftRacing\.app rating/);
  await expect(page.locator('#members-table-head th', { hasText: 'Rating tier' })).toHaveCount(1);
  await expect(page.locator('#members-table-head th', { hasText: 'ZRA Tier' })).toHaveCount(0);
});

test('the quick tour: opens from Go to, walks the steps with a spotlight, and closes with Esc or Done', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await admin(page, baseURL);
  await page.locator('#find-btn').click(); await page.locator('#qf-q').fill('tour'); await page.keyboard.press('Enter');
  const tour = page.locator('#tour'); await expect(tour).toBeVisible(); await expect(tour).toContainText('Welcome to the club app'); await expect(tour).toContainText('Step 1 of');
  await page.locator('#tour-next').click(); await expect(tour).toContainText('Your menu');
  expect(await tour.locator('div[aria-hidden=true]').evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThan(100);   // the spotlight is on the menu
  await page.locator('#tour-back').click(); await expect(tour).toContainText('Welcome');
  await page.keyboard.press('Escape'); await expect(tour).toHaveCount(0);
  await page.evaluate(() => Tour.start()); let guard = 0;
  while (await page.locator('#tour').count() && guard++ < 10) await page.locator('#tour-next').click();   // Next ... Done
  await expect(page.locator('#tour')).toHaveCount(0);
});

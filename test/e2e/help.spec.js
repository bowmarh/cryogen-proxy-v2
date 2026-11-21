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

test('ZRL page: an administrator adds the league links and they show as buttons for everyone', async ({ page, baseURL }) => {
  await admin(page, baseURL);
  await page.evaluate(() => showTab('zrl', document.querySelector('#main-nav button[onclick*="zrl"]')));
  const box = page.locator('#zrl-links'); await expect(box).toBeVisible({ timeout: 15000 });
  await expect(box).toContainText('No links yet');
  await box.getByRole('button', { name: /Add links/ }).click();
  await page.locator('#zl-rp').fill('https://example.com/racepass'); await page.locator('#zl-res').fill('https://example.com/results'); await page.locator('#zl-st').fill('javascript:alert(1)');
  await box.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('#zl-err')).toContainText('https://');   // a bad link is refused
  await page.locator('#zl-st').fill('https://example.com/standings'); await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByRole('link', { name: /RacePass/ })).toHaveAttribute('href', 'https://example.com/racepass');
  await expect(box.getByRole('link', { name: /League standings/ })).toHaveAttribute('target', '_blank');
});

test('TTT: a week set up on a Wednesday shows staff a one-tap "Move to Thursday"', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7 || 7) + 7);   // a Wednesday, a week or so ahead
  const wed = d.toISOString().slice(0, 10), thu = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
  expect((await page.request.post('/api/ttt/new-week', { data: { date: wed }, headers: { Authorization: 'Bearer ' + tok } })).ok()).toBe(true);
  await admin(page, baseURL);
  await page.evaluate(() => showTab('ttt', document.querySelector('#main-nav button[onclick*="ttt"]')));
  const bar = page.locator('#ttt-root [role=status]', { hasText: 'every Thursday' }); await expect(bar).toBeVisible({ timeout: 15000 });
  await expect(bar).toContainText('Wednesday');
  await bar.getByRole('button', { name: /Move to Thu/ }).click();
  await expect(page.locator('#ttt-root')).toContainText('Thu', { timeout: 15000 });
  await expect(page.locator('#ttt-root [role=status]', { hasText: 'every Thursday' })).toHaveCount(0);
  const wk = await (await page.request.get('/api/ttt', { headers: { Authorization: 'Bearer ' + tok } })).json(); expect(wk.week.date).toBe(thu);
});

test('My Profile shows the rider their Zwift ID and time zone with a Change button; the race card says when it starts in their time zone', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => showTab('profile', document.getElementById('nav-profile')));
  const prof = page.locator('#profile-content'); await expect(prof).toContainText('Zwift ID', { timeout: 15000 }); await expect(prof).toContainText('1002');
  await expect(prof).toContainText('Time zone'); await prof.getByRole('button', { name: 'Change' }).click(); await expect(page.locator('#tzModal')).toBeVisible();
  await page.evaluate(() => closeTz());
  await page.evaluate(() => {
    showTab('dashboard', document.querySelector('#main-nav button[onclick*="dashboard"]'));
    myWeek = { windowDays: 7, todo: 0, generated: new Date().toISOString(), name: 'T', items: [{ kind: 'ZRL', title: 'Team · race 2', state: 'in', note: "You're in the line-up", atMs: Date.now() + 5400000, date: new Date().toISOString().slice(0, 10), timed: true, link: '', pen: { kind: 'zrl', id: '1:t' } }] };
    renderMyWeek();
  });
  await expect(page.locator('#raceday')).toContainText('Starts'); await expect(page.locator('#raceday')).toContainText('wrong time zone?');
});

test('on a phone, offers such as "Stay signed in" sit at the top under the header, never over the bottom controls', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(900);
  await page.evaluate(() => { const b = document.createElement('div'); b.id = 'stay-banner'; b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9998;background:#0f172a;padding:12px'; b.textContent = 'Stay signed in on this device?'; document.body.appendChild(b); });
  const box = await page.locator('#stay-banner').boundingBox(); expect(box.y).toBeLessThan(120);   // at the top, not the bottom
});

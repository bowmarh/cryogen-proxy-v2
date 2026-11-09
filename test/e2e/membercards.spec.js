// @ts-check
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

async function signInAsRider(page, baseURL) {
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('a new rider sees the first-race checklist and a race recap on the dashboard', async ({ page, baseURL }) => {
  await page.route('**/api/onboarding/me', r => r.fulfill({ json: { show: true, days: 3, done: 2, total: 5, next: 'standard', steps: [
    { id: 'discord', label: 'Link your Discord', done: true, hint: 'h' }, { id: 'category', label: 'Get a rider category on file', done: true, hint: 'h' },
    { id: 'series', label: 'Get on a team', done: false, hint: 'h', tab: 'events' }, { id: 'standard', label: 'Read the Fair play note', done: false, hint: 'Keep a second recording running.', ack: true },
    { id: 'raced', label: 'Finish your first club race', done: false, hint: 'h' }] } }));
  await page.route('**/api/me/recap', r => r.fulfill({ json: { name: 'Rider Two', headline: 'Nice climb, Rider!', lines: ['📈 vELO 1100 (+40 in 7 days)', '⚡ 5 min 4.00 W/kg'], empty: false } }));
  await signInAsRider(page, baseURL);
  await expect(page.locator('#onboard-card')).toContainText('Your first race: 2 of 5 done');
  await expect(page.locator('#onboard-card')).toContainText("I've read it");
  await expect(page.locator('#recap-card')).toContainText('Nice climb, Rider!');
  await expect(page.locator('#recap-card')).toContainText('+40 in 7 days');
});

test('a signed-in page shows a saved-data note when the server marks a reply stale, and clears it when live again', async ({ page, baseURL }) => {
  let stale = true;
  await page.route('**/api/me/recap', r => r.fulfill({ json: { headline: 'x', lines: ['l'], empty: false }, headers: stale ? { 'X-Stale': '1' } : {} }));
  await signInAsRider(page, baseURL);
  await expect(page.locator('#stale-banner')).toContainText('Showing saved data');
  stale = false;
  await page.evaluate(() => { window._staleAt = Date.now() - 61000; return fetch('/api/me/recap', { headers: tttHeaders() }); });
  await expect(page.locator('#stale-banner')).toHaveCount(0);
});

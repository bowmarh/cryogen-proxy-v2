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

test('a captain sees the cockpit and every rider sees their badges', async ({ page, baseURL }) => {
  await page.route('**/api/me/cockpit', r => r.fulfill({ json: { captain: true, round: 'Round 2', teams: [{ id: 't1', name: 'CRYO-GEN Beta', next: { week: 2, weekIndex: 1, date: '2026-11-17', racing: 3, lineupSet: false,
    yes: ['Ann Lee'], maybe: ['Bo Dunn'], no: [], pending: ['Di Fox'], inPen: [], lineup: [], short: 2, suggestion: ['Ann Lee', 'Bo Dunn'] } }] } }));
  await page.route('**/api/me/badges', r => r.fulfill({ json: { earned: [{ id: 'first_race', icon: '🏁', label: 'First race' }], locked: [], next: { text: '5 more for 25 races' } } }));
  await signInAsRider(page, baseURL);
  await expect(page.locator('#cockpit-card')).toContainText("Captain's cockpit · CRYO-GEN Beta · race 2");
  await expect(page.locator('#cockpit-card')).toContainText('Suggested line-up');
  await expect(page.locator('#cockpit-card')).toContainText("Ask the 1 who haven't answered");
  await expect(page.locator('#badges-card')).toContainText('First race');
  await expect(page.locator('#badges-card')).toContainText('5 more for 25 races');
});

test('a rider sees their Wrapped card and, on an iPhone, how to add the app to the home screen', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' }), page = await ctx.newPage();
  await page.route('**/api/me/wrapped', r => r.fulfill({ json: { title: "Ann's season", season: 'Round 2', empty: false, stats: [{ icon: '🏁', label: 'Races finished', value: '12' }, { icon: '🥇', label: 'Wins', value: '1' }], lines: ['12 races finished'], badges: [{ icon: '🔟', label: '10 races' }] } }));
  await signInAsRider(page, baseURL);
  await expect(page.locator('#wrapped-card')).toContainText("Ann's season");
  await expect(page.locator('#wrapped-card')).toContainText('Races finished');
  await expect(page.locator('#install-card')).toContainText('Add to Home Screen');
  await page.locator('#install-card').getByText('Not now').click();
  await expect(page.locator('#install-card')).toBeEmpty();
  await ctx.close();
});

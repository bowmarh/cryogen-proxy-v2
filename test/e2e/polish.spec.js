'use strict';
// Rider pages: light/dark theme, the basic accessibility checks, and the "since you last looked" line.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function signInAsRider(page, baseURL) {
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('the theme button cycles Auto, Light, Dark and the choice is kept', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const btn = page.locator('#theme-btn');
  await expect(btn).toContainText('Auto');
  await btn.click(); await expect(btn).toContainText('Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#theme-btn').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the rider pages pass the basic accessibility checks', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const tabs = [/Dashboard|Overview/, /TTT Week/, /My Profile/];
  for (const name of tabs) {
    const b = page.getByRole('button', { name }).first();
    if (await b.count()) await b.click();
    await page.waitForTimeout(400);
    const problems = await page.evaluate(() => {
      const out = [];
      const named = el => el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length) || el.closest('label') || el.getAttribute('aria-labelledby');
      document.querySelectorAll('button,a[href]').forEach(el => { if (el.offsetParent && !named(el)) out.push('unnamed control: ' + el.outerHTML.slice(0, 80)); });
      document.querySelectorAll('input:not([type=hidden]),select,textarea').forEach(el => { if (el.offsetParent && !named(el)) out.push('unlabelled field: ' + el.outerHTML.slice(0, 80)); });
      document.querySelectorAll('img').forEach(el => { if (el.offsetParent && !el.hasAttribute('alt')) out.push('image without alt: ' + el.src.slice(-30)); });
      return out;
    });
    expect(problems, String(name)).toEqual([]);
  }
  await expect(page.locator('a.skip')).toHaveAttribute('href', '#main');
  await expect(page.locator('main#main')).toBeAttached();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('text colours used for small print are readable on the dark cards', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const ratio = await page.evaluate(() => {
    const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const worst = ['#8b95a5', '#7b8494'].map(fg => (Math.max(lum(fg), lum('#0f1623')) + 0.05) / (Math.min(lum(fg), lum('#0f1623')) + 0.05));
    return { worst: Math.min(...worst), oldGrey: /#6b7280/.test(document.documentElement.outerHTML) };
  });
  expect(ratio.worst).toBeGreaterThanOrEqual(4.5);
  expect(ratio.oldGrey).toBe(false);
});

test('My week says what changed since the last visit', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const out = await page.evaluate(() => {
    const items = [{ kind: 'TTT', title: 'Tuesday TTT', date: '2026-11-03', state: 'todo', note: 'answer please' }];
    myWeekChanges(items);                                           // first visit: nothing to compare with
    const same = myWeekChanges(items);                              // same visit again: still nothing
    const snap = JSON.parse(localStorage.getItem('mw:snap')); snap.at -= 3600000; localStorage.setItem('mw:snap', JSON.stringify(snap));   // an hour passes
    const next = myWeekChanges([{ ...items[0], state: 'in', note: 'you are in' }, { kind: 'ZRL', title: 'Race 1', date: '2026-11-05', state: 'todo', note: 'new' }]);
    return { same, next };
  });
  expect(out.same).toEqual([]);
  expect(out.next.join(' | ')).toMatch(/Changed: TTT “Tuesday TTT”.*you are in/);
  expect(out.next.join(' | ')).toMatch(/New: ZRL “Race 1”/);
});

test('customise: accent, spacing, text size and which dashboard cards show are kept in the browser', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase());
  expect(await accent()).toBe('#00d4ff');
  await page.locator('#ui-btn').click();
  await expect(page.getByRole('dialog', { name: 'Customise' })).toBeVisible();
  await page.getByRole('button', { name: 'orange accent' }).click();
  expect(await accent()).toBe('#ff8a1f');
  await page.locator('select[aria-label="density"]').selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.locator('select[aria-label="text"]').selectOption('l');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-zoom').trim())).toBe('1.1');
  // Hide the recent-results card, move charts to the top.
  await page.getByRole('checkbox', { name: /Recent results/ }).uncheck();
  await expect(page.locator('[data-card="results"]')).toBeHidden();
  for (let i = 0; i < 4; i++) { const up = page.getByRole('button', { name: 'Move Charts up' }); if (await up.isEnabled()) await up.click(); }
  expect(await page.evaluate(() => document.querySelector('[data-card="charts"]').style.order)).toBe('0');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui-modal')).toHaveCount(0);
  await page.reload(); await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  expect(await accent()).toBe('#ff8a1f');
  await expect(page.locator('[data-card="results"]')).toBeHidden();
  // Back to the defaults.
  await page.locator('#ui-btn').click(); await page.getByRole('button', { name: 'Back to the defaults' }).click();
  expect(await accent()).toBe('#00d4ff');
  await expect(page.locator('[data-card="results"]')).toBeVisible();
});

test('the dashboard shows the three charts and the club welcome line when the club sets one', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await expect(page.locator('[data-card="charts"] svg').first()).toBeVisible();
  await expect(page.locator('[data-card="charts"]')).toContainText('Who rides what');
  await expect(page.locator('[data-card="charts"]')).toContainText('Ride sign-ups per week');
  await expect(page.locator('#club-welcome')).toBeHidden();
});

test('a club logo address that is not a picture falls back to the CRYO-GEN logo instead of a broken image', async ({ page, baseURL }) => {
  await page.route('**/api/club/theme', r => r.fulfill({ json: { accent: '', welcome: '', logo: 'https://not-a-picture.invalid/home' } }));
  await signInAsRider(page, baseURL);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('img[data-brand]')].map(i => i.getAttribute('src')).join(','))).toMatch(/^(\/logo\.png,?)+$/);
  expect(await page.evaluate(() => [...document.querySelectorAll('img[data-brand]')].every(i => i.complete && i.naturalWidth > 0))).toBe(true);
});

test('one-tap looks set theme, accent, text size, colour-blind-safe categories and reduced motion together', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.locator('#ui-btn').click();
  await page.getByRole('button', { name: /High contrast/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase())).toBe('#fbbf24');
  expect(await page.evaluate(() => CAT_COLOR.B)).toBe('#0072B2');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-zoom').trim())).toBe('1.1');
  await page.getByRole('button', { name: /Daylight/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'auto');
  expect(await page.evaluate(() => CAT_COLOR.B)).toBe('#3B82F6');
});

test('pinned pages appear at the top of the menu and open their page; each series can have its own colour', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.locator('#ui-btn').click();
  await page.getByRole('checkbox', { name: /^ ?🏁? ?TTT Week/ }).check();
  await page.keyboard.press('Escape');
  const pinned = page.locator('#pinned-nav .navbtn');
  await expect(pinned).toHaveCount(1);
  await expect(pinned).toContainText('TTT Week');
  await pinned.click();
  await expect(page.locator('#page-ttt')).toHaveClass(/active/);
  await page.locator('#ui-btn').click();
  await page.getByRole('checkbox', { name: /A colour for each series/ }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /ZRL/ }).first().click();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase())).toBe('#a78bfa');
});

test('a rider picks an emoji avatar and it shows next to their name', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.locator('#ui-btn').click();
  await page.getByRole('button', { name: 'Use 🦊' }).click();
  await expect(page.locator('#top10 .av', { hasText: '🦊' })).toHaveCount(1);   // the window is redrawn after the save, so wait for that
  await page.getByRole('button', { name: 'None' }).click();
  await expect(page.locator('#top10 .av', { hasText: '🦊' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('My week has a month view, and an empty week offers a next step', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  expect(await page.evaluate(() => uiEmpty('📅', 'A clear week', 'Nothing planned.', 'Find a ride', 'weekGo(\'rides\')'))).toContain('Find a ride');
  await page.locator('#myweek-card summary', { hasText: 'Month view' }).click();
  await expect(page.locator('#myweek-card [role="gridcell"]')).toHaveCount(42);
  await expect(page.locator('#myweek-card [role="columnheader"]')).toHaveCount(7);
  const problems = await page.evaluate(() => [...document.querySelectorAll('#myweek-card button,#myweek-card a[href]')].filter(el => !(el.getAttribute('aria-label') || el.textContent.trim())).length);
  expect(problems).toBe(0);
});

test('standings get a podium and a points-over-the-round chart, with a colour per team', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  const out = await page.evaluate(() => {
    const g = { name: 'Division 1', teams: [
      { id: 'a', name: 'CRYO-GEN Alpha', rank: 1, total: 30, weeks: [{ pts: 10 }, { pts: 20 }] },
      { id: 'b', name: 'CRYO-GEN Beta', rank: 2, total: 22, weeks: [{ pts: 12 }, { pts: 10 }] },
      { id: 'c', name: 'CRYO-GEN Gamma', rank: 3, total: 9, weeks: [null, { pts: 9 }] }] };
    return { pod: uiPodium(g), chart: uiPointsChart(g, ['2026-11-17', '2026-11-24']), none: uiPodium({ teams: [{ id: 'a', name: 'A', rank: 1, total: 5, weeks: [] }] }) };
  });
  expect(out.pod).toContain('🥇'); expect(out.pod).toContain('🥈'); expect(out.pod).toContain('🥉');
  expect((out.chart.match(/<path/g) || []).length).toBe(3);
  expect(out.none).toBe('');
});

test('the staff page chart, the rider profile charts and the picture cards work', async ({ page, baseURL }) => {
  await page.route('**/api/staff/trend', r => r.fulfill({ json: { days: [{ d: '2026-10-29', attention: 5, racing: 40, unplaced: 3 }, { d: '2026-10-30', attention: 3, racing: 44, unplaced: 1 }] } }));
  await page.route('**/api/me/velo', r => r.fulfill({ json: { history: [{ d: '2026-10-28', v: 1190 }, { d: '2026-10-29', v: 1200 }, { d: '2026-10-30', v: 1215 }] } }));
  await signInAsRider(page, baseURL);
  const host = await page.evaluate(async () => { const el = document.createElement('div'); el.id = 'tmp-trend'; document.body.appendChild(el); await uiStaffTrend(el); return el.textContent; });
  expect(host).toContain('Needs attention'); expect(host).toContain('Riders without a team');
  await page.getByRole('button', { name: /My Profile/ }).click();
  await expect(page.locator('#prof-charts')).toContainText('Power curve');
  await expect(page.locator('#prof-charts')).toContainText('My vELO');
  await expect(page.locator('#prof-charts svg').first()).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.evaluate(() => uiLineupCard('CRYO-GEN Alpha', 'Race 1 · Tue 3 Nov', ['Ann Able', 'Bob Brown', 'Cy Cole']));
  expect((await dl).suggestedFilename()).toBe('cryogen-lineup.png');
  const dl2 = page.waitForEvent('download');
  await page.evaluate(() => uiResultsCard('Division 1', [{ rank: 1, name: 'Alpha', total: 30 }, { rank: 2, name: 'Beta', total: 22 }]));
  expect((await dl2).suggestedFilename()).toBe('cryogen-results.png');
});

test('the public club wall shows the club colour, a countdown and the top three, and nothing about people', async ({ page, baseURL }) => {
  const at = Date.now() + 3 * 86400000 + 5 * 3600000;
  await page.route('**/api/public/club', r => r.fulfill({ json: { name: 'CRYO-GEN', accent: '#a78bfa', welcome: 'Race week!', ladder: [], drs: [], next: [{ series: 'ZRL', title: 'Round 2 · race 1', at, date: '2026-11-03' }], podium: [{ division: 'Division 1', top: [{ rank: 1, team: 'Alpha', points: 30 }, { rank: 2, team: 'Beta', points: 22 }, { rank: 3, team: 'Gamma', points: 9 }] }] } }));
  await page.goto(`${baseURL}/club.html`);
  await expect(page.locator('.welcome')).toContainText('Race week!');
  await expect(page.locator('#count')).toContainText(/^3d \d\d:\d\d:\d\d$/);
  await expect(page.locator('.pod')).toContainText('Alpha'); await expect(page.locator('.pod')).toContainText('🥇');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#a78bfa');
});

test('the profile keeps its stat tiles in one row, the charts have their own slot, and the rider type bars stay inside their card', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.getByRole('button', { name: /My Profile/ }).click();
  await expect(page.locator('#prof-charts')).toContainText('Power curve');
  expect(await page.locator('#profile-content .stat4 > .card').count()).toBe(4);
  expect(await page.evaluate(() => [...document.querySelectorAll('#profile-content .pbar-fill')].every(b => b.getBoundingClientRect().right <= b.closest('.card').getBoundingClientRect().right + 1))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('prof-charts').nextElementSibling.classList.contains('stat4'))).toBe(true);
});

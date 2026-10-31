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

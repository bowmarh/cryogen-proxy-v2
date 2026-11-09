// @ts-check
// Automated accessibility checks (axe, WCAG 2 A and AA) on the pages a rider sees, in both themes, and on the public pages. Serious and critical
// problems fail the build; the rest are left for a person to judge.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const h = require('../helpers');

h.setEnv();
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TABS = ['dashboard', 'racing', 'zrl', 'ttt', 'ladder', 'drs', 'events', 'rides', 'members', 'profile', 'standard'];
const RULES = { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] };

async function violations(page) {
  await page.evaluate(AXE);
  const found = await page.evaluate(async rules => (await axe.run(document, rules)).violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`), RULES);
  return found;
}

for (const theme of ['dark', 'light']) {
  test(`rider pages have no serious accessibility problems (${theme} theme)`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    for (let i = 0; i < 4 && (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== theme; i++) await page.locator('#theme-btn').click();
    const problems = [];
    for (const tab of TABS) {
      await page.evaluate(id => { const b = [...document.querySelectorAll('.navbtn')].find(x => (x.getAttribute('onclick') || '').includes(`'${id}'`)); if (b) b.click(); }, tab);
      await page.waitForTimeout(500);
      for (const v of await violations(page)) problems.push(`[${tab}] ${v}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the public club page and the race-day board have no serious accessibility problems', async ({ page, baseURL }) => {
  await page.route('**/api/public/club', r => r.fulfill({ json: { name: 'CRYO-GEN', accent: '#00D4FF', welcome: 'Race week!', ladder: [], drs: [], next: [{ series: 'ZRL', title: 'Round 2 · race 1', at: Date.now() + 86400000, date: '2026-11-10' }], podium: [{ division: 'Division 1', top: [{ rank: 1, team: 'Alpha', points: 90 }] }] } }));
  await page.route('**/api/public/live', r => r.fulfill({ json: { generated: new Date().toISOString(), next: null, leaders: [{ division: 'Division 1', top: [{ rank: 1, team: 'Alpha', points: 90 }] }], events: [{ series: 'ZRL', title: 'Alpha · race 2', at: Date.now() + 1500000, minutes: 25, phase: 'pen', need: 4, ready: 3, full: false }] } }));
  const problems = [];
  for (const path of ['/club.html', '/live.html']) { await page.goto(`${baseURL}${path}`); await page.waitForTimeout(600); for (const v of await violations(page)) problems.push(`[${path}] ${v}`); }
  expect(problems, problems.join('\n')).toEqual([]);
});

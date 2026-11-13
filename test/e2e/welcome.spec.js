// @ts-check
// The new-member "Get set up" screen covers the app until the channels are done, then shows the racing series, then lets them in. The server's answers are mocked here
// (the rules are tested in test/welcome.test.js); this checks what the screen does with them.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

const STEPS = done => [
  { id: 'discord', title: 'Join and link Discord', why: 'Captains reach you here.', url: 'https://discord.gg/x', done: false, auto: true },
  { id: 'zwiftpower', title: 'Join Team CRYO-GEN on ZwiftPower', why: 'Results are tied to it.', url: 'https://zwiftpower.com/team.php?id=1', done, accepted: false, action: 'Open the ZwiftPower team' },
  { id: 'facebook', title: 'Join the Facebook group', why: 'News and photos.', url: 'https://facebook.com/groups/x', done, action: 'Open the Facebook group' },
];

test('a new member must finish the channels, then sees every racing series, then reaches the dashboard', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let stage = 1, finished = false, confirmed = [];
  await page.route('**/api/me/welcome', r => r.fulfill({ json: finished ? { show: false } : stage === 1 ? { show: true, stage: 1, name: 'Pat Joiner', steps: STEPS(confirmed.length > 0), series: [] } : { show: true, stage: 2, name: 'Pat Joiner', steps: STEPS(true).map(s => ({ ...s, done: true })), series: [{ id: 'zrl', title: 'ZRL team racing', blurb: 'Weekly rounds.', tab: 'zrl', cta: 'Sign up for ZRL' }, { id: 'ttt', title: 'Team time trials', blurb: 'Ride as a team.', tab: 'ttt', cta: 'See this week\'s TTT' }, { id: 'drs', title: 'DIRT racing', blurb: 'Gravel.', tab: 'drs', cta: 'Join the DIRT series' }] } }));
  await page.route('**/api/me/welcome/confirm', r => { confirmed.push(r.request().postDataJSON().step); stage = 2; r.fulfill({ json: { show: true, stage: 2, steps: STEPS(true).map(s => ({ ...s, done: true })), series: [{ id: 'zrl', title: 'ZRL team racing', blurb: 'Weekly rounds.', tab: 'zrl', cta: 'Sign up for ZRL' }] } }); });
  await page.route('**/api/me/welcome/finish', r => { finished = true; r.fulfill({ json: { ok: true } }); });
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  const gate = page.locator('#welcome-gate'); await expect(gate).toBeVisible({ timeout: 15000 });
  await expect(gate).toContainText('Three quick things first'); await expect(gate).toContainText('Join Team CRYO-GEN on ZwiftPower'); await expect(gate).toContainText('Join the Facebook group');
  await expect(gate.getByRole('link', { name: /Open the ZwiftPower team/ })).toHaveAttribute('href', 'https://zwiftpower.com/team.php?id=1');
  expect(await page.evaluate(() => { const r = document.getElementById('welcome-gate').getBoundingClientRect(); return r.width >= innerWidth && r.height >= innerHeight; })).toBe(true);   // it covers everything
  await gate.getByRole('button', { name: 'I have asked to join' }).first().click();
  await expect(gate).toContainText('what would you like to race'); await expect(gate).toContainText('ZRL team racing');
  await gate.getByRole('button', { name: 'Take me to the dashboard' }).click();
  await expect(gate).toBeHidden(); await expect(page.locator('#app')).toBeVisible();
  expect(errors).toEqual([]);
});

'use strict';
// Staff open an investigation and add a FIT file in the browser; a member talks to the coach and has their own ride explained.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
const { build, rng } = require('../fitwriter');

h.setEnv();

function ride({ flat = true } = {}) {
  const R = rng(5), rows = [];
  for (let i = 0; i < 1800; i++) { const p = flat && i >= 600 && i < 790 ? 310 : Math.round(220 + 40 * Math.sin(i / 90) + (R() - 0.5) * 24); rows.push({ p, hr: Math.round(120 + p * 0.12), cad: 88, spd: 9, dist: i * 9, alt: 0 }); }
  return build({ rows, devices: [{ type: 11, maker: 260, product: 1, name: 'Zwift Power' }] });
}

test('staff open a case, add a FIT file, and see the flat stretch with the ordinary explanations beside it', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL);
  await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-inv').click();
  await expect(page.locator('#inv-content')).toContainText('prompts for a person to look');
  await page.locator('#inv-rider').fill('Rider 2 (1002)');
  await page.locator('#inv-title').fill('Flat watts');
  await page.getByRole('button', { name: 'Open the file' }).click();
  await expect(page.locator('#inv-content h2')).toContainText('Flat watts');
  await page.locator('#inv-file').setInputFiles({ name: 'race.fit', mimeType: 'application/octet-stream', buffer: ride() });
  await expect(page.locator('#inv-content')).toContainText('The same power for a long stretch', { timeout: 15000 });
  await expect(page.locator('#inv-content')).toContainText('Zwift');
  await expect(page.locator('#inv-content svg').first()).toBeVisible();
  await page.locator('#inv-content summary', { hasText: 'Ordinary explanations' }).first().click();
  await expect(page.locator('#inv-content')).toContainText('ERG mode');
  await expect(page.locator('#inv-content')).toContainText('Switch on ANTHROPIC_API_KEY');   // no key in the test server: the findings still work
  await page.locator('#inv-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not a fit file at all, sorry') });
  await expect(page.locator('#inv-up')).toContainText('not a FIT file');
});

test('a member says yes to the coach, asks a question, and has a FIT ride explained', async ({ page, baseURL }) => {
  let consent = false;
  await page.route('**/api/coach/status', r => r.fulfill({ json: { enabled: true, consent, remaining: 12, limit: 12 } }));
  await page.route('**/api/coach/consent', r => { consent = JSON.parse(r.request().postData()).on; r.fulfill({ json: { enabled: true, consent, remaining: 12, limit: 12 } }); });
  await page.route('**/api/coach/chat', r => r.fulfill({ json: { reply: 'Plan:\n\n- Tue: 2 x 20 min at 90% FTP\n- Thu: 60 min easy', remaining: 11 } }));
  await page.route('**/api/coach/ride', r => r.fulfill({ json: { reply: 'You started a little hard.', remaining: 10, ride: { minutes: 30, avgPower: 230, normalizedPower: 240, variabilityIndex: 1.04, bestWatts: { '1200s': 250 }, heartRate: { avg: 140, decouplingPercent: 3.2 }, minutesInZones: { 'Z2 endurance': 20, 'Z4 threshold': 10 } } } }));
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.locator('#nav-coach').click();
  await expect(page.locator('#coach-content')).toContainText('Before you start');
  await expect(page.locator('#coach-content')).toContainText('never gets your name, your weight');
  await page.getByRole('button', { name: 'Yes, coach me' }).click();
  await page.getByRole('button', { name: 'Plan my week' }).click();
  await expect(page.locator('#coach-content li', { hasText: '2 x 20 min at 90% FTP' })).toBeVisible();
  await expect(page.locator('#coach-content')).toContainText('11 of 12 questions left');
  await page.locator('#coach-content input[type=file]').setInputFiles({ name: 'ride.fit', mimeType: 'application/octet-stream', buffer: ride({ flat: false }) });
  await expect(page.locator('#coach-content')).toContainText('You started a little hard.');
  await expect(page.locator('#coach-content')).toContainText('Minutes in zones');
  await page.getByRole('link', { name: 'Stop using my numbers' }).click();
  await expect(page.locator('#coach-content')).toContainText('Before you start');
});

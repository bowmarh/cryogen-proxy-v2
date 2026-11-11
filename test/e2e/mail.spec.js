// @ts-check
// The Email page: staff write, check, preview and count recipients; the page works with the mocked mail service and has no a11y violations.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const h = require('../helpers');

h.setEnv();

const STATE = { segments: [['zrl', 'Riding in ZRL this round']], settings: { enabled: true, fromName: 'CRYO-GEN', replyTo: '', footer: '', perHour: 30, perDay: 200, automations: { newsletter: { on: false, mode: 'approve' }, welcome: { on: false }, quiet: { on: false } } },
  provider: 'hostinger', configured: true, campaigns: [], groups: [{ id: 'g1', name: 'Captains', segments: ['zrl'], zwids: [] }], log: [], addresses: { members: 10, withEmail: 8, ambiguous: 1, unmatched: 1, wpUsers: 9, at: '2026-11-04' } };

test('staff can draft, check, preview and count an email, and the page is accessible', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/\/api\/mail(\?|$)/, r => r.fulfill({ json: STATE }));
  await page.route('**/api/mail/draft', r => r.fulfill({ json: { subject: 'Race week', body: 'Hi {first},\n\nThree races this week.' } }));
  await page.route('**/api/mail/save', r => r.fulfill({ json: { campaign: { id: 'c1', subject: 'Race week', body: 'Hi {first}', category: 'news', audience: { type: 'all' }, status: 'draft' } } }));
  await page.route('**/api/mail/check', r => r.fulfill({ json: { check: { ok: true, issues: [], ai: { ran: false, note: 'The AI check could not run: only the fixed rules were applied.' } } } }));
  await page.route('**/api/mail/audience', r => r.fulfill({ json: { count: 8, noEmail: 2, optedOut: 0, estimate: 'about 1 hour' } }));
  await page.route('**/api/mail/preview', r => r.fulfill({ json: { subject: 'Race week', html: '<p>Hi Alex,</p>', text: 'Hi Alex,' } }));
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-mail').click();
  await expect(page.locator('#mail-content')).toContainText('Email');
  await page.locator('#mail-brief').fill('Remind riders about race week');
  await page.getByRole('button', { name: /Draft with AI/ }).click();
  await expect(page.locator('#mail-subject')).toHaveValue('Race week');
  await page.getByRole('button', { name: /Check/ }).click();
  await expect(page.locator('#mail-content')).toContainText('Passed the check');
  await page.getByRole('button', { name: /Count recipients/ }).click();
  await expect(page.locator('#mail-content')).toContainText('8');
  await page.getByRole('button', { name: /Preview/ }).click();
  await expect(page.locator('iframe[title="Email preview"]')).toBeVisible();
  await page.evaluate(AXE);
  const bad = await page.evaluate(async () => (await axe.run(document.getElementById('page-mail'), { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`));
  expect(bad).toEqual([]);
  await page.getByRole('tab', { name: /Groups/ }).click();
  await expect(page.locator('#mail-content')).toContainText('Captains');
  expect(errors).toEqual([]);
});

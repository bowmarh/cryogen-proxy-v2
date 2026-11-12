// @ts-check
// The control room: staff see race day and system health, can open the join queue and answer a request; the page has no serious a11y problems.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const h = require('../helpers');

h.setEnv();

test('staff see race day and system health and can answer a join request; the public join page works', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); const sent = {};
  await page.route(/\/api\/control$/, r => r.fulfill({ json: { generated: '2026-11-04T10:00:00Z', joinOpen: 1, feed: [{ team: 'Alpha', text: '🏁 Alpha finished 1st' }], systems: [{ name: 'Email service', level: 'bad', detail: 'A send is paused.' }, { name: 'Storage', level: 'ok', detail: 'Answered in 5 ms.' }],
    race: { round: 'Round 2', week: 0, date: '2026-11-10', racing: 2, teams: [{ id: 't1', name: 'Alpha', riders: 3, yes: 2, maybe: 1, no: 0, picked: 1, short: 1, result: { pos: 1, pts: 30 } }] } } }));
  await page.route('**/api/join', r => r.fulfill({ json: { requests: [{ id: 'j1', name: 'New Rider', email: 'new@x.test', zwid: '123', at: '2026-11-04T10:00:00Z', status: 'open', note: 'Keen' }] } }));
  await page.route('**/api/join/decide', r => { sent.decide = r.request().postDataJSON(); r.fulfill({ json: { request: {} } }); });
  page.on('dialog', d => d.accept());
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-control').click();
  await expect(page.locator('#control-content')).toContainText('Needs attention'); await expect(page.locator('#control-content')).toContainText('A send is paused.');
  await expect(page.locator('#control-content')).toContainText('Alpha'); await expect(page.locator('#control-content')).toContainText('1 short');
  await page.evaluate(AXE);
  const bad = await page.evaluate(async () => (await axe.run(document.getElementById('page-control'), { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`));
  expect(bad).toEqual([]);
  await page.getByRole('tab', { name: /Join requests/ }).click(); await expect(page.locator('#control-content')).toContainText('New Rider');
  await page.getByRole('button', { name: 'Send welcome email' }).click(); await expect.poll(() => sent.decide).toEqual({ id: 'j1', action: 'welcome' });
  expect(errors).toEqual([]);
  // The public page
  const pub = await page.context().newPage(); await pub.route('**/api/join', r => { sent.join = r.request().postDataJSON(); r.fulfill({ json: { ok: true } }); });
  await pub.goto(baseURL + '/join.html'); await pub.fill('#name', 'Pat Example'); await pub.fill('#email', 'pat@example.com'); await pub.check('#consent'); await pub.getByRole('button', { name: 'Ask to join' }).click();
  await expect(pub.locator('#msg')).toContainText('Thank you'); expect(sent.join).toMatchObject({ name: 'Pat Example', email: 'pat@example.com', consent: true, website: '' });
});

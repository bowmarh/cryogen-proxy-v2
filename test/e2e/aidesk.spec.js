// @ts-check
// The AI desk page: staff reach every tab, run a line-up suggestion and a reply sort against mocked services, and the page has no serious a11y problems.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const h = require('../helpers');

h.setEnv();

test('staff can use every tab of the AI desk and the page is accessible', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: h.BASE_ENV.OWNER_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('owner', '1'); } }, tok);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/\/api\/aiops$/, r => r.fulfill({ json: { settings: { radio: { on: false }, reports: { auto: false } }, aiOn: true, mailOn: true, triage: 1 } }));
  await page.route(/\/api\/zrl$/, r => r.fulfill({ json: { round: { name: 'R', weeks: 3, teams: [{ id: 't1', name: 'Alpha' }] } } }));
  const sent = {};
  await page.route('**/api/aiops/lineup', r => { sent.lineup = r.request().postDataJSON(); return r.fulfill({ json: { team: 'Alpha', week: 0, need: 2, short: 0, picks: [{ zwid: '1', name: 'Ann Lee', why: 'Said yes, vELO 1800' }], bench: [], explanation: 'Looks balanced.' } }); });
  await page.route('**/api/aiops/churn', r => r.fulfill({ json: { note: 'A guide.', members: [{ zwid: '2', name: 'Bo Dunn', days: 120, level: 'high', score: 76 }] } }));
  await page.route('**/api/aiops/churn-draft', r => r.fulfill({ json: { zwid: '2', name: 'Bo Dunn', subject: 'Back soon', body: 'Hi {first}' } }));
  await page.route('**/api/aiops/triage', r => r.request().method() === 'GET' ? r.fulfill({ json: { items: [{ id: 'a', kind: 'question', from: 'x@y.test', at: '2026-11-04T10:00:00Z', summary: 'Asks about racing.', suggested: 'Yes!', status: 'open' }] } }) : r.fulfill({ json: { item: {} } }));
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-aidesk').click();
  await expect(page.locator('#aidesk-content')).toContainText('AI desk');
  await page.getByRole('tab', { name: /Line-ups/ }).click();
  await page.locator('#lu-w').selectOption('2'); await page.getByRole('button', { name: 'Suggest' }).click();
  await expect(page.locator('#aidesk-content')).toContainText('Ann Lee'); expect(sent.lineup).toEqual({ team: 't1', week: 2 });   // the chosen race reaches the server
  await page.getByRole('tab', { name: /Churn radar/ }).click();
  await page.getByRole('button', { name: 'Draft a note' }).click();
  await expect(page.locator('#cd-subject')).toHaveValue('Back soon');
  await page.getByRole('tab', { name: /Replies/ }).click();
  await expect(page.locator('#aidesk-content')).toContainText('Asks about racing');
  await page.evaluate(AXE);
  const bad = await page.evaluate(async () => (await axe.run(document.getElementById('page-aidesk'), { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`));
  expect(bad).toEqual([]);
  expect(errors).toEqual([]);
});

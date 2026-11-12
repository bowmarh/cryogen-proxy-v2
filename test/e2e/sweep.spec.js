// @ts-check
// A sweep of every page: sign in as an administrator and as a rider, open each menu page, and fail on any script error, any server error (HTTP 5xx) from
// the API, or any page that shows the "could not load" style failure. This is the check that catches a page that quietly stopped working.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function sweep(page, baseURL, who) {
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push('script: ' + e.message));
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(baseURL); await page.evaluate(r => launchApp(r), who);
  const ids = await page.evaluate(() => [...document.querySelectorAll('.navbtn')].filter(b => b.offsetParent !== null || getComputedStyle(b).display !== 'none').map(b => b.id).filter(Boolean));
  expect(ids.length).toBeGreaterThan(3);
  const shown = [];
  for (const id of ids) {
    const btn = page.locator('#' + id); if (!(await btn.isVisible())) continue;
    await btn.click(); await page.waitForTimeout(350); await page.waitForLoadState('networkidle').catch(() => {}); shown.push(id);
    const active = page.locator('.page.active'); await expect(active).toHaveCount(1);
    const text = (await active.innerText()).trim(); expect(text.length, `${id} shows something`).toBeGreaterThan(5);
    expect(text, `${id} has no uncaught failure text`).not.toMatch(/undefined|\[object Object\]|NaN\b/);
  }
  expect(errors, `script errors while visiting ${shown.join(', ')}`).toEqual([]); expect(bad, 'server errors').toEqual([]);
  return shown;
}

test('an administrator can open every page without a script error or a server error', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  const shown = await sweep(page, baseURL, 'admin'); expect(shown).toEqual(expect.arrayContaining(['nav-control', 'nav-aidesk', 'nav-mail']));
});

test('a moderator can open every page they can see without a script error or a server error', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'mod', password: h.BASE_ENV.MOD_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'mod'); } }, tok);
  await sweep(page, baseURL, 'mod');
});

test('a rider can open every page without a script error or a server error', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push('script: ' + e.message)); page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 500) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.navbtn')].map(b => b.id).filter(Boolean));
  for (const id of ids) { const btn = page.locator('#' + id); if (!(await btn.isVisible())) continue; await btn.click(); await page.waitForTimeout(350); await page.waitForLoadState('networkidle').catch(() => {}); }
  expect(errors).toEqual([]); expect(bad).toEqual([]);
});

test('the public pages load: the club page, the open race page, the join form and the live board', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const p of ['/club.html', '/race.html', '/join.html', '/live.html']) { const r = await page.goto(baseURL + p); expect(r && r.status(), p).toBe(200); await page.waitForTimeout(300); }
  expect(errors).toEqual([]);
});

test('the feedback button sends what was typed with the page it was sent from; a rider who is not a captain sees no team page', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  const sent = {}; await page.route('**/api/feedback', r => { sent.body = r.request().postDataJSON(); r.fulfill({ json: { ok: true } }); });
  await expect(page.locator('#fb-btn')).toBeVisible({ timeout: 8000 }); await expect(page.locator('#nav-captain')).toBeHidden();
  await page.locator('#fb-btn').click(); await page.locator('#fb-text').fill('The buttons are not working'); await page.locator('#fb-send').click();
  await expect(page.locator('#fb-msg')).toContainText('Thank you'); expect(sent.body.text).toBe('The buttons are not working'); expect(typeof sent.body.page).toBe('string');
});

for (const who of ['owner', 'admin']) {
  test(`the ${who} sees the right level badge and the access tab; only the owner can change a member's type or see the audit trail`, async ({ page, baseURL }) => {
    const tok = (await (await page.request.post('/api/login', { data: { role: who, password: who === 'owner' ? h.BASE_ENV.OWNER_PASSWORD : h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
    await page.addInitScript(([t, owner]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); if (owner) sessionStorage.setItem('owner', '1'); } }, [tok, who === 'owner']);
    await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
    await expect(page.locator('#role-badge')).toHaveText(who === 'owner' ? 'Owner' : 'Administrator');
    await page.locator('#nav-control').click(); await page.getByRole('tab', { name: /Access/ }).click();
    await expect(page.locator('#control-content')).toContainText('Who can do what'); await expect(page.locator('#control-content')).toContainText('Backups: make, download and restore');
    await page.evaluate(() => window.controlAccessSearch && controlAccessSearch());
    await expect(page.getByRole('tab', { name: /Audit/ })).toHaveCount(who === 'owner' ? 1 : 0);
    if (who === 'owner') await expect(page.locator('#control-content select').first()).toBeVisible(); else await expect(page.locator('#control-content select')).toHaveCount(0);
  });
}

test('a rider can open My details and My plan, save an email choice, and send a change request', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  const sent = {}; await page.route('**/api/me/prefs', r => { sent.prefs = r.request().postDataJSON(); r.continue(); }); await page.route('**/api/me/request', r => { sent.req = r.request().postDataJSON(); r.continue(); });
  await page.locator('#nav-mydetails').click(); await expect(page.locator('#mydetails-content')).toContainText('Emails from the club');
  await page.locator('#md-name').fill('Ricky'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('#mydetails-content')).toContainText('Saved.'); expect(sent.prefs.preferredName).toBe('Ricky');
  await page.locator('#md-text').fill('Please change my email address'); await page.getByRole('button', { name: 'Send my change request' }).click(); await expect(page.locator('#mydetails-content')).toContainText('Sent.'); expect(sent.req).toEqual({ type: 'details', text: 'Please change my email address' });
  await page.locator('#nav-plan').click(); await expect(page.locator('#plan-content')).toContainText('Build my season plan');
  await page.locator('#pl-ftp').fill('240'); await page.locator('#pl-hours').fill('6'); await page.locator('#pl-weeks').fill('8'); await page.getByRole('button', { name: 'Build the plan' }).click(); await expect(page.locator('#plan-content')).toContainText('Week 8');
});

test('the Control room has the member requests and website tabs for the owner', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: h.BASE_ENV.OWNER_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('owner', '1'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin')); await page.locator('#nav-control').click();
  await page.getByRole('tab', { name: /Member requests/ }).click(); await expect(page.locator('#control-content')).toContainText('From My details');
  await page.getByRole('tab', { name: /Website/ }).click(); await expect(page.locator('#control-content')).toContainText('Standings on the website'); await expect(page.locator('#control-content')).toContainText('WordPress accounts for join requests'); await expect(page.locator('#sf-on')).toBeEnabled();
});

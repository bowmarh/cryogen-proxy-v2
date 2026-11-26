// @ts-check
// A visitor who is not signed in, and staff (who have no race results of their own), do not make requests that can only be refused.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');
h.setEnv();

test('a signed-out visitor makes no member-only requests and sees no refused calls', async ({ page, baseURL }) => {
  const asked = [], refused = [];
  page.on('request', r => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/')) asked.push(p); });
  page.on('response', r => { if (r.status() === 401 && new URL(r.url()).pathname.startsWith('/api/')) refused.push(new URL(r.url()).pathname); });
  await page.goto(baseURL); await page.waitForTimeout(4000);
  expect(asked.filter(p => p === '/api/me/results' || p === '/api/results/leaderboard')).toEqual([]);
  expect(refused).toEqual([]);
});

test('staff do not ask for member race results either', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(([t]) => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); localStorage.setItem('cg:whatsnew:seen', '9999-01-01'); } }, [tok]);
  const asked = [];
  page.on('request', r => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/')) asked.push(p); });
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin')); await page.waitForTimeout(4000);
  expect(asked.filter(p => p === '/api/me/results')).toEqual([]);
});

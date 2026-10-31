'use strict';

const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function signInAsRider(page, baseURL) {
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('a verified member can sign up for TTT in the browser', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.getByRole('button', { name: /TTT Week/ }).click();
  await expect(page.locator('#ttt-root')).toContainText('Sign up for this week');
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
  await expect(page.locator('#ttt-root')).toContainText('Rider 2');

  const response = await page.request.get('/api/ttt');
  const ttt = await response.json();
  expect(response.ok()).toBeTruthy();
  expect(ttt.signups.some(signup => signup.zwid === '1002')).toBeTruthy();
});

test('a member can create a private calendar link and subscribe to its feed', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  await page.getByRole('button', { name: /My Profile/ }).click();
  await page.getByRole('button', { name: 'Create my calendar link' }).click();
  await expect(page.locator('.cal-slot')).toContainText('Your calendar link is ready');

  const url = await page.locator('.cal-slot input[readonly]').inputValue();
  const response = await page.request.get(url);
  const body = await response.text();
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/calendar');
  expect(body).toContain('BEGIN:VCALENDAR');
  expect(body).toContain('END:VCALENDAR');
});

test('calendar settings errors are visible and can be retried', async ({ page, baseURL }) => {
  await signInAsRider(page, baseURL);
  let failRequest = true;
  await page.route('**/api/me/calendar', route => {
    if (failRequest && route.request().method() === 'GET') {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'calendar storage unavailable' }),
      });
    }
    return route.continue();
  });

  await page.getByRole('button', { name: /My Profile/ }).click();
  await expect(page.locator('.cal-slot')).toContainText('calendar storage unavailable');
  failRequest = false;
  await page.locator('.cal-slot').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.cal-slot')).toContainText(/Create my calendar link|Your calendar link is ready/);
});

test('member search reports roster failures instead of showing sample riders', async ({ page, baseURL }) => {
  await page.route('**/api/auth/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sso: false, requireLogin: false }),
  }));
  await page.route('**/api/roster', route => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'roster source unavailable' }),
  }));
  await page.goto(baseURL);
  await page.getByRole('button', { name: /Member/ }).click();
  await page.locator('#member-search').fill('Rick');
  await page.getByRole('button', { name: 'Find My Profile' }).click();
  await expect(page.locator('#login-err')).toContainText('roster source unavailable');
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#member-results')).not.toContainText('Rick');
});

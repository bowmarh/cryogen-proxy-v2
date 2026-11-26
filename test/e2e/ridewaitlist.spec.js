'use strict';
// Social rides: a full ride shows who is going and who is waiting, and "My rides" shows a rider's place on the waitlist.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function signInAsRider(page, baseURL) {
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('a full ride splits going from waiting, and My rides shows my place on the waitlist', async ({ page, baseURL }) => {
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const ride = { id: '900', title: 'Waitlist loop', date, time: '09:00', route: 'Watopia', dist: '40 km', pace: '2.5 w/kg', desc: '', max: 2, cat: 'All', link: '' };
  const rsvps = ['Ann', 'Bo', 'Rider Two', 'Di'].map((name, i) => ({ name, ts: `2026-01-01T10:0${i}:00.000Z` }));
  await page.route('**/api/state', route => route.fulfill({ json: { signups: {}, locks: {}, rides: [ride], rsvps: { 900: rsvps } } }));
  await signInAsRider(page, baseURL);
  await page.getByRole('button', { name: /Social Rides/ }).first().click();
  await page.getByRole('button', { name: /RSVP rides/ }).click();

  const list = page.locator('#rides-list');
  await expect(list).toContainText('Waitlist loop');
  await expect(list).toContainText('👥 2/2 · ⏳ 2 waiting');
  await expect(list.getByText('Full', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: /⏳ 1\. Rider Two/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /⏳ 2\. Di/ })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Ann' })).toBeVisible();          // going riders keep their plain chips
  await expect(list.getByRole('button', { name: /Join Waitlist/ })).toBeVisible();
  await page.getByRole('button', { name: /My Profile/ }).first().click();   // "My rides" lives on the profile page
  await expect(page.locator('#my-rides')).toContainText('Waitlist loop');
  await expect(page.locator('#my-rides')).toContainText('#1 on the waitlist');
});

test('a ride with room shows no waitlist wording', async ({ page, baseURL }) => {
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const ride = { id: '901', title: 'Roomy ride', date, time: '09:00', route: '', dist: '', pace: '', desc: '', max: 10, cat: 'All', link: '' };
  await page.route('**/api/state', route => route.fulfill({ json: { signups: {}, locks: {}, rides: [ride], rsvps: { 901: [{ name: 'Ann', ts: '2026-01-01T10:00:00.000Z' }] } } }));
  await signInAsRider(page, baseURL);
  await page.getByRole('button', { name: /Social Rides/ }).first().click();
  await page.getByRole('button', { name: /RSVP rides/ }).click();
  const list = page.locator('#rides-list');
  await expect(list).toContainText('👥 1/10');
  await expect(list).not.toContainText('waiting');
  await expect(list).not.toContainText('⏳');
  await expect(list.getByRole('button', { name: /RSVP/ })).toBeVisible();
});

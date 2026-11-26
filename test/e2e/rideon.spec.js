'use strict';
// 💪 Ride On card on the Social Rides page: lists recent rides you rode, lets you cheer a rider and take it back.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();

async function openRsvpList(page, baseURL) {
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Social Rides/ }).first().click();
  await page.getByRole('button', { name: /RSVP rides/ }).click();
}
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('a member sees the rides they rode, cheers a rider, sees the count, and takes it back', async ({ page, baseURL }) => {
  const posts = [];
  await page.route('**/api/state', r => r.fulfill({ json: { signups: {}, locks: {}, rides: [], rsvps: {} } }));
  await page.route('**/api/rides/rideon', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { received: 3, rides: { 900: { title: 'Sunday social', date: day(-2), time: '', riders: [{ name: 'Ann Lee', n: 2, mine: false }, { name: 'Bo <b>x</b>', n: 0, mine: true }] } } } });
    }
    const body = route.request().postDataJSON(); posts.push(body);
    return route.fulfill({ json: body.name === 'Ann Lee' ? { n: 3, mine: true } : { n: 0, mine: false } });
  });
  await openRsvpList(page, baseURL);

  const card = page.locator('#rideon-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('💪 Ride On');
  await expect(card).toContainText('You got 3 Ride Ons');
  await expect(card).toContainText('Sunday social');
  const ann = card.getByRole('button', { name: /Ann Lee/ });
  await expect(ann).toContainText('· 2');
  await expect(ann).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('b')).toHaveCount(1);   // only the heading's counts; "<b>x</b>" in a rider's name is shown as text, not markup
  await expect(card).toContainText('Bo <b>x</b>');

  await ann.click();
  await expect(ann).toHaveAttribute('aria-pressed', 'true');
  await expect(ann).toContainText('· 3');
  expect(posts[0]).toEqual({ rideId: '900', name: 'Ann Lee' });

  const bo = card.getByRole('button', { name: /Bo/ });
  await expect(bo).toHaveAttribute('aria-pressed', 'true');   // one I gave earlier
  await bo.click();
  await expect(bo).toHaveAttribute('aria-pressed', 'false');
  expect(posts[1]).toEqual({ rideId: '900', name: 'Bo <b>x</b>' });
});

test('with no rides to cheer on, there is no Ride On card', async ({ page, baseURL }) => {
  await page.route('**/api/state', r => r.fulfill({ json: { signups: {}, locks: {}, rides: [], rsvps: {} } }));
  await page.route('**/api/rides/rideon', route => route.fulfill({ json: { received: 0, rides: {} } }));
  await openRsvpList(page, baseURL);
  await expect(page.locator('#rides-list')).toBeAttached();
  await expect(page.locator('#rideon-card')).toHaveCount(0);
});

test('a refused Ride On tells the member why and leaves the button as it was', async ({ page, baseURL }) => {
  await page.route('**/api/state', r => r.fulfill({ json: { signups: {}, locks: {}, rides: [], rsvps: {} } }));
  await page.route('**/api/rides/rideon', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { received: 0, rides: { 901: { title: 'Old ride', date: day(-1), time: '', riders: [{ name: 'Cy', n: 0, mine: false }] } } } })
    : route.fulfill({ status: 429, json: { error: 'You have used all 10 Ride Ons for this ride.' } }));
  await openRsvpList(page, baseURL);
  const cy = page.locator('#rideon-card').getByRole('button', { name: /Cy/ });
  const dialog = page.waitForEvent('dialog');
  await cy.click();
  expect((await dialog).message()).toContain('all 10 Ride Ons');
  await (await dialog).dismiss();
  await expect(cy).toHaveAttribute('aria-pressed', 'false');
  await expect(cy).toBeEnabled();
});

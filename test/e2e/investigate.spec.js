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
  const base = { enabled: true, tier: 'free', period: 'this week', limit: 3, ridesLeft: 1, supporterDaily: 15, payUrl: 'https://ko-fi.com/cryogen', price: 3, transparency: { month: '2026-10', cost: 14.2, supporters: 5, monthly: 15 } };
  await page.route('**/api/coach/status', r => r.fulfill({ json: { ...base, consent, remaining: 3 } }));
  await page.route('**/api/coach/consent', r => { consent = JSON.parse(r.request().postData()).on; r.fulfill({ json: { ...base, consent, remaining: 3 } }); });
  await page.route('**/api/coach/chat', r => r.fulfill({ json: { ...base, consent: true, reply: 'Plan:\n\n- Tue: 2 x 20 min at 90% FTP\n- Thu: 60 min easy', remaining: 2 } }));
  await page.route('**/api/coach/ride', r => r.fulfill({ json: { ...base, consent: true, ridesLeft: 0, reply: 'You started a little hard.', remaining: 1, ride: { minutes: 30, avgPower: 230, normalizedPower: 240, variabilityIndex: 1.04, bestWatts: { '1200s': 250 }, heartRate: { avg: 140, decouplingPercent: 3.2 }, minutesInZones: { 'Z2 endurance': 20, 'Z4 threshold': 10 } } } }));
  const ticket = h.ssoToken({ zwid: '1002', name: 'Rider Two' });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(ticket)}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.locator('#nav-coach').click();
  await expect(page.locator('#coach-content')).toContainText('Before you start');
  await expect(page.locator('#coach-content')).toContainText('never gets your name, your weight');
  await page.getByRole('button', { name: 'Yes, coach me' }).click();
  await page.getByRole('button', { name: 'Plan my week' }).click();
  await expect(page.locator('#coach-content li', { hasText: '2 x 20 min at 90% FTP' })).toBeVisible();
  await expect(page.locator('#coach-content')).toContainText('2 of 3 questions left this week');
  await expect(page.locator('#coach-content')).toContainText('about £14.2');
  await page.locator('#coach-content summary', { hasText: 'Keep the coach going' }).click();
  await expect(page.getByRole('link', { name: /Become a supporter · £3 a month/ })).toHaveAttribute('href', 'https://ko-fi.com/cryogen');
  await page.locator('#coach-content input[type=file]').setInputFiles({ name: 'ride.fit', mimeType: 'application/octet-stream', buffer: ride({ flat: false }) });
  await expect(page.locator('#coach-content')).toContainText('You started a little hard.');
  await expect(page.locator('#coach-content')).toContainText('Minutes in zones');
  await expect(page.locator('#coach-content input[type=file]')).toBeDisabled();   // the free ride explanation for the month is used
  await page.getByRole('link', { name: 'Stop using my numbers' }).click();
  await expect(page.locator('#coach-content')).toContainText('Before you start');
});

test('the admin sees supporters and the AI cost, and can add a supporter', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await page.evaluate(() => openAdmin());
  await expect(page.locator('#support-card')).toContainText('This month');
  await expect(page.locator('#support-card')).toContainText('No supporters yet');
  await page.locator('#sp-rider').fill('Rider 2 (1002)');
  await page.locator('#support-card button', { hasText: 'Add' }).click();
  await expect(page.locator('#support-card')).toContainText('⭐ Rider 2');
});

test('the coach page: ask about the club, the weekly plan for supporters, the season story and the race debrief', async ({ page, baseURL }) => {
  const base = { enabled: true, tier: 'supporter', period: 'today', limit: 15, remaining: 15, ridesLeft: null, supporterDaily: 15, payUrl: '', price: 3, transparency: null, consent: true };
  const paths = [];
  await page.route('**/api/coach/status', r => r.fulfill({ json: base }));
  await page.route('**/api/plan', r => r.fulfill({ json: { optIn: false, supporter: true, consent: true, enabled: true, last: { week: '2026-11-02', text: 'Tue: 60 min at 70% FTP\nThu: 2 x 15 min at 90%' } } }));
  await page.route('**/api/plan/optin', r => r.fulfill({ json: { optIn: JSON.parse(r.request().postData()).on } }));
  await page.route('**/api/coach/club', r => { paths.push('club'); r.fulfill({ json: { ...base, remaining: 14, reply: 'Alpha lead Division 1.' } }); });
  await page.route('**/api/coach/story', r => { paths.push('story'); r.fulfill({ json: { ...base, remaining: 13, reply: 'This year I raced a lot.' } }); });
  await page.route('**/api/coach/ride', r => { paths.push('ride:' + JSON.parse(r.request().postData()).mode); r.fulfill({ json: { ...base, remaining: 12, reply: 'You won it on the surges.', ride: { minutes: 30, avgPower: 230, normalizedPower: 240, variabilityIndex: 1.04, bestWatts: { '1200s': 250 }, heartRate: { avg: 140, decouplingPercent: 3.2 }, minutesInZones: null } } }); });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.locator('#nav-coach').click();
  await expect(page.locator('#coach-content')).toContainText('Send me a weekly plan on Mondays');
  await expect(page.locator('#coach-content')).toContainText('Tue: 60 min at 70% FTP');
  await page.getByRole('checkbox', { name: /weekly plan/ }).check();
  await page.getByLabel('Who to ask').selectOption('club');
  await page.getByRole('button', { name: 'How are our teams doing?' }).click();
  await expect(page.locator('#coach-content')).toContainText('Alpha lead Division 1.');
  await page.getByRole('button', { name: /My season story/ }).click();
  await expect(page.locator('#coach-content')).toContainText('This year I raced a lot.');
  await page.getByLabel('Race debrief').check().catch(async () => { await page.getByText('Race debrief').click(); });
  await page.locator('#coach-content input[type=file]').setInputFiles({ name: 'race.fit', mimeType: 'application/octet-stream', buffer: ride({ flat: false }) });
  await expect(page.locator('#coach-content')).toContainText('You won it on the surges.');
  expect(paths).toEqual(['club', 'story', 'ride:debrief']);
});

test('staff see the weekly report, the quiet riders with a draft button, and the club story on This week', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.route('**/api/ai/report', r => r.request().method() === 'GET' ? r.fulfill({ json: { aiOn: true, report: { at: '2026-11-02T08:00:00Z', by: 'automatic', via: 'ai', text: 'A steady week. To do: place two riders.' } } }) : r.fulfill({ json: { report: { at: '2026-11-02T09:00:00Z', by: 'staff', via: 'ai', text: 'A fresh report.' } } }));
  await page.route('**/api/ai/drift', r => r.request().method() === 'GET' ? r.fulfill({ json: { aiOn: true, quiet: [{ zwid: '77', name: 'Dee Dawson', days: 70, tier: 'full' }] } }) : r.fulfill({ json: { draft: 'Hi Dee, we have missed you!' } }));
  await page.route('**/api/ai/club-story', r => r.fulfill({ json: { text: 'Our season so far…' } }));
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  await expect(page.locator('#staff-ai')).toContainText('A steady week');
  await expect(page.locator('#staff-ai')).toContainText('Dee Dawson');
  await page.getByRole('button', { name: 'Draft a message' }).click();
  await expect(page.locator('#staff-ai textarea')).toHaveValue('Hi Dee, we have missed you!');
  await page.getByRole('button', { name: 'Write it now' }).click();
  await expect(page.locator('#staff-ai')).toContainText('A fresh report.');
  await page.getByRole('button', { name: /Write the story/ }).click();
  await expect(page.locator('#staff-ai textarea[aria-label="The club story"]')).toHaveValue('Our season so far…');
});

test('a rider chooses whether to be featured, and the studio lets staff read, change and approve a post and copy the hand-posted ones', async ({ page, baseURL }) => {
  let on = false, saved = null;
  const post = { id: 'p1', kind: 'manual', headline: 'Sunday social ride', status: 'pending', createdAt: '2026-11-01T09:00:00Z', via: 'ai', named: [], imageId: '', results: {}, channels: [],
    variants: { discord: 'Social ride Sunday 9am! All welcome.', telegram: 'T', bluesky: 'B', facebook: 'F', instagram: 'I', hook: 'H', whatsapp: 'Social ride Sunday 9am, all welcome', strava: 'S', website: { title: 'Sunday social ride', body: 'Come along.' }, email: { subject: 'Sunday social ride', body: 'Come along.' } } };
  const channels = ['discord', 'website', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), type: 'app', configured: id !== 'instagram', enabled: id !== 'instagram' })).concat([{ id: 'whatsapp', label: 'WhatsApp', type: 'manual', configured: true, enabled: true }, { id: 'strava', label: 'Strava', type: 'manual', configured: true, enabled: true }, { id: 'email', label: 'Email', type: 'manual', configured: false, enabled: true }]);
  await page.route('**/api/studio/feature', r => { if (r.request().method() === 'POST') on = JSON.parse(r.request().postData()).on; r.fulfill({ json: { on } }); });
  await page.route('**/api/studio', r => r.fulfill({ json: { posts: [post], channels, settings: { paused: false, voice: 'v', hashtags: '#x', websiteStatus: 'draft', dailyLimit: 3, autoKinds: [], disabled: [], stravaUrl: 'https://www.strava.com/clubs/1' }, aiOn: true, kinds: [{ id: 'week_ahead', label: 'This week' }], stravaUrl: 'https://www.strava.com/clubs/1' } }));
  await page.route('**/api/studio/edit', r => { saved = JSON.parse(r.request().postData()); r.fulfill({ json: { post } }); });
  await page.route('**/api/studio/approve', r => { saved = { ...saved, approve: JSON.parse(r.request().postData()) }; r.fulfill({ json: { post: { ...post, status: 'posted', results: { discord: { ok: true }, telegram: { ok: false, error: 'chat not found' } } } } }); });
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /My Profile/ }).click();
  await expect(page.locator('#prof-feature')).toContainText('OK to feature me by name');
  await expect(page.locator('#prof-feature input')).not.toBeChecked();
  await page.locator('#prof-feature input').check();
  await expect.poll(() => on).toBe(true);
  // Staff view.
  const tok = (await (await page.request.post('/api/login', { data: { role: 'admin', password: h.BASE_ENV.ADMIN_PASSWORD } })).json()).token;
  await page.evaluate(t => { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); }, tok);
  await page.reload(); await page.evaluate(() => launchApp('admin'));
  await page.locator('#nav-studio').click();
  await expect(page.locator('#studio-content')).toContainText('Sunday social ride');
  await expect(page.locator('#studio-content')).toContainText('written by AI');
  await expect(page.locator('#studio-content')).toContainText('Instagram (not set up)');
  await expect(page.locator('#studio-content')).toContainText('no riders named');
  await page.locator('#studio-content summary', { hasText: 'Read and change the wording' }).click();
  await page.locator('textarea[data-c="telegram"]').fill('Telegram version');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: /Approve and post/ }).click();
  await expect(page.locator('#studio-content')).toContainText('✓ Discord'); await expect(page.locator('#studio-content')).toContainText('✗ Telegram: chat not found');
  expect(saved.variants.telegram).toBe('Telegram version'); expect(saved.approve.channels).toEqual(['discord', 'website', 'telegram', 'bluesky', 'hook']);
  expect(await page.locator('a', { hasText: 'Open WhatsApp' }).getAttribute('href')).toContain('https://wa.me/?text=Social%20ride%20Sunday');
  await expect(page.getByRole('link', { name: 'Open the Strava club' })).toHaveAttribute('href', 'https://www.strava.com/clubs/1');
});

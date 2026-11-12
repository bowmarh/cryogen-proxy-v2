// @ts-check
// Phone-size check: every page, for an owner and for a rider, at 390 x 844. A page must not need sideways scrolling, and nothing may spill past the right edge.
const { test, expect } = require('@playwright/test');
const h = require('../helpers');

h.setEnv();
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function overflowing(page) {
  // The width is the phone's own (390), not window.innerWidth: a phone browser widens its layout to fit wide content, which would hide the problem.
  return page.evaluate(vw => {
    const active = document.querySelector('.page.active') || document.body, bad = [];
    if (document.documentElement.scrollWidth > vw + 1) bad.push(`the page is ${document.documentElement.scrollWidth}px wide`);
    for (const el of active.querySelectorAll('*')) {
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) {   // allowed: inside something that scrolls on purpose
        let p = el.parentElement, scrolls = false; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (['auto', 'scroll', 'hidden'].includes(o)) { scrolls = true; break; } p = p.parentElement; }
        if (!scrolls) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} ends at ${Math.round(r.right)}px`);
      }
    }
    return [...new Set(bad)].slice(0, 6);
  }, page.viewportSize().width);
}
async function visitAll(page, label) {
  const ids = await page.evaluate(() => [...document.querySelectorAll('.navbtn')].map(b => b.id).filter(Boolean)), problems = [];
  for (const id of ids) {
    const btn = page.locator('#' + id); if (!(await btn.isVisible().catch(() => false))) continue;
    await page.evaluate(i => { const b = document.getElementById(i); if (b) b.click(); }, id); await page.waitForTimeout(400); await page.waitForLoadState('networkidle').catch(() => {});
    const bad = await overflowing(page); if (bad.length) problems.push(`${label} ${id}: ${bad.join('; ')}`);
  }
  return problems;
}

test('every owner page fits a phone without sideways scrolling', async ({ page, baseURL }) => {
  const tok = (await (await page.request.post('/api/login', { data: { role: 'owner', password: h.BASE_ENV.OWNER_PASSWORD } })).json()).token;
  await page.addInitScript(t => { if (location.origin.startsWith('http://127.0.0.1')) { sessionStorage.setItem('token', t); sessionStorage.setItem('role', 'admin'); sessionStorage.setItem('owner', '1'); } }, tok);
  await page.goto(baseURL); await page.evaluate(() => launchApp('admin'));
  const problems = await visitAll(page, 'owner');
  // The Control room has its own tabs: open each.
  await page.evaluate(() => document.getElementById('nav-control').click());
  for (const name of ['Launch', 'Engagement', 'Go-live check', 'Usage', 'Member requests', 'Website', 'Access', 'Results', 'Feedback', 'Audit', 'Join requests']) {
    const tab = page.getByRole('tab', { name: new RegExp(name) }); if (!(await tab.count())) continue; await tab.first().click(); await page.waitForTimeout(500);
    const bad = await overflowing(page); if (bad.length) problems.push(`control ${name}: ${bad.join('; ')}`);
  }
  for (const [nav, tabs] of [['nav-mail', ['Sent', 'Groups', 'Settings']], ['nav-aidesk', ['Line-ups', 'Ask the club', 'Churn radar', 'Replies']]]) {
    await page.evaluate(i => document.getElementById(i).click(), nav);
    for (const name of tabs) { const tab = page.getByRole('tab', { name: new RegExp(name) }); if (!(await tab.count())) continue; await tab.first().click(); await page.waitForTimeout(400); const bad = await overflowing(page); if (bad.length) problems.push(`${nav} ${name}: ${bad.join('; ')}`); }
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('every rider page fits a phone without sideways scrolling', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/api/auth/wp?t=${encodeURIComponent(h.ssoToken({ zwid: '1002', name: 'Rider Two' }))}`);
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  const problems = await visitAll(page, 'rider'); expect(problems, problems.join('\n')).toEqual([]);
});

test('the public pages fit a phone', async ({ page, baseURL }) => {
  const problems = [];
  for (const p of ['/club.html', '/race.html', '/join.html', '/live.html']) { await page.goto(baseURL + p); await page.waitForTimeout(400); const wide = await page.evaluate(() => document.documentElement.scrollWidth); if (wide > 391) problems.push(`${p}: ${wide}px wide`); }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the overflow check itself catches a page that is too wide (so a pass means something)', async ({ page, baseURL }) => {
  await page.goto(baseURL + '/race.html');
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'too-wide'; d.style.cssText = 'width:700px;height:20px;background:red'; document.body.appendChild(d); });
  expect(await overflowing(page)).toEqual(expect.arrayContaining([expect.stringMatching(/too-wide ends at 7\d\dpx|the page is 7\d\dpx wide/)]));
});

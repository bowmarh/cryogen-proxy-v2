'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());

// Like the club's real sheet: other tabs come first, TEAM LIST is not the first tab.
const WELCOME = { cols: ['Intro'], rows: [['hello']] };
const setTab = tab => { world.sheet = { first: 'Welcome', tabs: { Welcome: WELCOME, 'TEAM LIST': tab }, html: false }; };
const fetchSheet = () => app.get('/api/proxy?endpoint=ttt-sheet');

test('the public sheet data drops emails, gender and free-text columns', async () => {
  setTab({
    cols: ['Name', 'Gender', 'Team', 'Comments', 'Notes', 'E-mail', 'Contact', 'Zwift ID'],
    rows: [['Alice', 'F', 'Hawks', 'private words', 'note', 'a@b.com', 'ring a@b.com', '1'], ['Bob', 'M', 'Owls', '', '', 'bob@x.org', 'text me', '2']],
  });
  const r = await fetchSheet();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.headers, ['Name', 'Team', 'Zwift ID']);
  assert.deepEqual(r.body.rows, [{ Name: 'Alice', Team: 'Hawks', 'Zwift ID': '1' }, { Name: 'Bob', Team: 'Owls', 'Zwift ID': '2' }]);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('@'), 'no email-looking text anywhere');
  assert.ok(!/private words|Gender/i.test(text));
});

test('a laid-out sheet (title rows, blocks to the right) is read from its leftmost block', async () => {
  const blank = ['', '', '', '', ''];
  setTab({
    cols: ['', '', '', '', ''],
    rows: [
      ['TEAM LIST', '', '', '', 'other block'],
      blank,
      ['Cat', 'Name', 'Zwift ID', '', 'x'],
      ['B', 'Alice', '1', '', 'y'],
      ['C', 'Bob', '2', '', ''],
    ],
  });
  const r = await fetchSheet();
  assert.deepEqual(r.body.headers, ['Cat', 'Name', 'Zwift ID']);
  assert.deepEqual(r.body.rows.map(x => x.Name), ['Alice', 'Bob']);
});

test('a tab name that does not exist is reported, not silently replaced by the first tab', async () => {
  world.sheet = { first: 'Other', tabs: { Other: { cols: ['A'], rows: [['1']] } }, html: false };
  const r = await fetchSheet();
  assert.equal(r.status, 404);
  assert.match(r.body.error, /no tab named "TEAM LIST"/);
});

test('a sheet that is not shared publicly says so', async () => {
  world.sheet = { ...world.sheet, html: true };
  const r = await fetchSheet();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /not shared publicly/);
});

test('only the named tabs can be requested, so the proxy cannot fetch arbitrary URLs', async () => {
  assert.equal((await app.get('/api/proxy?endpoint=http://evil.example/x')).status, 400);
  assert.equal((await app.get('/api/proxy?endpoint=__proto__')).status, 400);
  assert.equal((await app.get('/api/proxy')).status, 400);
});

test('known limitation: if TEAM LIST were the first tab of the sheet it would be mistaken for a missing tab', async () => {
  // Google returns the first tab for an unknown name, so the check cannot tell the two apart.
  world.sheet = { first: 'TEAM LIST', tabs: { 'TEAM LIST': { cols: ['Name'], rows: [['Alice']] } }, html: false };
  assert.equal((await fetchSheet()).status, 404);
});

test('a slow Google fails fast with a clear message, then recovers', async () => {
  process.env.SHEET_TIMEOUT_MS = '200';
  setTab({ cols: ['Name'], rows: [['Alice']] });
  world.sheet.hang = true;
  try {
    const started = Date.now();
    const r = await fetchSheet();
    assert.equal(r.status, 504);
    assert.match(r.body.error, /did not answer in time/);
    assert.ok(Date.now() - started < 3000, 'it did not hang');
    world.sheet.hang = false;
    assert.equal((await fetchSheet()).status, 200, 'the next request works');
  } finally { delete process.env.SHEET_TIMEOUT_MS; world.sheet.hang = false; }
});

test('Google being unreachable is reported plainly', async () => {
  setTab({ cols: ['Name'], rows: [['Alice']] });
  world.sheet.fail = true;
  try {
    const r = await fetchSheet();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /could not be reached/);
  } finally { world.sheet.fail = false; }
});

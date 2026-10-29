'use strict';

const h = require('../helpers');
const host = '127.0.0.1';
const port = 4173;

h.setEnv({
  REQUIRE_MEMBER_LOGIN: '1',
  SITE_URL: `http://${host}:${port}`,
});

(async () => {
  const app = await h.startApp(h.createWorld(), { host, port });
  const admin = await app.login('admin');
  const week = await app.post('/api/ttt/new-week', { date: h.ymd(3) }, { token: admin });
  if (week.status !== 200) throw new Error(`Could not seed the TTT week: ${week.status}`);
  console.log(`Playwright test server listening on ${app.base}`);

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

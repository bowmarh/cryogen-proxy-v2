'use strict';
// Staging copy: a second deployment with its own database and a test Discord server, switched on with STAGING=1.
// It shows a banner, tags every Discord post, and can fill itself with made-up riders so the automation can be tried without touching the real club.
module.exports = function createStaging({ requireRole, zrl, asStaff, enabled = () => process.env.STAGING === '1' }) {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

  async function seed() {
    const req = asStaff();
    const round = await zrl.routes['POST /api/zrl/round'](req, { name: 'Test round', start: day(7), closes: day(3), weeks: 6 })
      .catch(e => { if (e && e.status === 409) return null; throw e; });
    if (round === null) return { created: false, message: 'A test round already exists. Clear the staging database to start again.' };
    await zrl.routes['POST /api/zrl/teams'](req, { teams: [
      { name: 'Test Alpha', region: 'eu', grade: 'Open B', league: 'Purple' },
      { name: 'Test Beta', region: 'eu', grade: 'C' },
    ] });
    for (let i = 1; i <= 10; i++) {
      await zrl.routes['POST /api/zrl/signup']({ headers: {} }, { name: `Test Rider ${i}`, zwid: String(9000 + i), regions: ['eu'], cat: i <= 5 ? 'B' : 'C', captain: i === 1 });
    }
    return { created: true, message: 'Made a test round with 2 teams and 10 made-up riders.' };
  }

  const routes = {
    'POST /api/staging/seed': async req => {
      requireRole(req, ['admin']);
      if (!enabled()) return { created: false, message: 'This is not a staging copy (STAGING=1 is not set), so nothing was added.' };
      return seed();
    },
  };
  return { routes, enabled, seed };
};

'use strict';
// Leaving the club in one action. An administrator previews, then presses once: the member record in WordPress is set to "left", every club email stops,
// and a list shows where the rider still appears so nothing is forgotten. It never deletes results, line-ups or history (that is the separate privacy erase),
// and it cannot remove a Discord role (the app has no such permission): that line is shown as the one step left for a person.
module.exports = function createOffboard({ HttpError, requireRole, setMemberStatus, mail = null, privacy = null, discord = async () => false, siteUrl = '' }) {
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  async function run(zwid, name, preview) {
    const steps = [];
    const step = async (what, fn, previewText) => {
      if (preview) { steps.push({ step: what, ok: true, detail: previewText, planned: true }); return; }
      try { steps.push({ step: what, ok: true, detail: (await fn()) || 'done' }); } catch (e) { steps.push({ step: what, ok: false, detail: e.message || 'failed' }); }
    };
    await step('Member record in WordPress set to "left"', async () => { await setMemberStatus(zwid, 'left'); return 'WordPress now says left'; }, 'Will set the member record to left');
    await step('Stop every club email', async () => { if (!mail) return 'email is off'; try { await mail.setPrefs(zwid, 'all'); return 'no more club or service email'; } catch (e) { if (e.status === 404) return 'no address on file, nothing to stop'; throw e; } }, 'Will stop all club email to them');
    let where = []; if (privacy) { try { where = (await privacy.collect(zwid, name)).stores.map(s => ({ label: s.label, count: s.count })); } catch (e) { where = []; } }
    steps.push({ step: 'Discord role', ok: true, manual: true, detail: 'Remove their club role in Discord yourself: the app cannot do this.' });
    if (!preview && steps.every(s => s.ok)) await discord('admin', { content: `👋 ${name || 'A member'} (Zwift ID ${zwid}) was marked as left. WordPress and email are done; remove their Discord role. ${siteUrl}` }).catch(() => {});
    return { preview, steps, stillAppearsIn: where, ok: steps.every(s => s.ok) };
  }
  const routes = {
    'POST /api/offboard': async (req, body) => {
      requireRole(req, ['admin']); const z = clean(body.zwid, 10); if (!/^\d{1,10}$/.test(z)) throw new HttpError(400, 'Enter the rider\'s Zwift ID (numbers only).');
      return run(z, clean(body.name, 80), body.preview !== false);
    },
  };
  return { routes, run };
};

'use strict';
// The go-live checklist: what is switched on, what is half set up and what would make a real race week smoother, in one list with the next step for each.
// It only reads (environment names, counts and the health checks); it never shows a key or a secret.
module.exports = function createGoLive({ requireRole, gather }) {
  const item = (id, title, state, detail, how) => ({ id, title, state, detail, how: how || '' });   // state: ok, todo (needed), off (optional, not switched on)

  function build(c) {
    const out = [];
    out.push(c.redis ? item('db', 'The database answers', 'ok', 'Everything is saved.') : item('db', 'The database answers', 'todo', 'The app cannot reach its database.', 'Check the Upstash integration in Vercel.'));
    out.push(c.cron === 'ok' ? item('cron', 'Scheduled runs are happening', 'ok', c.cronDetail) : item('cron', 'Scheduled runs are happening', 'todo', c.cronDetail, 'The GitHub workflow "TTT schedule" needs the CRON_SECRET repository secret.'));
    out.push(c.backup === 'ok' ? item('backup', 'Daily backups, and the weekly restore test', 'ok', c.backupDetail) : item('backup', 'Daily backups, and the weekly restore test', 'todo', c.backupDetail, 'Admin → Backups → Back up now, then Test restore.'));
    out.push(c.env.ZWIFTRACING_API_KEY ? item('zr', 'ZwiftRacing.app key (results, categories)', 'ok', 'Set.') : item('zr', 'ZwiftRacing.app key (results, categories)', 'todo', 'Not set: result import and the category check cannot work.', 'Add ZWIFTRACING_API_KEY in Vercel.'));
    out.push(c.env.DISCORD_WEBHOOK_PUBLIC && c.env.DISCORD_WEBHOOK_ADMIN ? item('channels', 'Discord channels (club and admin)', 'ok', 'Both are set.') : item('channels', 'Discord channels (club and admin)', 'todo', `${c.env.DISCORD_WEBHOOK_PUBLIC ? '' : 'The club channel is not set. '}${c.env.DISCORD_WEBHOOK_ADMIN ? '' : 'The admin channel is not set.'}`.trim(), 'Add DISCORD_WEBHOOK_PUBLIC and DISCORD_WEBHOOK_ADMIN in Vercel.'));
    out.push(c.env.DISCORD_BOT_TOKEN ? item('bot', 'Discord bot (direct messages)', 'ok', `${c.verified} of ${c.members} active members have a verified Discord link.`) : item('bot', 'Discord bot (direct messages)', 'off', 'Not set up: reminders go to the channel, not to people.', 'Add DISCORD_BOT_TOKEN, then ask members to link Discord in My Profile (or import their IDs in Comms).'));
    out.push(c.env.DISCORD_PUBLIC_KEY ? item('buttons', 'Discord buttons (Yes / Maybe / No)', 'ok', 'The public key is set. Check the portal accepted the Interactions Endpoint URL.') : item('buttons', 'Discord buttons (Yes / Maybe / No)', 'off', 'Not switched on.', 'Add DISCORD_PUBLIC_KEY in Vercel, redeploy, then set the Interactions Endpoint URL in the Discord portal.'));
    out.push(c.push.configured ? item('push', 'Push notifications', 'ok', `${c.push.devices} device${c.push.devices === 1 ? '' : 's'} registered.`) : item('push', 'Push notifications', 'off', 'Not switched on.', 'Admin → Staff accounts → Make push keys, add them in Vercel, redeploy.'));
    out.push(c.auto ? item('auto', 'Automatic messages', 'ok', 'On: reminders, replacements and roles are sent without anyone pressing a button.') : item('auto', 'Automatic messages', 'off', 'Off: nothing is sent to riders automatically.', 'Comms → turn on the automatic reminder (needs the bot or push).'));
    const reach = c.members ? Math.round(c.reachable / c.members * 100) : 0;
    out.push(reach >= 70 ? item('reach', 'Riders who can be reached directly', 'ok', `${reach}% of active members have a verified Discord link or a notification device.`) : item('reach', 'Riders who can be reached directly', 'todo', `${reach}% of active members (${c.reachable} of ${c.members}) can be messaged directly.`, 'Ask members to link Discord or turn on notifications in My Profile; Comms has a ready-made "add your Discord ID" message.'));
    out.push(c.staffAccounts > 0 ? item('staff', 'Personal staff accounts', 'ok', `${c.staffAccounts} account${c.staffAccounts === 1 ? '' : 's'}; the shared passwords still work.`) : item('staff', 'Personal staff accounts', 'todo', 'Everyone shares the role passwords, so the change log cannot say who did what.', 'Admin → Staff accounts → Add a person.'));
    out.push(c.captains.total === 0 ? item('captains', 'Ladder and DIRT captains', 'off', 'No Ladder or DIRT teams yet.') : c.captains.named === c.captains.total ? item('captains', 'Ladder and DIRT captains', 'ok', 'Every team has a captain named.') : item('captains', 'Ladder and DIRT captains', 'off', `${c.captains.named} of ${c.captains.total} teams have a captain named.`, 'Use 👑 Captains on each Ladder and DIRT team.'));
    out.push(c.env.ANTHROPIC_API_KEY ? item('assistant', 'Ask the club (assistant)', 'ok', 'Set.') : item('assistant', 'Ask the club (assistant)', 'off', 'Not switched on.', 'Add ANTHROPIC_API_KEY in Vercel.'));
    out.push(c.google ? item('sheets', 'Google Sheet sync', c.sync ? 'ok' : 'off', c.sync ? 'Publishing is on.' : 'The Google key is set but no series is switched on.', c.sync ? '' : 'Admin → Google Sheet sync → tick the series.') : item('sheets', 'Google Sheet sync', 'off', 'The Google service account key is not set, so nothing is published to the sheets.', 'Add GOOGLE_SERVICE_ACCOUNT_JSON in Vercel and share the sheets with its email.'));
    out.push(c.digest ? item('digest', 'Morning digest', 'ok', 'On.') : item('digest', 'Morning digest', 'off', 'Off.', 'This week → tick Morning digest.'));
    out.push(c.publicPage ? item('public', 'Public club page', 'ok', 'On at /club.html.') : item('public', 'Public club page', 'off', 'Off.', 'This week → tick Public club page, then look at /club.html first.'));
    return out;
  }

  const routes = { 'GET /api/golive': async req => { requireRole(req, ['admin']); const items = build(await gather()); return { staging: process.env.STAGING === '1', items, ready: items.filter(i => i.state === 'todo').length === 0, todo: items.filter(i => i.state === 'todo').length }; } };
  return { routes, build };
};

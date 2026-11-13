# Operating the club app

## After every deploy: the smoke test
`.github/workflows/smoke.yml` runs after each successful **Production** deploy. It calls `POST /api/smoke` (same `CRON_SECRET` as the schedule) and the app checks itself: storage, every system in the Control room, the monthly PDF, the public race data and the key page files. If anything fails the workflow goes red (GitHub emails you) and the admin Discord channel is told. You can also run it by hand: GitHub → Actions → *Post-deploy smoke test* → Run workflow.

## Staging (safe previews)
A Vercel **preview** deployment never sends real email or posts to the club's Discord (it is switched off in code), and the Control room says so. To let a preview send for real while you test, set `ALLOW_OUTBOUND=1` on that preview only. Use a separate Upstash database for previews if you want them to have their own data (give the Preview environment its own `UPSTASH_REDIS_REST_URL/TOKEN`); otherwise a preview reads the same data as production, so do not enter real changes in a preview.

## Supporter payments (Stripe)
Off until these are set in Vercel (Production): `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (a recurring monthly price), `STRIPE_WEBHOOK_SECRET`.
1. In Stripe create a recurring monthly Product and copy its Price ID (`price_…`).
2. Developers → Webhooks → add an endpoint `https://club.cryo-gen.team/api/stripe/webhook` for the events `checkout.session.completed`, `customer.subscription.deleted` and `invoice.payment_failed`; copy its signing secret (`whsec_…`).
3. Redeploy. Members then see **Become a supporter** in the AI coach; paying adds them to the supporter list, cancelling removes them, and the admin channel is told of each. Card details never touch this app. The old manual payment link still works when Stripe is not set.

## Audit trail
Control room → **Audit** (admins): who changed what and when (email, AI desk, joins, autopilot, go-live, supporters, privacy, ZRL line-ups and results). It records the action, never the contents. Members can already download or ask to erase their own data from their profile; erase requests appear under Investigations → Privacy requests.

## Push notifications and calendars
Members who have not linked Discord still get availability asks and line-up news if they have switched on notifications in the installed app (My Profile): the automatic messages fall back to web push. Every rider can also subscribe to a private calendar feed (My Profile → calendar) for their races and rides.

## Ride-cover webhook
`RIDE_COVER_WEBHOOK_URL` may be a Zapier/Make webhook or a Discord webhook address. A Discord address is sent as a plain message.

## Automatic results
Control room → **Results**. Give the address of a results table: in Google Sheets use File → Share → Publish to web → choose the results tab and **Comma-separated values (.csv)**, copy the link. The first row must name the columns (Team, and Position and/or Points). On race day and the day after, the hourly job reads it and enters results (teams matched by name; other clubs' rows ignored) whenever the table has changed. Use **Test it now** first: it shows what would be entered and changes nothing. If the address stops working the admin channel is told once. The radio, team reports and the open race page follow from the entered results.

## Feedback
Everyone signed in sees a **💬 Something wrong?** button. Reports (with the page and the last script error) appear in Control room → **Feedback**, sorted into bug / request / question / praise with a priority; a high-priority bug also posts to the admin channel. Ten reports a day per person.

## Captain page
A rider who captains a ZRL team gets **🧢 My team**: answers, line-up and result for the next race, *Ask the unanswered on Discord* and *Suggest a line-up* (then *Set this line-up*). Captains only see their own team.

## Invitations
My Profile has **🤝 Invite a friend**: a personal link to the join page. Requests that come through it are credited to the rider (Control room → Join requests shows who invited whom and the top inviters). A forged code is ignored.

## End of a round
When every team has every result, the admin channel is told once. AI desk → **Certificate (PDF)** makes a printable certificate for the chosen team; the recognition post and the end-of-round team emails (with automatic reports on) follow as before.

## Usage
Control room → **Usage**: storage commands, AI spend and emails sent today against their budgets (amber at 80%, red at 100%; the admin channel is told once at each, and the Systems list shows anything over 80%). Set the AI budget under Admin → Supporters and the email limits under Email → Settings.

## Keeping it maintenance-free
- **Weekly housekeeping** (early Sunday): removes finished, old data (old email recipient lists, decided join requests, answered feedback, the autopilot/radio/report "already done" markers). Control room → Systems shows when it last ran.
- **Dependabot** opens a weekly pull request when the build tools or GitHub automation have an update; merge it when the check is green.
- **Watchdog, smoke test, usage alerts and the go-live check** (above) tell the admin channel when something needs a person; otherwise nothing needs doing.
- **Owner login:** see `docs/ACCESS.md`. Add `OWNER_PASSWORD` once.

## My details, requests and season plans
Members open **🙋 My details** to choose how we email them (everything, only what they need, nothing) and the first name used in emails; both apply at once. A change to their name, email or membership is a *request*: it appears in Control room → **Member requests** (and the admin channel), because the club's member plugin only lets the app change tier, status and the off-boarding ticks. Make the change in WordPress and press *Mark done*; for *I want to leave* an Administrator can press *Mark as left in WordPress*. **📅 My plan** builds a 4–16 week plan from the rider's own FTP (no AI, no cost) and sends each week's sessions on Monday morning.

## WordPress accounts for join requests (owner switch)
Control room → **Website** → *Allow creating WordPress accounts* (owner only). Then on a join request an Administrator can **Preview** what would be created and **Create** it: a standard WordPress "subscriber" account with a long random password nobody sees (the person uses *Lost your password?*). It checks the account exists afterwards and links an existing account rather than duplicating it. You still add the Zwift ID and tier in WordPress, because the member plugin's fields are not documented. The welcome email then tells them to set their password.

## Standings on the website (owner switch)
Control room → **Website** → *Post standings automatically*. When every team has a result for a race, one post ("<round>: standings after race N": a table per division and that race's results) is made on cryogen.team, as a **draft** unless *Publish straight away* is ticked. Team names and points only.

## Alerts on your phone, and app shortcuts
Control room → *Alerts on this device* (needs the push keys, see the Notifications setting) sends a phone alert when a system goes red or a post-deploy check fails. Long-press the installed app's icon for shortcuts to This week, Control room, Email and My team; `/?tab=control` style links open a page directly.

## Launch plan and "needs fixing"
Control room → **🚀 Launch**: the order to switch things on (owner password, go-live check, race radio, automatic results, race-week autopilot, website standings as drafts, share the join page, WordPress account creation), each marked done, ready or waiting, with what must be true first, worked out from the app's own state. Below it, **Needs fixing** lists open bug reports, new browser errors, red systems and failed jobs in one place; a short version is posted to the admin channel on Monday mornings when there is something to say.

## Inspecting the WordPress member plugin
Control room → **Website** → *Inspect the member plugin* (administrators): a read-only look at which routes the plugin publishes (methods and arguments) and the member field **names** and types (never values). Send that list to whoever helps with the app and it shows exactly which member details can safely be written back (name, email, Zwift ID, tier), so the manual WordPress steps can be automated.

## Results from a web page
Automatic results accept a CSV address or a web page: if the address is a page, the first table with a Team column and a Position or Points column is used. Team points themselves still come from WTRL's table: ZwiftRacing's event data lists riders' finishes but not WTRL's team points, so it cannot replace a results table.

## Storage use
Staying inside the storage plan: the Control room's systems list is reused for five minutes by an open tab (the ↻ Refresh button asks afresh), the roster refresh saves riders' weights in a handful of commands (it used to be one per rider), and the weekly housekeeping removes finished data. Control room → Usage shows storage, AI and email against their limits.

## Alerts, off-site backups and sign-in checks

- **Email alerts:** set `ALERT_EMAIL` in Vercel to your address. You are then emailed (as well as the admin Discord channel and staff push) when a scheduled job fails or a system goes red, and again when it is healthy. It sends through the club's own email service, so if that is the thing that is down, Discord and push still reach you.
- **Off-site backup:** the *Off-site backup* GitHub workflow runs every night, fetches the same snapshot an administrator can download, encrypts it and keeps it for 30 days as a workflow artifact. Add two repository secrets: `CRON_SECRET` (already there) and `BACKUP_PASSPHRASE` (a long passphrase; keep a copy somewhere safe, it is the only way to open a copy). To open one: `openssl enc -d -aes-256-cbc -pbkdf2 -in cryogen-backup.json.gz.enc | gunzip > backup.json`.
- **Sign-in check:** the post-deploy smoke test (and every Monday morning) now checks that the Administrator and Moderator sign-in work and that every stored authenticator can still be opened. If `AUTH_ENC_KEY` is ever changed, this fails at once instead of locking people out silently.
- **Sign out everywhere:** Control room → Security. A password change, an owner reset or removing an account also ends that person's open sessions immediately.
- **Joining and leaving:** Control room → Join requests has *Approve: account + welcome* (creates the WordPress account if the owner switched that on, then sends the welcome email) and *A member is leaving* (preview, then one press: WordPress record set to left, club email stopped; the Discord role is the one step you do by hand).
- **Whole-round line-ups:** Control room → Now → *Whole round* on a team proposes who rides each race week, sharing races out fairly, with *Apply* per week.
- **Already in place:** the app is installable on phones and riders can turn on push notifications (My details / profile); race reminders use them for riders without Discord.

## WordPress two-way member sync

Set `WP_SYNC_SECRET` in Vercel (a long random string) and use the same value in WordPress. Then edits made on cryogen.team show in the app within seconds instead of up to five minutes, and the Control room's Systems list shows "Member sync from cryogen.team".

WordPress tells the app with `POST /api/wp/members-changed`, JSON `{"event":"saved","zwift_id":"123","ts":<unix seconds>}`, header `X-Cryogen-Signature` = hex HMAC-SHA256 of the raw body with the secret. Requests older than five minutes are refused. A Code Snippets example (change `members` to the member record type your plugin uses, if it differs):

```php
add_action('save_post_members', function ($post_id) {
    if (wp_is_post_revision($post_id) || (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE)) return;
    $secret = 'PASTE_YOUR_WP_SYNC_SECRET_HERE';
    $body = wp_json_encode(['event' => 'saved', 'ts' => time()]);
    wp_remote_post('https://club.cryo-gen.team/api/wp/members-changed', [
        'timeout' => 5, 'blocking' => false,
        'headers' => ['Content-Type' => 'application/json', 'X-Cryogen-Signature' => hash_hmac('sha256', $body, $secret)],
        'body' => $body,
    ]);
});
```

`GET /api/wp/admin-summary` (signed the same way, counts only) feeds the CRYO-GEN Members page in WordPress.

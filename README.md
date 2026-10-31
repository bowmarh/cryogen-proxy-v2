# cryogen-proxy-v2

Members dashboard for the CRYO-GEN Zwift cycling club (Zwift club 2740), live at **https://club.cryo-gen.team**. It shows the team roster, racing stats, race-series sign-ups, the weekly TTT (sign-up, team builder, published line-ups and history) and social rides, with separate views for admins, moderators and members.

## What's in the repo

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard shell: HTML, CSS and most app logic. Vercel serves it as a static file. |
| `public/js/` | Self-contained browser modules extracted incrementally from the dashboard. |
| `api/server.js` | Node.js API: admin/mod login, shared sign-ups/RSVPs/rides (`/api/state`, …), and the Google Sheets reader (`/api/proxy`). Serves `public/` when run locally. |
| `vercel.json` | Vercel config pointing at `api/server.js`. |
| `schema.sql` | Empty placeholder. |

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for running the club week to week, [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and [PROJECT_STATUS.md](PROJECT_STATUS.md) for known issues.

## Running locally

```bash
cd api
ADMIN_PASSWORD=... MOD_PASSWORD=... KV_REST_API_URL=... KV_REST_API_TOKEN=... npm start   # http://localhost:3000
```

## Tests

```
node --test test/*.test.js
```

The API runtime uses only Node's built-in modules. Unit tests use Node's built-in test runner and in-memory fakes for Redis, WordPress, Google Sheets and Discord (`test/helpers.js`); Playwright covers real browser flows against that local fake-backed server.

```bash
npm test
npm run test:e2e
```

Install the browser once with `npx playwright install chromium`. Unit tests cover login and sessions, authorization, member sign-in, TTT, member record edits, roster caching, public sheet data, system health and dashboard routes. Playwright covers the member portal and calendar flow in a browser. GitHub runs both suites on pull requests.

When you change behaviour, change or add a test with it. A test file runs in its own process, so settings from `setEnv()` don't leak between files.

## Configuration (Vercel environment variables)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD`, `MOD_PASSWORD` | Staff login passwords. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Shared storage (Upstash Redis). Added automatically when Upstash for Redis is connected to the project in Vercel → Storage. |
| `SHEET_ID` *(optional)* | Google Sheet to read rides and TTT data from. Defaults to the club sheet. |
| `SHEET_TAB_RIDES`, `SHEET_TAB_TTT` *(optional)* | Tab names. Default `Social Rides` and `TEAM LIST`. |
| `SHEET_TIMEOUT_MS` *(optional)* | How long to wait for Google before answering "did not answer in time" (504). Default 6000. |
| `SITE_URL` *(optional)* | Public portal URL, used for links and as the only allowed browser origin for API mutations. Defaults to `https://club.cryo-gen.team`. |
| `STAGING` *(optional)* | Set to `1` on a practice copy only: shows a STAGING banner, tags Discord posts `[STAGING]`, and enables the "Fill with test data" button. Use a separate database. |
| `REDIS_DAILY_LIMIT` *(optional)* | Storage commands per day at which Health starts warning (at 80%). Defaults to 16000; set it to your Upstash plan's daily allowance. |
| `SESSION_SECRET` *(optional)* | Key for signing staff login tokens. Derived from the passwords if unset. |
| `DISCORD_WEBHOOK_PUBLIC` *(optional)* | Discord webhook for the club channel: sign-ups open, day-before reminder, sign-ups closed, line-ups published. |
| `DISCORD_WEBHOOK_ADMIN` *(optional)* | Discord webhook for the private admin channel: "sign-ups closed, N unplaced", late withdrawals after publishing. |
| `DISCORD_WEBHOOK_ZRL_PUBLIC` *(optional)* | Discord webhook for the ZRL club channel: round open, reminder, closed, rosters out. Falls back to `DISCORD_WEBHOOK_PUBLIC`. |
| `DISCORD_WEBHOOK_ZRL_ADMIN` *(optional)* | Discord webhook for the private ZRL admin channel: sign-ups closed, rosters published with the to-do list. Falls back to `DISCORD_WEBHOOK_ADMIN`. |
| `DISCORD_WEBHOOK_DRS` *(optional)* | Discord webhook for the DIRT Racing Series channel: stage posts with the private link and the squad, and the reminders. Falls back to `DISCORD_WEBHOOK_PUBLIC`. `DISCORD_WEBHOOK_DRS_ADMIN` is for staff alerts (vELO near the cap, finalise-the-squad reminders; falls back to `DISCORD_WEBHOOK_ADMIN`). |
| `DISCORD_WEBHOOK_COMMS` *(optional)* | Discord webhook for staff messages from the **💬 Comms** tab (a message to everyone, or an @mention of chosen members when there is no bot). Falls back to `DISCORD_WEBHOOK_PUBLIC`. |
| `DISCORD_BOT_TOKEN` *(optional)* | A Discord bot token, so Comms can send **private direct messages** to chosen members instead of mentioning them in the channel. The bot must share a server with the members, and a member needs their Discord user ID saved in Comms. Without it, members are @mentioned in the club channel. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` *(optional)* | The Discord application's OAuth2 client ID and secret (same application as the bot, Developer Portal → OAuth2), so riders can **Connect with Discord** from My Profile instead of copying an ID. In OAuth2 → Redirects add `<SITE_URL>/api/discord/callback` (for example `https://club.cryo-gen.team/api/discord/callback`). The scope used is `identify` only. |
| `DISCORD_GUILD_ID` *(optional)* | Your Discord server's ID (right-click the server, Copy Server ID). With the bot, it lets Comms → Import Discord IDs fetch the member list; the bot also needs **Server Members Intent** turned on (Developer Portal → Bot → Privileged Gateway Intents). A CSV upload needs neither. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` *(optional)* | The JSON key of a Google service account (the whole file on one line; or `GOOGLE_SERVICE_ACCOUNT_JSON_B64`, the same base64-encoded). It lets the app publish its TTT and ZRL teams to a mirror tab on the club's sheets. Setup: in Google Cloud create a project, enable the **Google Sheets API**, create a service account and a JSON key, then share each sheet with the account's `client_email` as an **Editor**. Admin → Google Sheet sync shows its status. Reading the sheets into the app needs none of this (the sheets are "Anyone with the link can view"). |
| `ZRL_SHEET_ID` *(optional)* | The ZRL tracker sheet to sync. Defaults to the club's ZRL tracker. It can also be changed in Admin → Google Sheet sync. |
| `SHEET_TAB_TTT_FORM` *(optional)* | The tab of the TTT workbook that holds the sign-up form responses. Found automatically (`Form Responses 1`, then the first tab) when not set. |
| `DISCORD_WEBHOOK_LADDER` *(optional)* | Discord webhook for the Zwift Club Ladder channel: challenge call-outs, line-ups with the private event link, and match reminders. Falls back to `DISCORD_WEBHOOK_PUBLIC`. `DISCORD_WEBHOOK_LADDER_ADMIN` is for staff warnings (falls back to `DISCORD_WEBHOOK_ADMIN`). |
| `LOGIN_MAX_FAILS` *(optional)* | Wrong staff passwords allowed from one connection in 15 minutes before every attempt gets 429 (default 10). |
| `RATE_LIMIT_WRITES_PER_MIN` *(optional)* | Writes a minute allowed to anyone who is not staff, per connection (default 120). |
| `RIDE_COVER_WEBHOOK_URL` *(optional)* | An https URL (a Zapier or Make "catch hook", or a Twilio function) that receives each ride-cover message as JSON `{source, channel: "public"|"admin", text, kind}` and posts it to WhatsApp. When it is not set, or does not answer, the message goes to Discord (`DISCORD_WEBHOOK_PUBLIC` / `DISCORD_WEBHOOK_ADMIN`). |
| `ZWIFTRACING_API_KEY` *(optional)* | Your personal organizer key for the ZwiftRacing.app public API (sent raw in the `Authorization` header). Used only by the admin "ZwiftRacing.app lookup" in the ZRL Results tab, to look at an event's results. Never shown or logged. Mark it Sensitive in Vercel. |
| `DISCORD_PUBLIC_KEY` *(optional)* | The Discord application's public key (Developer Portal, General Information). With it, reminders carry Yes / Maybe / No buttons and riders answer by tapping them. Set the portal's **Interactions Endpoint URL** to `<your site>/api/discord/interactions`. |
| `ANTHROPIC_API_KEY` *(optional)* | Switches on **Ask the club** (This week): plain words turned into a plan from a fixed menu, shown to staff and run only when they confirm. `ASSISTANT_MODEL` changes the model. Limited to 60 requests a day. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` *(optional)* | Switch on notifications on riders' phones and computers (Admin → Staff accounts → Make push keys makes the pair; `VAPID_SUBJECT` is a `mailto:` address). |
| `CRON_SECRET` | Shared secret for `/api/cron/tick`. Set the same value as a GitHub repository secret so the **TTT schedule** workflow (every 15 min) can run reminders, auto-close and the next-week rollover on time. |
| `WP_SSO_SECRET` *(optional)* | Shared secret that lets riders sign in with their cryogen.team account (see ARCHITECTURE.md, "Member sign-in"). The same value goes into the WordPress snippet. Without it the "Sign in" button is hidden and the name-picker is the only member login. |
| `WP_SSO_LOGIN_URL` *(optional)* | Where the "Sign in" button sends riders. Default `https://cryogen.team/club-login`. |
| `REQUIRE_MEMBER_LOGIN` *(optional)* | Set to `1` to stop guests (name-picker logins) signing up, withdrawing or RSVPing. This is enforced automatically in Vercel Production even if unset. Signed-in members and staff are unaffected. |
| `WP_API_USER`, `WP_API_APP_PASSWORD` *(optional)* | WordPress user + Application Password for the cryogen.team member records (tier/status/off-boarding, read and edited through the server). Without them the live Zwift club roster still loads and everyone counts as active. |

No dependencies: it uses only Node's built-in modules.

## Data sources

- **WordPress API** on `cryogen.team` (`/wp-json/cryogen/v1`): member records and live club data from ZwiftRacing.app, served by a custom WordPress plugin on the club site.
- **Google Sheets** (via `/api/proxy`): social rides and team time trial (TTT) data. The sheet must be shared as "Anyone with the link can view".
- **Shared storage** (Upstash Redis, via `/api/state` and friends): event sign-ups, series locks, club-created rides and RSVPs.
- **Browser `localStorage`**: affiliation history (not shared yet).

The roster response includes its last successful update time and marks last-good fallback data as stale. The dashboard labels stale data and does not substitute sample riders when the live roster is unavailable.

## Weekly TTT automation

All times are UK time (`Europe/London`, follows BST/GMT). For a race on Wednesday:

| When | What happens |
|---|---|
| Week starts | Discord: "sign-ups open" with the teams |
| Sunday 19:00 | Discord: "last day to sign up" reminder |
| Monday 19:00 | Sign-ups close automatically; Discord: "closed" (club) + "N unplaced, build teams" (admins) |
| Admin presses **Publish** | Discord: full line-ups, captains marked ⭐ |
| Staff save a team's result | Discord (club): one "🏁 Results" post listing the teams whose result is new (best first, 🥇🥈🥉, riders and ⭐ captain). Corrections to an existing result are not re-posted. Works for archived weeks too |
| Rider withdraws (or becomes unavailable) after publishing | First waitlisted rider who picked that team (else first waiting) is moved in automatically; Discord: "🎉 X moves up" (club) + what happened (admins) |
| Late sign-up after publishing | Placed in a picked team with room, otherwise added to the waitlist; Discord (admins) |
| Thursday 09:00 | This week is archived and next Wednesday's week starts automatically (same teams) |

Events fire once each (tracked in Redis `cg:ttt:sent`), so several triggers can overlap safely. They are driven from:

- **GitHub Actions** (`ttt-schedule.yml`): meant to run every 15 minutes, but GitHub throttles scheduled jobs in quiet repositories, so in practice it can be hours apart.
- **Vercel Cron** (`vercel.json`): once a day at 09:00 UTC (Hobby plan: once a day, any time within that hour, so 10:xx BST or 09:xx GMT). Vercel sends `Authorization: Bearer <CRON_SECRET>` itself. It reliably catches the Thursday 09:00 UK rollover.
- **Upstash QStash** (optional, set up in the Upstash console): a schedule that calls `GET /api/cron/tick` every 15 minutes with the same Bearer header. This is what makes the Monday 19:00 close and the reminder prompt.
- Whenever someone opens the TTT page.

The **TTT Season** tab can be split into seasons: staff add a season (name and start date) at the bottom of that page, and riders pick any season from a drop-down. Starting a new season doesn't delete anything; it only decides which weeks the page counts.

The Admin **System health** panel shows when the last scheduled run happened. Admins can still reopen sign-ups after the automatic close.

### Captains
Riders can tick **⭐ Happy to captain** when signing up. Auto-assign makes the highest-vELO volunteer in each team its captain (teams with no volunteer are flagged); staff can change the captain from the team card. If a captain withdraws, another volunteer in that team takes over automatically, otherwise the admin channel is told the team needs a captain.

### Results
After the race, staff open **🏆 Enter results** on the TTT Week page and type each team's time, position (e.g. 12th of 45) and a results link, or tick DNF. Results show in a table on that week, on each team card and in riders' own status. Past weeks can be edited from the history dropdown, so results can be added after the Thursday rollover.

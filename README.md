# cryogen-proxy-v2

Members dashboard for the CRYO-GEN Zwift cycling club (Zwift club 2740), live at **https://club.cryo-gen.team**. It shows the team roster, racing stats, race-series sign-ups, the weekly TTT (sign-up, team builder, published line-ups and history) and social rides, with separate views for admins, moderators and members.

## What's in the repo

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard: a single-page app (HTML, CSS and JS in one file). Vercel serves it as a static file. |
| `api/server.js` | Node.js API: admin/mod login, shared sign-ups/RSVPs/rides (`/api/state`, …), and the Google Sheets reader (`/api/proxy`). Serves `public/` when run locally. |
| `vercel.json` | Vercel config pointing at `api/server.js`. |
| `schema.sql` | Empty placeholder. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and [PROJECT_STATUS.md](PROJECT_STATUS.md) for known issues.

## Running locally

```bash
cd api
ADMIN_PASSWORD=... MOD_PASSWORD=... KV_REST_API_URL=... KV_REST_API_TOKEN=... npm start   # http://localhost:3000
```

## Tests

```
node --test test/*.test.js
```

About 70 tests, about a second, no packages and no network (Node 20+; CI uses 22). They run against in-memory fakes of Redis, WordPress, Google Sheets and Discord (`test/helpers.js`) and cover logins and sessions, member sign-in, who a sign-up is recorded for, the TTT week (sign-up, line-ups, waitlist, captains, results, rollover, Discord posts), member record edits, the roster cache, the public sheet data, the health panel, and the dashboard page itself (scripts parse, every route it calls exists). GitHub runs them on every pull request.

When you change behaviour, change or add a test with it. A test file runs in its own process, so settings from `setEnv()` don't leak between files.

## Configuration (Vercel environment variables)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD`, `MOD_PASSWORD` | Staff login passwords. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Shared storage (Upstash Redis). Added automatically when Upstash for Redis is connected to the project in Vercel → Storage. |
| `SHEET_ID` *(optional)* | Google Sheet to read rides and TTT data from. Defaults to the club sheet. |
| `SHEET_TAB_RIDES`, `SHEET_TAB_TTT` *(optional)* | Tab names. Default `Social Rides` and `TEAM LIST`. |
| `SHEET_TIMEOUT_MS` *(optional)* | How long to wait for Google before answering "did not answer in time" (504). Default 6000. |
| `SESSION_SECRET` *(optional)* | Key for signing staff login tokens. Derived from the passwords if unset. |
| `DISCORD_WEBHOOK_PUBLIC` *(optional)* | Discord webhook for the club channel: sign-ups open, day-before reminder, sign-ups closed, line-ups published. |
| `DISCORD_WEBHOOK_ADMIN` *(optional)* | Discord webhook for the private admin channel: "sign-ups closed, N unplaced", late withdrawals after publishing. |
| `DISCORD_WEBHOOK_ZRL_PUBLIC` *(optional)* | Discord webhook for the ZRL club channel: round open, reminder, closed, rosters out. Falls back to `DISCORD_WEBHOOK_PUBLIC`. |
| `DISCORD_WEBHOOK_ZRL_ADMIN` *(optional)* | Discord webhook for the private ZRL admin channel: sign-ups closed, rosters published with the to-do list. Falls back to `DISCORD_WEBHOOK_ADMIN`. |
| `DISCORD_WEBHOOK_DRS` *(optional)* | Discord webhook for the DIRT Racing Series channel: stage posts with the private link and the squad, and the reminders. Falls back to `DISCORD_WEBHOOK_PUBLIC`. `DISCORD_WEBHOOK_DRS_ADMIN` is for staff alerts (vELO near the cap, finalise-the-squad reminders; falls back to `DISCORD_WEBHOOK_ADMIN`). |
| `DISCORD_WEBHOOK_LADDER` *(optional)* | Discord webhook for the Zwift Club Ladder channel: challenge call-outs, line-ups with the private event link, and match reminders. Falls back to `DISCORD_WEBHOOK_PUBLIC`. `DISCORD_WEBHOOK_LADDER_ADMIN` is for staff warnings (falls back to `DISCORD_WEBHOOK_ADMIN`). |
| `LOGIN_MAX_FAILS` *(optional)* | Wrong staff passwords allowed from one connection in 15 minutes before every attempt gets 429 (default 10). |
| `RATE_LIMIT_WRITES_PER_MIN` *(optional)* | Writes a minute allowed to anyone who is not staff, per connection (default 120). |
| `RIDE_COVER_WEBHOOK_URL` *(optional)* | An https URL (a Zapier or Make "catch hook", or a Twilio function) that receives each ride-cover message as JSON `{source, channel: "public"|"admin", text, kind}` and posts it to WhatsApp. When it is not set, or does not answer, the message goes to Discord (`DISCORD_WEBHOOK_PUBLIC` / `DISCORD_WEBHOOK_ADMIN`). |
| `ZWIFTRACING_API_KEY` *(optional)* | Your personal organizer key for the ZwiftRacing.app public API (sent raw in the `Authorization` header). Used only by the admin "ZwiftRacing.app lookup" in the ZRL Results tab, to look at an event's results. Never shown or logged. Mark it Sensitive in Vercel. |
| `CRON_SECRET` | Shared secret for `/api/cron/tick`. Set the same value as a GitHub repository secret so the **TTT schedule** workflow (every 15 min) can run reminders, auto-close and the next-week rollover on time. |
| `WP_SSO_SECRET` *(optional)* | Shared secret that lets riders sign in with their cryogen.team account (see ARCHITECTURE.md, "Member sign-in"). The same value goes into the WordPress snippet. Without it the "Sign in" button is hidden and the name-picker is the only member login. |
| `WP_SSO_LOGIN_URL` *(optional)* | Where the "Sign in" button sends riders. Default `https://cryogen.team/club-login`. |
| `REQUIRE_MEMBER_LOGIN` *(optional)* | Set to `1` to stop guests (name-picker logins) signing up, withdrawing or RSVPing. Signed-in members and staff are unaffected. Leave unset during rollout. |
| `WP_API_USER`, `WP_API_APP_PASSWORD` *(optional)* | WordPress user + Application Password for the cryogen.team member records (tier/status/off-boarding, read and edited through the server). Without them the live Zwift club roster still loads and everyone counts as active. |

No dependencies: it uses only Node's built-in modules.

## Data sources

- **WordPress API** on `cryogen.team` (`/wp-json/cryogen/v1`): member records and live club data from ZwiftRacing.app, served by a custom WordPress plugin on the club site.
- **Google Sheets** (via `/api/proxy`): social rides and team time trial (TTT) data. The sheet must be shared as "Anyone with the link can view".
- **Shared storage** (Upstash Redis, via `/api/state` and friends): event sign-ups, series locks, club-created rides and RSVPs.
- **Browser `localStorage`**: affiliation history (not shared yet).

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

# cryogen-proxy-v2

Members dashboard for the CRYO-GEN Zwift cycling club (Zwift club 2740). It shows the team roster, racing stats, race-series sign-ups and social rides, with separate views for admins, moderators and members.

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

## Configuration (Vercel environment variables)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD`, `MOD_PASSWORD` | Staff login passwords. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Shared storage (Upstash Redis). Added automatically when Upstash for Redis is connected to the project in Vercel → Storage. |
| `SHEET_ID` *(optional)* | Google Sheet to read rides and TTT data from. Defaults to the club sheet. |
| `SHEET_TAB_RIDES`, `SHEET_TAB_TTT` *(optional)* | Tab names. Default `Social Rides` and `TEAM LIST`. |
| `SESSION_SECRET` *(optional)* | Key for signing staff login tokens. Derived from the passwords if unset. |

No dependencies: it uses only Node's built-in modules.

## Data sources

- **WordPress API** on `cryogen.team` (`/wp-json/cryogen/v1`): member records and live club data from ZwiftRacing.app, served by a custom WordPress plugin on the club site.
- **Google Sheets** (via `/api/proxy`): social rides and team time trial (TTT) data. The sheet must be shared as "Anyone with the link can view".
- **Shared storage** (Upstash Redis, via `/api/state` and friends): event sign-ups, series locks, club-created rides and RSVPs.
- **Browser `localStorage`**: admin tier/status edits and affiliation history (not shared yet).

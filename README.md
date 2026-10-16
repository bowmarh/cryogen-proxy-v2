# cryogen-proxy-v2

Members dashboard for the CRYO-GEN Zwift cycling club (Zwift club 2740). It shows the team roster, racing stats, race-series sign-ups and social rides, with separate views for admins, moderators and members.

## What's in the repo

| Path | What it is |
|---|---|
| `public/index.html` | The dashboard: a single-page app (HTML, CSS and JS in one file). Vercel serves it as a static file. |
| `api/server.js` | Small Node.js server: a CORS proxy at `/api/proxy`, plus serving of `api/api/proxy.html`. |
| `api/api/proxy.html` | A newer copy of the dashboard (adds a guard on member login while the roster loads). |
| `vercel.json` | Vercel config pointing at `api/server.js`. |
| `schema.sql` | Empty placeholder. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and [PROJECT_STATUS.md](PROJECT_STATUS.md) for known issues.

## Running locally

```bash
cd api
npm start          # http://localhost:3000
```

No dependencies: it uses only Node's built-in modules.

## Data sources

- **WordPress API** on `cryogen.team` (`/wp-json/cryogen/v1`): member records and live club data from ZwiftRacing.app, served by a custom WordPress plugin on the club site.
- **Google Sheets** (via `/api/proxy`): social rides and team time trial (TTT) data.
- **Browser `localStorage`**: sign-ups, RSVPs, series locks and affiliation history.

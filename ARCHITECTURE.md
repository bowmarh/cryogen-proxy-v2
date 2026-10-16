# Architecture

```
Browser (public/index.html)
 ├─ fetch https://cryogen.team/wp-json/cryogen/v1/...   → WordPress plugin on Hostinger
 │     /members                     member records (tier, status, offboarding)
 │     /zwift/public/clubs/2740/0   live roster from ZwiftRacing.app
 │     /zwift/public/results        race results
 ├─ fetch /api/proxy?endpoint=rides|ttt-sheet           → api/server.js → Google Sheets (gviz JSON)
 └─ localStorage                                         sign-ups, RSVPs, locks (per browser)
```

## Frontend (`public/index.html`)

A single file with no build step. Tabs: Team Overview, Racing Dashboard, Events & Sign-Up, Social Rides, Members, plus a profile page.

- **Roles:** admin, moderator and member. Admin and moderator passwords are checked by `POST /api/login` against the `ADMIN_PASSWORD` / `MOD_PASSWORD` environment variables. Members pick themselves from the live roster by name or Zwift ID. The role is kept in `sessionStorage`.
- **Data loading:** `loadLive()` reads `/members` from WordPress, then the club roster, and merges the two by Zwift ID. If loading fails, it falls back to a small `MOCK` roster.
- **WordPress auth:** the `api()` helper sends `X-WP-Nonce` when the page runs inside WordPress (`window.wpApiSettings`), and otherwise a Basic auth header.
- **Local state:** sign-ups, RSVPs, series locks and affiliation history are saved to `localStorage`, so they live only in the browser that created them.

## Proxy (`api/server.js`)

A plain Node.js request handler:

- `GET /api/proxy?endpoint=<name>` fetches the URL mapped in `ENDPOINT_MAP` and returns it with `Access-Control-Allow-Origin: *`. Only named endpoints are allowed.
- `POST /api/login` with `{role, password}` returns 200 if the password matches the role's environment variable, 401 if it doesn't, and 503 if the variable isn't set.
- All other paths serve files from `api/api/` (default `proxy.html`).

The file exports its handler for Vercel. `vercel.json` rewrites `/api/*` to it, and `npm start` runs it as a local server.

## Hosting

- The dashboard is deployed on **Vercel** (project `cryogen-proxy-v2`). Set `ADMIN_PASSWORD` and `MOD_PASSWORD` in the project's environment variables.
- The WordPress backend is the `cryogen.team` WordPress site on the club's Hostinger Business plan.

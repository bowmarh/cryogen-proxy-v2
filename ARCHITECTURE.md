# Architecture

```
Browser (public/index.html)
 ├─ fetch https://cryogen.team/wp-json/cryogen/v1/...   → WordPress plugin on Hostinger
 │     /members                     member records (tier, status, offboarding)
 │     /zwift/public/clubs/2740/0   live roster from ZwiftRacing.app
 │     /zwift/public/results        race results
 ├─ fetch /api/proxy?endpoint=rides|ttt-sheet           → api/server.js → Google Sheets (gviz JSON)
 ├─ fetch /api/state, POST /api/signups|rsvps|rides|…   → api/server.js → Upstash Redis (shared)
 └─ localStorage                                         admin tier/status edits (per browser)
```

## Frontend (`public/index.html`)

A single file with no build step. Tabs: Team Overview, Racing Dashboard, Events & Sign-Up, Social Rides, Members, plus a profile page.

- **Roles:** admin, moderator and member. Admin and moderator passwords are checked by `POST /api/login` against the `ADMIN_PASSWORD` / `MOD_PASSWORD` environment variables. Members pick themselves from the live roster by name or Zwift ID. The role is kept in `sessionStorage`.
- **Data loading:** `loadLive()` reads `/members` from WordPress, then the club roster, and merges the two by Zwift ID. If loading fails, it falls back to a small `MOCK` roster.
- **WordPress auth:** the `api()` helper sends `X-WP-Nonce` when the page runs inside WordPress (`window.wpApiSettings`), and otherwise a Basic auth header.
- **Shared state:** sign-ups, series locks, club-created rides and RSVPs come from `/api/state`. Every write returns the full new state, which the page re-renders from.
- **Escaping:** everything people type is shown to other people, so it's rendered through `esc()`. Values passed to click handlers go through `data-*` attributes, never inline into the JS.
- **Local state:** admin tier/status edits and affiliation history are still saved to `localStorage`.

## Proxy (`api/server.js`)

A plain Node.js request handler:

- `POST /api/login` with `{role, password}` checks the role's password environment variable. It returns `{role, token}` on success (an HMAC-signed token, valid 12 hours), 401 on a wrong password, and 503 if the variable isn't set.
- `GET /api/proxy?endpoint=rides|ttt-sheet` reads that tab of the Google Sheet and returns `{rides, headers, updated}` or `{headers, rows, updated}`. Dates become `YYYY-MM-DD`. Only the named tabs are allowed.
- Shared data, stored in Upstash Redis hashes `cg:signups`, `cg:locks`, `cg:rides` and `cg:rsvps`:

  | Route | Who |
  |---|---|
  | `GET /api/state` | anyone |
  | `POST /api/signups`, `/api/rsvps`, `/api/rsvps/cancel` | anyone |
  | `POST /api/signups/remove`, `/api/rides`, `/api/rides/remove` | admin or mod (Bearer token) |
  | `POST /api/signups/clear`, `/api/locks` | admin |

- When run locally, all other paths serve files from `public/`.

The file exports its handler for Vercel. `vercel.json` rewrites `/api/*` to it, and `npm start` runs it as a local server.

## Hosting

- The dashboard is deployed on **Vercel** (project `cryogen-proxy-v2`). Set `ADMIN_PASSWORD` and `MOD_PASSWORD` in the project's environment variables.
- The WordPress backend is the `cryogen.team` WordPress site on the club's Hostinger Business plan.

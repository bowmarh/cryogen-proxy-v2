# Architecture

```
Browser (public/index.html)
 ├─ fetch /api/roster, POST /api/members/{zwiftId}       → api/server.js → WordPress plugin on Hostinger
 │     /members                     member records (tier, status, offboarding), read + PATCH
 │     /zwift/public/clubs/2740/0   live roster from ZwiftRacing.app
 ├─ fetch /api/proxy?endpoint=rides|ttt-sheet           → api/server.js → Google Sheets (gviz JSON)
 ├─ fetch /api/state, POST /api/signups|rsvps|rides|…   → api/server.js → Upstash Redis (shared)
 └─ localStorage                                         affiliation history (per browser)
```

## Frontend (`public/index.html`)

A single file with no build step. Tabs: Team Overview, Racing Dashboard, Events & Sign-Up, Social Rides, Members, plus a profile page.

- **Roles:** admin, moderator and member. Admin and moderator passwords are checked by `POST /api/login` against the `ADMIN_PASSWORD` / `MOD_PASSWORD` environment variables. Members either sign in with their cryogen.team account (verified) or pick themselves from the live roster by name or Zwift ID (guest). The role is kept in `sessionStorage`.
- **Data loading:** `loadLive()` reads `/api/roster`, which merges the club roster with the WordPress member records by Zwift ID. If loading fails, it falls back to a small `MOCK` roster.
- **Member edits:** tier, status and off-boarding checkboxes call `POST /api/members/{zwiftId}` (staff only). The server PATCHes the WordPress record, reads it back, and reports an error if a field didn't save. The browser never holds WordPress credentials.
- **Shared state:** sign-ups, series locks, club-created rides and RSVPs come from `/api/state`. Every write returns the full new state, which the page re-renders from.
- **Escaping:** everything people type is shown to other people, so it's rendered through `esc()`. Values passed to click handlers go through `data-*` attributes, never inline into the JS.
- **Local state:** affiliation history is still saved to `localStorage`.

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

- TTT week (Redis `cg:ttt:week`, `cg:ttt:signups`, `cg:ttt:assign`, `cg:ttt:archive`). Responses depend on the caller: comments are staff-only, and line-ups are hidden from members until published.

  | Route | Who |
  |---|---|
  | `GET /api/ttt`, `GET /api/ttt/archive?id=<date>` | anyone |
  | `POST /api/ttt/signup` (sign up or update), `/api/ttt/withdraw` | anyone, while sign-ups are open |
  | `POST /api/ttt/assign`, `/api/ttt/auto-assign`, `/api/ttt/status` (open/publish), `/api/ttt/teams`, `/api/ttt/new-week` | admin or mod |

  Starting a new week archives the current one with its line-ups and carries the teams over. Auto-assign places available, unplaced riders into their preferred teams (two for double-up), earliest sign-ups first, up to each team's max.

- When run locally, all other paths serve files from `public/`.

The file exports its handler for Vercel. `vercel.json` rewrites `/api/*` to it, and `npm start` runs it as a local server.

## Club roster cache

The roster comes from ZwiftRacing.app through the WordPress plugin, which answers 429 when asked too often. Each server instance used to ask on its own. The slimmed rider list is now kept in Redis (`cg:roster:riders`): reused for 10 minutes by every instance, and the last good copy is served if the source fails. Member records are not cached there; they are read each time the 5-minute in-memory cache expires.

## Member sign-in

Riders can sign in with their cryogen.team account instead of picking a name.

1. The "Sign in" button goes to `WP_SSO_LOGIN_URL` on WordPress. A snippet there logs the member in if needed, then redirects to `/api/auth/wp?t=<token>`.
2. The token is `base64url(JSON {zwid, name, exp, n}) + "." + base64url(HMAC-SHA256(WP_SSO_SECRET, first part))`. It must expire within 10 minutes and can be used once (nonce stored in Redis as `cg:sso:<n>`).
3. The server issues a 12-hour member session (same signing as staff sessions, `role: "member"`, with `zwid` and the roster name) and redirects to `/#sso=<session>`. The page reads the fragment, stores the token and removes it from the URL. Members whose WordPress record is `left` are refused.
4. With a member session, `identify()` forces the sign-up, withdrawal and RSVP routes to act as that rider whatever the request body says. A member session is never a staff role.
5. Guests (name-picker) can still write until `REQUIRE_MEMBER_LOGIN=1`; then they get a 401 asking them to sign in. Staff can still act for others.

`GET /api/auth/status` tells the page whether to show the button; `GET /api/me` returns the signed-in member's tier and status.

`GET /api/ttt/mine` (member session only) powers the **My TTT** card on the profile page: the rider's own sign-up for the current week, and once line-ups are published their team(s), zone, captain, teammates, waitlist place and result, plus up to 10 earlier weeks they rode (from the archive). Line-ups stay hidden until published, exactly as on the TTT page.

## Hosting

- The dashboard is deployed on **Vercel** (project `cryogen-proxy-v2`). Set `ADMIN_PASSWORD` and `MOD_PASSWORD` in the project's environment variables.
- The WordPress backend is the `cryogen.team` WordPress site on the club's Hostinger Business plan.

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

## TTT Season page

`GET /api/ttt/season` (public) feeds the **TTT Season** tab. `seasonSummary()` reads up to the latest 60 archived weeks, plus the current week once it has results, and returns totals, per-team stats (weeks, best and average place, podiums, DNFs), a rider leaderboard (weeks ridden, times captain, podiums; top 25) and a week-by-week list. A team counts for a week only if it had riders or a result. It uses only names, line-ups, captains and results, never comments or Zwift IDs. 

**Seasons.** A season is a name and a start date (Redis `cg:ttt:seasons`, JSON `[{id: <start date>, name, start}]`); it runs until the next season starts. `GET /api/ttt/season?season=<id>` returns that season's summary plus the list of seasons to choose from; the default is the latest. Until the first season is defined there is a single "All weeks" entry (the old behaviour), and once one exists, weeks before it appear as "Earlier weeks". Staff (admin or moderator) add a season with `POST /api/ttt/seasons {name, start}` (must start after the latest) and remove one with `POST /api/ttt/seasons/remove {id}`, whose weeks then fall back into the season before it. Nothing is ever deleted: seasons only decide which archived weeks the page shows.

## ZRL round sign-up

Logic lives in `lib/zrl.js` (a factory that `api/server.js` wires up; not in `api/`, since every file there becomes a public function). Redis keys: `cg:zrl:round` (name, start, closes, weeks, open, published, teams), `cg:zrl:signups` (one field per rider), `cg:zrl:assign`, `cg:zrl:archive`, `cg:zrl:sent`. Regions are `eu`, `am`, `ap` (Asia-Pacific).

- `GET /api/zrl` is public: the round, the demand per region (riders, teams, places still to fill) and the sign-up pool. Comments, Zwift IDs and preferred team are staff-only.
- `POST /api/zrl/signup` and `/withdraw` use `identify`, so a signed-in member can only sign themselves up. At least one time zone is required when racing; category defaults to the rider's profile category.
- Staff only: `POST /api/zrl/round` (starts a round, archives the previous one, keeps the teams, posts "sign-ups open" to Discord), `/status` (open or closed, published) and `/teams` (replace the team list).
- `POST /api/zrl/import {tab, apply, regions}` (staff) reads the team board tab of the club Google Sheet: one block of columns per team (zone or colour label, name, "Division n", grade, a Rider header row, one rider per row; blocks differ in width). Without `apply` it returns a preview; with it, teams and rosters (`cg:zrl:assign`) are replaced and riders without a sign-up get one. Missing Zwift IDs are filled from the club roster by exact name. The board's EMEA/AMERICAS labels give a time zone; colours do not, so staff pick those. Teams may carry `division` and `grade`.
- `POST /api/zrl/import-signups {tab, sheet, apply}` (staff) reads the form responses tab (one row per submission): Zwift ID from the ZwiftPower link, else a bare number, else the club roster by name; the latest row per rider wins. Time zones come from the primary and backup league labels (words like EMEA/Americas, else the UTC race time read as a local evening, else the colour). A rider's own sign-up on the page is never overwritten; sheet-made entries (`source: 'sheet'`) are refreshed. Staff also see the league, commitment (`commit`), previous team (`prevTeam`) and `source`. Sheet tabs are read with `fetchGrid`, which cannot tell an unknown tab name from the first tab (Google answers both the same), so each importer checks the layout it expects.
- `POST /api/zrl/auto-assign {apply}` (staff) suggests, or with `apply` makes, a team for every rider racing who has none (`planAssignments`, a pure function). Rules: a rider may ride their own category or a weaker one (team category = the last letter of its grade); the team must be in one of the rider's time zones and have a free place (10); full-season riders before reserves, those who named a team first, then first come; each goes to the eligible team nearest to full so teams complete, a close category match breaking ties; a captain-minded rider becomes the captain of a team that has none. Riders who cannot be placed are listed with the reason. `POST /api/zrl/assign {key, team}` (staff) moves one rider, or takes them off with an empty team.\n- `GET /api/zrl/export` (staff) builds the registration list for WTRL (which has no public sign-up, so captains register by hand): per team a readable block (name, division, grade, time zone, captain, numbered riders with Zwift ID and category), a plain list of Zwift IDs, the problems (no captain, not 10 riders, missing IDs or categories), riders with no team, and one CSV. CSV cells that start with `=`, `+`, `-` or `@` are prefixed with an apostrophe so a name can never run as a spreadsheet formula.\n- `GET /api/zrl/mine` (signed-in member) is the rider's own view: their sign-up, their team once `published` (names and categories only), and, if they are a team's captain, that team straight away with Zwift IDs, the registration text and the problems to sort out (`myZrl`). Comments, other teams and other riders' IDs never appear. The ZRL page shows it above the sign-up card.\n- Publishing (`POST /api/zrl/status {published: true}`, with a 📣 Publish rosters button in the staff panel) lets riders see their team and, the first time per round (claimed in `cg:zrl:sent` as `<round id>:published`), posts "the rosters are out" to the club channel (counts per time zone, where to look; no rider names) and a to-do list to the admin channel (teams without a captain or short of riders, riders without an ID or team). `announce: false` publishes silently and does not use up the announcement.\n- `runSchedule` (called from `/api/cron/tick` and when the page loads) posts a reminder 24 hours before sign-ups close and closes the round at the deadline. Both are claimed once in `cg:zrl:sent`.

## System health

`GET /api/health` (admin only) powers the **System health** section of the Admin dialog. It reports status (ok / warn / fail / info) for shared storage, WordPress member records, the club roster copy, the Google Sheet, Discord webhook configuration, the TTT week (including a missing close time), scheduled runs, member sign-in, guest sign-ups, staff passwords and the deployed commit. It only reports whether things are set and reachable, never values. It does not post to Discord or call the rate-limited roster source. The workflow's last run comes from `cg:cron:last`, written by every `/api/cron/tick`.

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

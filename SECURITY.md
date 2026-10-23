# Security and robustness review

A review of the dashboard (`api/server.js`, `lib/*.js`, `public/index.html`, `vercel.json`) before the season, October 2026. It lists what was checked, what was fixed, and the few things that are decisions for the club rather than code.

## Fixed in this review

| Area | Problem | Fix |
|---|---|---|
| Staff login | Nothing limited password guessing: an unlimited number of tries per second. | After `LOGIN_MAX_FAILS` (default 10) wrong passwords from one connection in 15 minutes, every attempt from it gets `429` (even the right password), until the window passes. A right password never counts. Counters are in Redis, so all server instances share them. |
| Write flood | Guests and riders could post sign-ups, RSVPs and volunteer offers as fast as a script could send them, filling Redis and the Discord channels. | Anyone who is not staff is limited to `RATE_LIMIT_WRITES_PER_MIN` (default 120) writes a minute per connection. Staff and reads are not limited. |
| Stored markup | Rider names from the roster were put into the Members table, the name search and the profile page without escaping. A member who could set a name with HTML in it could run script in an admin's browser. | Every name that becomes markup goes through `esc()`. A test now fails if a name or title is interpolated into markup unescaped. |
| Ride cover privacy | The cover view sent every volunteer's Zwift ID and the ride owner's Zwift ID to every signed-in rider. | Riders get names and a `mine` flag. Staff still get the IDs (they need them to assign cover). |
| Storage hangs | A stuck call to Redis held the request until the platform killed it. | Redis calls time out after 8 seconds and answer 504 or 502 with a plain message. |
| Headers | No `X-Content-Type-Options`, `Referrer-Policy` or `Permissions-Policy`; the service worker could be cached. | Added in `vercel.json`; `/sw.js` is `no-cache` so updates reach phones promptly. |

## Checked and found fine

- **Sessions.** Tokens are HMAC-signed with a constant-time compare, expire after 12 hours, and a member session can never act as staff. Changing a password (or `SESSION_SECRET`) signs everyone out.
- **Passwords and the cron secret** are compared with a constant-time hash compare.
- **Single sign-in.** The hand-off token travels in the URL *fragment* (never sent to a server), is single-use (`SET NX`, 15 minutes) and is removed from the address bar on arrival.
- **Request bodies** are capped at 20 000 characters; malformed JSON is a 400; unexpected errors answer a generic 500 and are logged without being shown to the caller.
- **Outbound fetches.** The ZwiftRacing lookups use fixed hosts and numeric ids; the Google Sheet id is URL-encoded and the host is fixed; the calendar import is admin-only, https-only, refuses IP addresses and local names, refuses redirects, times out and caps the size.
- **CSV exports** neutralise cells that look like formulas. **Discord posts** turn all mentions off, so rider text cannot ping `@everyone`.
- **Backups and restore** are admin-only; a restore needs the word RESTORE and takes a safety copy first.
- **Dependencies.** There is no `package.json` and no third-party packages: nothing to go out of date, nothing in the supply chain.
- **Secrets** are only ever read from environment variables; none are in the repository or the page, and a test guards the page against credentials.

## Decisions for the club (not changed, because changing them could break something you use)

1. **`REQUIRE_MEMBER_LOGIN=1`.** Until it is set, anyone using the name picker can sign up, withdraw or RSVP as any rider. The health panel already flags it. Turn it on once every rider can sign in with their cryogen.team account.
2. **CORS is open (`Access-Control-Allow-Origin: *`).** The API uses a Bearer token in a header, not cookies, so another website cannot use a visitor's session, and the open setting is what lets cryogen.team call it if it ever does. If nothing on another domain calls the API, restricting it to `https://club.cryo-gen.team` is safe and tightens things.
3. **No Content-Security-Policy and no clickjacking header.** The dashboard is one page with inline scripts and handlers, so a useful CSP needs a rewrite. A `frame-ancestors` rule would stop other sites framing the dashboard, but it would also stop cryogen.team embedding it if it does; say if you embed it and I will add the right list.
4. **Zwift IDs in the public ZRL view.** Sign-up rows carry the rider's Zwift ID as their key. Zwift IDs are visible on ZwiftPower anyway, so this is low risk.
5. **Sessions cannot be revoked one by one**, only all at once by changing a password or `SESSION_SECRET`. Set a `SESSION_SECRET` (the health panel notes when it is missing) so a password change is not the only way to sign everyone out.
6. **Rotate secrets when a person with access leaves**: the staff passwords, `CRON_SECRET`, the Discord webhook URLs, the WordPress application password and the Redis token. A downloaded backup contains rider names and Zwift IDs: keep it somewhere private.

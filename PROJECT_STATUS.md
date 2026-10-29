# Project status

## Fixed
- Admin and moderator passwords were moved out of the page source into server-side environment variables (#3).
- The proxy no longer accepts arbitrary `url=` targets (#3).
- `api/server.js` now exports a handler, so it runs on Vercel (#3).
- Sign-ups, series locks, created rides and RSVPs are shared through the server instead of each browser's `localStorage`. Staff-only actions need a signed login token.
- The sheet reader now returns the JSON shape the page expects, using the club sheet ID.
- The broken duplicate dashboard (`api/api/proxy.html`) was removed.
- Cross-origin API writes are rejected; the configured site origin is used for CORS.
- Roster responses report freshness, and the dashboard no longer shows hard-coded sample riders as live data.
- The member calendar subscription was already available; its settings UI is now an extracted browser module.
- Role checks are enforced at API routes and covered across representative feature areas.

## Known issues

### Security
- **Guest write access depends on deployment configuration.** Production is documented as using `REQUIRE_MEMBER_LOGIN=1` in `OPERATIONS.md`; verify the live Vercel Production value remains enabled. In environments where it is unset, guests can act as another rider.
- **The non-WordPress fallback sends placeholder Basic auth credentials.** Real credentials must never go in this file.
- **The old admin and moderator passwords are still in git history.** They must not be reused.

### Functionality
- **The TEAM LIST tab must not be the first tab of the Google Sheet.** Google answers an unknown tab name with the first tab, and the server detects a missing tab by comparing against a deliberately fake name. If the named tab were itself first, the two answers match and the dashboard reports "no tab named …". (Pinned by a test.)
- **`schema.sql` is empty.**

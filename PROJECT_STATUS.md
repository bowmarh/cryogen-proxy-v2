# Project status

## Fixed
- Admin and moderator passwords were moved out of the page source into server-side environment variables (#3).
- The proxy no longer accepts arbitrary `url=` targets (#3).
- `api/server.js` now exports a handler, so it runs on Vercel (#3).
- Sign-ups, series locks, created rides and RSVPs are shared through the server instead of each browser's `localStorage`. Staff-only actions need a signed login token.
- The sheet reader now returns the JSON shape the page expects, using the club sheet ID.
- The broken duplicate dashboard (`api/api/proxy.html`) was removed.

## Known issues

### Security
- **Roles are partly enforced in the browser.** Staff-only shared-data actions are checked on the server. The admin view itself, and anything that writes to WordPress, still relies on the WordPress API's own auth.
- **Anyone can cancel anyone's RSVP** (same as before). Members aren't authenticated.
- **The non-WordPress fallback sends placeholder Basic auth credentials.** Real credentials must never go in this file.
- **The old admin and moderator passwords are still in git history.** They must not be reused.

### Functionality
- **Member login only searches the live roster once it has loaded.** Before that it falls back to the small `MOCK` list.
- **`schema.sql` is empty.**

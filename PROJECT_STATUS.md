# Project status

## Fixed
- Admin and moderator passwords were moved out of the page source into server-side environment variables (#3).
- The proxy no longer accepts arbitrary `url=` targets (#3).
- `api/server.js` now exports a handler, so it runs on Vercel (#3).

## Known issues

### Security
- **Roles are only enforced in the browser.** The password check now runs on the server (`/api/login`), but anyone can still switch to the admin view in devtools. Real protection must come from the WordPress API, which handles every write.
- **The non-WordPress fallback sends placeholder Basic auth credentials.** Real credentials must never go in this file.
- **The old admin and moderator passwords are still in git history.** They must not be reused.

### Functionality
- **Shared data is stored per browser.** Sign-ups and RSVPs are saved to `localStorage`, so other members and admins don't see them. They need a shared store, such as the WordPress API.
- **`ENDPOINT_MAP` still has placeholder Google Sheet IDs** (`YOUR_SHEET`), so `/api/proxy?endpoint=rides` and `ttt-sheet` don't work yet.
- **There are two copies of the dashboard** (`public/index.html` and `api/api/proxy.html`) and they have drifted apart. Keep one.
- **`schema.sql` is empty.**

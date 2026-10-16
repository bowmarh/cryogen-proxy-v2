# Project status

## Known issues

### Security
- **Admin and moderator passwords are hardcoded in the page's JavaScript.** Anyone can read them with "View source", and this repository is public. Treat them as known: change them, and move the checks to the server (for example, WordPress login or roles).
- **The proxy accepts any `url=` parameter**, so anyone can use the deployment as an open proxy. Limit it to the named `endpoint` values.
- **The non-WordPress fallback sends placeholder Basic auth credentials.** Real credentials must never go in this file.

### Functionality
- **Shared data is stored per browser.** Sign-ups and RSVPs are saved to `localStorage`, so other members and admins don't see them. They need a shared store, such as the WordPress API.
- **`ENDPOINT_MAP` still has placeholder Google Sheet IDs** (`YOUR_SHEET`), so `/api/proxy?endpoint=rides` and `ttt-sheet` don't work yet.
- **`api/server.js` may not run on Vercel as written.** It calls `server.listen()`, but Vercel functions expect an exported `(req, res)` handler.
- **There are two copies of the dashboard** (`public/index.html` and `api/api/proxy.html`) and they have drifted apart. Keep one.
- **`schema.sql` is empty.**

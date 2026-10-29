# Security and robustness status

Updated 28 October 2026. This summarizes the controls in the dashboard and the remaining operational decisions; it is not a substitute for checking live Vercel settings.

## Controls

- Staff sessions are HMAC-signed, expire after 12 hours, and member sessions cannot act as staff. Password changes invalidate existing sessions when `SESSION_SECRET` is derived from those passwords.
- Staff login attempts and non-staff writes are rate-limited through shared Redis counters.
- Staff-only operations are guarded by server-side role checks. Hiding a tab in the browser is not the authorization boundary.
- Requests with an `Origin` header that mutate data must match the configured `SITE_URL` origin. API preflights advertise only that origin. Safe GETs remain usable by external calendar clients.
- Request bodies are capped at 20,000 characters; malformed JSON is rejected. Unexpected server errors are logged and returned as generic errors.
- Outbound fetches use fixed or validated destinations, timeouts and size limits. Calendar import is admin-only and rejects unsafe destinations and redirects.
- CSV exports neutralize formula-like cells, Discord posts disable implicit mentions, and rider data exposed to the browser is limited to the fields the dashboard uses.
- Backups and restores are admin-only; a restore requires typed confirmation and creates a safety copy first.
- The server uses Node's built-in modules. Playwright is a development-only dependency for browser tests.
- Secrets are read from environment variables, not the dashboard source. A downloaded backup contains rider names and Zwift IDs and should be stored privately.

## Operational follow-ups

1. **Keep `REQUIRE_MEMBER_LOGIN=1` explicitly configured in Vercel Production.** The server also requires member sign-in automatically in Vercel Production if the flag is missing. In other environments, name-picker users can act as another rider unless the flag is enabled.
2. **Rotate exposed historical credentials.** Old admin and moderator passwords remain in Git history and must never be reused. Rotate current staff passwords, `CRON_SECRET`, Discord webhooks, the WordPress application password and Redis token when access changes.
3. **Set `SESSION_SECRET` explicitly** if staff sessions should remain invalidated independently of password changes. Changing it signs out all current sessions; individual session revocation is not supported.
4. **Review framing and CSP separately.** The dashboard still contains inline scripts and event handlers. A strict Content-Security-Policy needs a larger frontend refactor. Confirm whether another site embeds the dashboard before adding a `frame-ancestors` restriction.
5. **Public ZRL data includes Zwift IDs.** These are visible on ZwiftPower, but confirm that this remains acceptable for the club.

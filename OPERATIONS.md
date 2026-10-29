# Operations runbook

## Repair notification delivery

Webhook URLs are secrets. Edit them in Vercel Project Settings → Environment Variables, scoped to **Production**; do not put their values in Git, issues, or chat.

1. Replace `DISCORD_WEBHOOK_PUBLIC` and `DISCORD_WEBHOOK_ADMIN` with the correct Discord channel webhook URLs. If a webhook was exposed, revoke it in Discord and create a replacement first.
2. Check `RIDE_COVER_WEBHOOK_URL` in the same way. It must be an HTTPS endpoint that accepts the application's JSON body (`source`, `channel`, `text`, `kind`) and returns a 2xx response. A rejected/non-2xx request falls back to the relevant Discord webhook.
3. Redeploy after editing production variables. Confirm delivery using the admin **System health** panel and a low-impact, planned notification. Do not send test messages to a live channel without coordinating with its members.
4. Review Vercel runtime errors for `/api/server`. Historical webhook errors remain visible for their retention period; use the last-hour window to confirm whether new errors continue.

The health panel intentionally does not send test messages. It also must not reveal environment-variable values.

## Reliable 15-minute scheduler

The GitHub Actions schedule and the daily Vercel Cron are fallbacks; GitHub may delay scheduled jobs in quiet repositories. For dependable frequent runs, configure an Upstash QStash schedule:

- **Destination:** `https://club.cryo-gen.team/api/cron/tick`
- **Schedule:** `*/15 * * * *`
- **HTTP method:** `POST` (the endpoint accepts both GET and POST)
- **Forwarded destination header:** `Authorization`, with `Bearer` followed by the existing production `CRON_SECRET` value.

Set the forwarded header in the QStash dashboard as a protected header. Do not copy the secret into this repository or share it in chat. The endpoint rejects requests without the matching bearer token. Keep the existing daily Vercel Cron and GitHub Actions workflow as backup triggers; scheduled events are idempotently claimed in shared storage.

After enabling the schedule, confirm the admin health panel's **Scheduled runs** timestamp advances about every 15 minutes. Check Vercel runtime errors if it does not. The API function is configured with a 60-second maximum duration; Vercel plan limits still apply.

## Access control

Production should keep `REQUIRE_MEMBER_LOGIN=1` explicitly configured for visibility. The server also enforces member sign-in automatically whenever `VERCEL_ENV=production`, so a missing flag does not reopen guest sign-ups, withdrawals, or RSVPs. Member-facing access control and staff roles must also be enforced by server routes, not only hidden or disabled in the browser.

`SITE_URL` must match the public portal's origin (default `https://club.cryo-gen.team`). Browser API mutations from other origins are refused; external calendar clients can still fetch a member's private `.ics` link.
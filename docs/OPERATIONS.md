# Operating the club app

## After every deploy: the smoke test
`.github/workflows/smoke.yml` runs after each successful **Production** deploy. It calls `POST /api/smoke` (same `CRON_SECRET` as the schedule) and the app checks itself: storage, every system in the Control room, the monthly PDF, the public race data and the key page files. If anything fails the workflow goes red (GitHub emails you) and the admin Discord channel is told. You can also run it by hand: GitHub → Actions → *Post-deploy smoke test* → Run workflow.

## Staging (safe previews)
A Vercel **preview** deployment never sends real email or posts to the club's Discord (it is switched off in code), and the Control room says so. To let a preview send for real while you test, set `ALLOW_OUTBOUND=1` on that preview only. Use a separate Upstash database for previews if you want them to have their own data (give the Preview environment its own `UPSTASH_REDIS_REST_URL/TOKEN`); otherwise a preview reads the same data as production, so do not enter real changes in a preview.

## Supporter payments (Stripe)
Off until these are set in Vercel (Production): `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (a recurring monthly price), `STRIPE_WEBHOOK_SECRET`.
1. In Stripe create a recurring monthly Product and copy its Price ID (`price_…`).
2. Developers → Webhooks → add an endpoint `https://club.cryo-gen.team/api/stripe/webhook` for the events `checkout.session.completed`, `customer.subscription.deleted` and `invoice.payment_failed`; copy its signing secret (`whsec_…`).
3. Redeploy. Members then see **Become a supporter** in the AI coach; paying adds them to the supporter list, cancelling removes them, and the admin channel is told of each. Card details never touch this app. The old manual payment link still works when Stripe is not set.

## Audit trail
Control room → **Audit** (admins): who changed what and when (email, AI desk, joins, autopilot, go-live, supporters, privacy, ZRL line-ups and results). It records the action, never the contents. Members can already download or ask to erase their own data from their profile; erase requests appear under Investigations → Privacy requests.

## Push notifications and calendars
Members who have not linked Discord still get availability asks and line-up news if they have switched on notifications in the installed app (My Profile): the automatic messages fall back to web push. Every rider can also subscribe to a private calendar feed (My Profile → calendar) for their races and rides.

## Ride-cover webhook
`RIDE_COVER_WEBHOOK_URL` may be a Zapier/Make webhook or a Discord webhook address. A Discord address is sent as a plain message.

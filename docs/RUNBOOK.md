# Club runbook

For the people running CRYO-GEN week to week. Everything marked **automatic** happens without anyone pressing a button; your job is to look at the few things that need a person.

## Before the season (once)

1. Admin → **🚦 Go-live checklist**. Work down the "to do" items; each says what to do next.
2. Admin → **System health** should show no ❌.
3. Admin → Staff accounts: give each person their own login.
4. Name a captain on each Ladder and DIRT team (👑 Captains).
5. Try it all first on the staging copy (see [Practice copy](#practice-copy-staging)).

## Race week

| When | What happens (automatic) | What you check |
|---|---|---|
| Sign-ups close | ZRL teams are suggested and the admin channel is told | Skim the suggestions; the readiness card at the top of the ZRL tab lists the rest, and **Fix everything** applies what can be fixed in one click |
| Early in the week | Availability questions go to riders (Discord buttons or notifications) | "Who has not answered" in the ZRL line-ups; the reminder goes out by itself |
| A day before | Line-ups filled from the answers; Ladder/DIRT starters picked | Anything listed under "left for you" (usually: not enough riders) |
| Race day | Check-in, no-show alerts, replacements offered | The admin channel; tap through only if it asks |
| After | Results imported; sheets updated; thank-you and win-back messages | Results look right; sheet tab updated |

The **This week** page shows all of this for the next seven days. The automatic-actions list on the This week page shows what the system did, with an Undo for most.

## When something looks wrong

1. Admin → System health: read the red or amber line, it says what to do.
2. This week → the automatic-actions list: find the action and press **Undo** if it was wrong.
3. Admin channel in Discord: "🧯 Unexpected error" means a bug; it posts at most once an hour per problem. Send the message to the developer.
4. Uptime: the GitHub "Uptime check" workflow emails the repository watchers when the site stops answering `/api/ping`.

## Backups and restore

Daily backups run on their own, and once a week one is test-restored to prove it works. To restore: Admin → Backups → pick a copy → Restore (type RESTORE). A safety copy of the current data is kept first.

## Turning things on or off

- Automatic messages: Comms. Morning digest and public club page: This week. ZRL automatic placement: the ZRL tab's automatic settings.
- Everything automatic respects each rider's opt-outs.

## Practice copy (staging)

A second Vercel project from the same repo, with its **own** Upstash database and a **test** Discord server:

1. Create the Vercel project, connect the repo, add an Upstash Redis integration (a new database, never the real one).
2. Set the same variables as production, but with test values: `STAGING=1`, test Discord webhooks and bot, no `ZWIFTRACING` writes needed, a different `SITE_URL`, a different `CRON_SECRET`.
3. Open the site: a yellow **STAGING** bar shows, and every Discord post is tagged `[STAGING]`.
4. Admin → Go-live checklist → **🧪 Fill with test data** makes a ZRL round with 2 teams and 10 made-up riders.
5. Try sign-ups closing, fixes, line-ups, undo. Nothing touches the real club.

## Things only a person can do

- Name captains, approve sign-ups, decide edge cases the system lists under "left for you".
- Add keys in Vercel (Discord, Google, Anthropic, push keys). The assistant never handles secrets.
- Share each Google Sheet with the service account's email.

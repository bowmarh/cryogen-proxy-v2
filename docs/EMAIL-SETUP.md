# Email setup (members, groups, newsletters, reminders)

The **✉️ Email** page (staff only) writes, checks and sends email to members. Addresses come from your **WordPress user accounts** at cryogen.team; nothing is stored outside the club's own database except opt-outs.

Nothing is sent until an administrator switches email **on** under *Email → Settings & automatic*.

## 1. Connect the sending service (Vercel environment variables)

Add these in Vercel → Project → Settings → Environment Variables, then redeploy. Never paste them in chat.

| Variable | What it is |
|---|---|
| `HOSTINGER_MAIL_TOKEN` | API token from hPanel → Emails → (your mailbox) → API access |
| `HOSTINGER_MAIL_MAILBOX_ID` | The mailbox's resource ID (the `resourceId` Hostinger shows for the mailbox) |
| `HOSTINGER_MAIL_BASE` | Optional. Only if Hostinger gives a different API address |

Use **Email → Settings → Send me a test** (administrators) first: it sends through the real service and shows Hostinger's own error if it refuses. If the test fails, send me the exact error text.

To use **Resend** instead (better for large lists): set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS` (an address on a domain you verified in Resend).

## 2. WordPress access to the user list

The app reads `wp/v2/users` with the same WordPress login it already uses for member data. That account must be an **Administrator** (it needs the `list_users` permission). If not, the page says "not allowed to list users".

Members are matched to WordPress users **by name**. Only a unique match is used. Where two WordPress users share a name, or none is found, they appear under *Review addresses* and an administrator types the right address once.

## 3. DNS records for cryogen.team (so mail is not marked as spam)

In Hostinger (or wherever the DNS for cryogen.team is managed) check these exist for the sending domain:

- **SPF** (TXT on the domain): includes Hostinger's mail servers, e.g. `v=spf1 include:_spf.mail.hostinger.com ~all`
- **DKIM**: the CNAME/TXT records hPanel shows under the mailbox's domain settings
- **DMARC** (TXT on `_dmarc`): start with `v=DMARC1; p=none; rua=mailto:<club address>`

Hostinger's mail section shows each record to copy and a "verified" tick.

## 4. Limits, honestly

A mailbox is not a bulk-mail service. The app therefore sends **a few per hour and a day (default 30 an hour, 200 a day)** and spreads a big send over days. Set the limits to what Hostinger allows for your plan. For a full-club newsletter every week, a bulk service (Resend, Brevo) is the better fit; switching is only the variables above.

If the service keeps refusing, the send **pauses**, the admin Discord channel is told, and an administrator presses Resume.

## 5. Consent and unsubscribe

- Every email carries an unsubscribe link (in the footer; the Hostinger mailbox API cannot add a List-Unsubscribe header).
- **Club news** can be unsubscribed from; **service** emails (race info, reminders) continue unless the member chooses *Stop all emails*.
- Opt-outs are kept as a one-way hash of the address, and are honoured on every send, automatic or manual.

## 6. Automatic emails (all off by default)

- **Weekly newsletter**: drafted Monday morning (UK) from the week's fixtures and results, using the AI when it is switched on. Either an administrator approves it, or it sends itself only if it passes every check.
- **Welcome email** to new members.
- **Win-back note** to quiet members, at most once every 60 days each, ten per run.

## 7. The AI

The AI drafts with `{first}` in place of names (**no member names or addresses are sent to it**) and a second AI pass checks the wording; fixed rules (unfilled placeholders, insecure links, spam phrases, shouting) always run even if the AI is off. Editing an email clears its check, so what is approved is exactly what was checked.

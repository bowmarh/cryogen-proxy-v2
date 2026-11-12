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

**If WordPress still refuses** (the page says "rest_user_cannot_view" or similar even though the account is an Administrator), a security plugin or the host is blocking the standard users list. Add this once with the *Code Snippets* plugin (or your theme's functions.php); the app tries it automatically:

```php
add_action('rest_api_init', function () {
  register_rest_route('cryogen/v1', '/user-emails', [
    'methods' => 'GET',
    'permission_callback' => function () { return current_user_can('list_users'); },
    'callback' => function () {
      $out = [];
      foreach (get_users(['fields' => ['ID', 'display_name', 'user_email']]) as $u) $out[] = ['id' => $u->ID, 'name' => $u->display_name, 'email' => $u->user_email];
      return $out;
    },
  ]);
});
```

It is read-only and only an account that is allowed to list users can call it.

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

## 8. Replies to club emails (reply triage)

Staff can paste a reply into **AI desk → Replies** to have it sorted into question, opt-out, complaint or other. Opt-outs unsubscribe the sender from all emails immediately; complaints alert the admin Discord channel; questions get a suggested reply for you to send.

To have replies arrive automatically, set `MAIL_INBOUND_SECRET` in Vercel and point the mail provider's webhook (or a forwarding rule) at `POST https://<your site>/api/mail/inbound` with header `X-Inbound-Secret: <the secret>` and a JSON body `{ "from": "...", "subject": "...", "text": "..." }`. Without the secret the endpoint refuses everything.

## 9. One-tap availability, season reports, the join page and the watchdog

- **Ask a team for availability:** AI desk → Radio & reports → pick the team and race → *Ask for availability*. It makes a draft in Email whose message holds each rider's own one-tap link (`{rsvp}` is filled in per rider). Open the draft, run the check and approve it. The link opens a page with Yes / Maybe / No buttons; the answer is recorded only when a button is pressed and shows on the ZRL page for the captain.
- **Season so far:** same place, *Season so far* previews a team's summary (all races entered), and an administrator can email it to the team. With *email each team automatically* on, it is sent once when a team's results are complete.
- **Join page:** share `https://<your site>/join.html`. Requests wait in **Control room → Join requests**; an administrator sends the welcome email (or declines). It does not create a WordPress account: add the person in WordPress too.
- **Watchdog:** the hourly job checks storage, email, member addresses, Google and the AI and posts to the admin Discord channel when something goes red, once per change, and again when it recovers.

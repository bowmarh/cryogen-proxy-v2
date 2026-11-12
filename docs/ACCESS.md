# Who can do what

Seven levels. The rules live in one place (`lib/access.js`) and the server enforces them; the Control room → **Access** tab shows this table and each member's type.

## Staff (sign in with a password)

| Level | Who | In one line |
|---|---|---|
| **Owner** | You. Signs in with `OWNER_PASSWORD` (the 👑 *Owner* button on the sign-in page). | Everything. |
| **Administrator** | Trusted club officers (`ADMIN_PASSWORD`, or a personal staff login with the Administrator role). | Runs the club day to day. Cannot touch the owner-only list. |
| **Moderator** | Helpers (`MOD_PASSWORD`, or a personal staff login with the Moderator role). | Looks after things; cannot send, decide or change settings. |

### Owner-only (an Administrator gets "Only the owner can do this.")
- **Backups and data:** make, download and restore a backup; erase a member's data.
- **Money and budgets:** the supporter list, prices, the AI budget, Stripe.
- **Access:** staff accounts (who is an Administrator or Moderator), member-type overrides, the audit trail.
- **The switches:** email on/off and its limits, the race radio, race-week autopilot, automatic results, progress cards.

### Administrator (and the Owner)
Approve and send emails; decide join requests; apply proposed line-ups; send team reports; plus everything a Moderator can do.

### Moderator (and above)
Control room (race day, systems, go-live check, feedback, usage); draft and check emails and use the AI desk; enter ZRL results and line-ups; edit members; fair-play tools; triage feedback.

## Members (sign in with a cryogen.team account)
A member has one **type**, worked out automatically each hour. The Owner can override one member's type (Control room → Access).

| Type | Who | What they get |
|---|---|---|
| **Social** | Associates | The weekly TTT and ZRL sign-ups, social rides, their own upgrade page, feedback, invite a friend, their own data. No racing pages, no AI coach, no racing messages. |
| **Standard** | Full members who are not racing right now (no ZRL team, no race in 90 days) | Every member page (Racing, TTT Season, Ladder, DIRT Series, member list), the AI coach, their season, calendar and badges. They can still sign up for anything, which is how they become Racing. |
| **Racing** | Full members on a ZRL team, or who raced in the last 90 days | Standard, plus the racing messages: availability asks, line-up news, monthly progress cards. |
| **Captain** | Any full member who captains a ZRL team | Their type's access plus **🧢 My team**: their own team's answers, asking the unanswered, proposing and setting the line-up. Only their own team. |

The header badge shows the real level ("Owner", "Captain · Racing", "Social" …); hover it to see how the type was worked out.

## Setting up the owner login
1. In Vercel add `OWNER_PASSWORD` (a long password only you know) and redeploy.
2. Sign in with 👑 **Owner**. Changing `OWNER_PASSWORD` signs the owner out everywhere.
3. **Until `OWNER_PASSWORD` exists, every Administrator keeps the owner's powers** so nothing is locked out; the Control room's Systems list shows an amber *Owner login* row until you add it.

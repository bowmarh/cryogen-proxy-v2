# Comms Studio: set up each platform

Written step by step for someone who has never done it before. The same guide, with a "Test the connection" button on each platform, is inside the app under Studio.

## First, how to add a value in Vercel (every platform with a key needs this)

1. Open vercel.com and sign in, then open the project called cryogen-proxy-v2.
2. Click Settings (along the top), then Environment Variables (on the left).
3. For each value below: type the Name exactly as written, paste the Value, tick Production, and click Save.
4. Important: a new value only starts working after a new deployment. Click Deployments (along the top), click the three dots (…) on the newest one, choose Redeploy, then Redeploy again. Wait for it to say Ready (about a minute).
5. Come back here and press "Test the connection".

## Telegram

**The app posts** · about 10 minutes · values to add in Vercel: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Posts to a Telegram channel or group. Free, and the easiest one to start with.

1. On your phone or computer open Telegram and search for @BotFather (it has a blue tick). Open it and press Start.
2. Send the message /newbot. When asked, type a name for the bot (for example CRYO-GEN News), then a username that ends in "bot" (for example cryogen_news_bot).
3. BotFather replies with a long token that looks like 123456789:ABCdef… Copy it. That is your TELEGRAM_BOT_TOKEN. Keep it private: anyone with it can post as the bot.
4. Create the place to post: in Telegram choose New Channel (people read, only you post) or New Group. Give it a name. For a channel, make it Public and choose a short address such as cryogen_club.
5. Add the bot to it: open the channel, tap its name, choose Administrators, Add Administrator, search for your bot, and make sure "Post Messages" is ticked. For a group, add the bot as a member and make it an admin.
6. Find the chat ID. For a PUBLIC channel it is the address with an @ in front, for example @cryogen_club. For a private channel or a group: post any message in it, then open this address in your browser, replacing TOKEN with your token: https://api.telegram.org/botTOKEN/getUpdates. Find "chat":{"id":-100123456789 and copy the number including the minus sign.
7. That is your TELEGRAM_CHAT_ID.

## Bluesky

**The app posts** · about 5 minutes · values to add in Vercel: `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`

Posts to the club's Bluesky account. Free.

1. Create the club account at bsky.app if you do not have one yet, and sign in.
2. Click your profile picture or the menu, then Settings, then Privacy and security, then App passwords.
3. Click Add App Password, call it CRYO-GEN Studio, and click Create. Copy the password that appears (four groups of letters like abcd-efgh-ijkl-mnop). You cannot see it again. This is NOT your normal password: never use that.
4. BLUESKY_APP_PASSWORD is that app password.
5. BLUESKY_HANDLE is the account name without the @, for example cryogen.bsky.social.

## Website (cryogen.team)

**The app posts** · about 5 minutes

Creates a post on the club website. It uses the WordPress login the app already has for member records.

1. Nothing to add in Vercel if members already load: the app already has WP_API_USER and WP_API_APP_PASSWORD.
2. That WordPress user must be allowed to write posts. In WordPress go to Users, find that user, and make sure their Role is Author, Editor or Administrator (not Subscriber).
3. Press "Test the connection". It checks the login and that it may create posts.
4. By default posts are saved as DRAFTS on the website so you can look before they go live. To publish at once, open the Studio settings and set "Website posts are" to published at once.

## Facebook Page

**Through Zapier (or Make)** · about 20 minutes · values to add in Vercel: `STUDIO_HOOK_FACEBOOK`

Posts to the club's Facebook Page. Zapier does the Facebook part, so there is no Facebook developer set-up or review.

1. You need a Facebook PAGE for the club (not a personal profile) and to be its admin.
2. Go to zapier.com and sign in or create a free account.
3. Click Create, then Zap. For the trigger, search for "Webhooks by Zapier" and choose the event "Catch Hook". Click Continue. Skip the optional child key.
4. Zapier shows a Custom Webhook URL (it starts with https://hooks.zapier.com/). Copy it. That is your STUDIO_HOOK_FACEBOOK. Do not click Test trigger yet.
5. Add the value in Vercel (steps below) and Redeploy.
6. Back here, press "Test the connection". That sends a sample post to Zapier so it can see the fields.
7. In Zapier click Test trigger / Find new records. You should see fields called text, imageUrl, title, link. If you do not, wait ten seconds and try again.
8. Add the action: search for "Facebook Pages" and choose "Create Page Post". Connect your Facebook account when asked and choose the club Page.
9. For Message choose the "text" field from step 1. For Link choose "link". (If you want the picture too, use the action "Create Page Photo" instead and use "imageUrl" as the Photo URL.) Click Continue, Test, then Publish the Zap.
10. Done. From now on, ticking Facebook when you approve a post sends it to your Page.

## Instagram

**Through Zapier (or Make)** · about 25 minutes · values to add in Vercel: `STUDIO_HOOK_INSTAGRAM`

Posts a picture with a caption to the club's Instagram. Instagram always needs a picture, so make the picture card in the Studio first.

1. The club Instagram must be a Business or Creator account (Instagram: Settings, Account type and tools, Switch to professional account), and linked to the club's Facebook Page (Instagram: Edit profile, Page).
2. In Zapier create a second Zap: trigger "Webhooks by Zapier", event "Catch Hook". Copy its Custom Webhook URL. That is your STUDIO_HOOK_INSTAGRAM.
3. Add the value in Vercel (steps below) and Redeploy.
4. Press "Test the connection" here, then in Zapier press Test trigger. You should see the fields text and imageUrl.
5. Add the action: search "Instagram for Business" and choose "Publish Photo". Connect the account. Set Photo URL to the "imageUrl" field and Caption to the "text" field. Test and Publish the Zap.
6. Every time: in the Studio press "Make a picture card" on the post first, then tick Instagram when you approve. Without a picture the Studio will say so and send nothing.

## Zapier or Make: everything

**Through Zapier (or Make)** · about 10 minutes · values to add in Vercel: `STUDIO_HOOK_OTHER`

Optional. Sends every post, with all the wording for every platform, to one Zapier or Make link, so you can connect anything else (LinkedIn, X, Slack, a spreadsheet, a newsletter tool).

1. In Zapier (or Make.com: Webhooks, Custom webhook) create a Zap whose trigger is "Webhooks by Zapier" with event "Catch Hook". Copy the Custom Webhook URL. That is your STUDIO_HOOK_OTHER.
2. Add it in Vercel and Redeploy, then press "Test the connection" and Test trigger in Zapier. You will see a "variants" group with the text for each platform.
3. Add whatever action you like and use the matching text from "variants" (for example variants discord, variants bluesky, variants website title).

## Email

**By hand, or through Zapier** · about 10 minutes · values to add in Vercel: `STUDIO_HOOK_EMAIL`

Without any set-up the Studio writes the email for you and gives you a button that opens it ready to send. To send it automatically, use Zapier.

1. Nothing is needed to use it by hand: on a post, find the Email row, press "Open an email", add your recipients and send, then press "I have posted it".
2. To send automatically: in Zapier create a Zap with trigger "Webhooks by Zapier", event "Catch Hook". Copy the Custom Webhook URL. That is your STUDIO_HOOK_EMAIL.
3. Add it in Vercel and Redeploy. Press "Test the connection", then Test trigger in Zapier. You will see the fields subject and text.
4. Add the action "Gmail" (Send Email), "Microsoft Outlook" or your newsletter tool (for example MailerLite or Mailchimp "Add subscriber / Send campaign"). Use "subject" for the subject and "text" for the body.

## WhatsApp

**By hand** · about 1 minutes

WhatsApp does not allow apps to post into groups, so the Studio does the writing and you press send.

1. On a post, find the WhatsApp row and press "Open WhatsApp". Choose the group or person and press send.
2. Press "I have posted it" so the Studio knows.

## Strava club

**By hand** · about 2 minutes

Strava does not allow apps to post to a club, so the Studio gives you the text and a link to the club.

1. Open the Studio settings and paste your Strava club address (on Strava open the club and copy the address, it looks like https://www.strava.com/clubs/123456). Save.
2. On a post, find the Strava row: press "Copy the text", then "Open the Strava club", choose Posts, and paste.
3. Press "I have posted it".

## Discord

**The app posts** · about 0 minutes

Already set up: the Studio posts to the club channel with the same Discord link the rest of the app uses.

1. Nothing to do. Press "Test the connection" and a test line appears in the admin channel.

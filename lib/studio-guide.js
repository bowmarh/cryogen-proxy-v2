'use strict';
// The step-by-step set-up for each platform the Comms Studio can use, written for someone who has never done it before. The page shows it, a button on
// each platform tests the connection, and docs/STUDIO-SETUP.md is the same text (run `node lib/studio-guide.js` to rewrite it).
const VERCEL = [
  'Open vercel.com and sign in, then open the project called cryogen-proxy-v2.',
  'Click Settings (along the top), then Environment Variables (on the left).',
  'For each value below: type the Name exactly as written, paste the Value, tick Production, and click Save.',
  'Important: a new value only starts working after a new deployment. Click Deployments (along the top), click the three dots (…) on the newest one, choose Redeploy, then Redeploy again. Wait for it to say Ready (about a minute).',
  'Come back here and press "Test the connection".',
];
const GUIDE = [
  { id: 'telegram', title: 'Telegram', how: 'The app posts', minutes: 10, env: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], summary: 'Posts to a Telegram channel or group. Free, and the easiest one to start with.',
    steps: [
      'On your phone or computer open Telegram and search for @BotFather (it has a blue tick). Open it and press Start.',
      'Send the message /newbot. When asked, type a name for the bot (for example CRYO-GEN News), then a username that ends in "bot" (for example cryogen_news_bot).',
      'BotFather replies with a long token that looks like 123456789:ABCdef… Copy it. That is your TELEGRAM_BOT_TOKEN. Keep it private: anyone with it can post as the bot.',
      'Create the place to post: in Telegram choose New Channel (people read, only you post) or New Group. Give it a name. For a channel, make it Public and choose a short address such as cryogen_club.',
      'Add the bot to it: open the channel, tap its name, choose Administrators, Add Administrator, search for your bot, and make sure "Post Messages" is ticked. For a group, add the bot as a member and make it an admin.',
      'Find the chat ID. For a PUBLIC channel it is the address with an @ in front, for example @cryogen_club. For a private channel or a group: post any message in it, then open this address in your browser, replacing TOKEN with your token: https://api.telegram.org/botTOKEN/getUpdates. Find "chat":{"id":-100123456789 and copy the number including the minus sign.',
      'That is your TELEGRAM_CHAT_ID.',
    ] },
  { id: 'bluesky', title: 'Bluesky', how: 'The app posts', minutes: 5, env: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'], summary: 'Posts to the club\'s Bluesky account. Free.',
    steps: [
      'Create the club account at bsky.app if you do not have one yet, and sign in.',
      'Click your profile picture or the menu, then Settings, then Privacy and security, then App passwords.',
      'Click Add App Password, call it CRYO-GEN Studio, and click Create. Copy the password that appears (four groups of letters like abcd-efgh-ijkl-mnop). You cannot see it again. This is NOT your normal password: never use that.',
      'BLUESKY_APP_PASSWORD is that app password.',
      'BLUESKY_HANDLE is the account name without the @, for example cryogen.bsky.social.',
    ] },
  { id: 'website', title: 'Website (cryogen.team)', how: 'The app posts', minutes: 5, env: [], summary: 'Creates a post on the club website. It uses the WordPress login the app already has for member records.',
    steps: [
      'Nothing to add in Vercel if members already load: the app already has WP_API_USER and WP_API_APP_PASSWORD.',
      'That WordPress user must be allowed to write posts. In WordPress go to Users, find that user, and make sure their Role is Author, Editor or Administrator (not Subscriber).',
      'Press "Test the connection". It checks the login and that it may create posts.',
      'By default posts are saved as DRAFTS on the website so you can look before they go live. To publish at once, open the Studio settings and set "Website posts are" to published at once.',
    ] },
  { id: 'facebook', title: 'Facebook Page', how: 'Through Zapier (or Make)', minutes: 20, env: ['STUDIO_HOOK_FACEBOOK'], summary: 'Posts to the club\'s Facebook Page. Zapier does the Facebook part, so there is no Facebook developer set-up or review.',
    steps: [
      'You need a Facebook PAGE for the club (not a personal profile) and to be its admin.',
      'Go to zapier.com and sign in or create a free account.',
      'Click Create, then Zap. For the trigger, search for "Webhooks by Zapier" and choose the event "Catch Hook". Click Continue. Skip the optional child key.',
      'Zapier shows a Custom Webhook URL (it starts with https://hooks.zapier.com/). Copy it. That is your STUDIO_HOOK_FACEBOOK. Do not click Test trigger yet.',
      'Add the value in Vercel (steps below) and Redeploy.',
      'Back here, press "Test the connection". That sends a sample post to Zapier so it can see the fields.',
      'In Zapier click Test trigger / Find new records. You should see fields called text, imageUrl, title, link. If you do not, wait ten seconds and try again.',
      'Add the action: search for "Facebook Pages" and choose "Create Page Post". Connect your Facebook account when asked and choose the club Page.',
      'For Message choose the "text" field from step 1. For Link choose "link". (If you want the picture too, use the action "Create Page Photo" instead and use "imageUrl" as the Photo URL.) Click Continue, Test, then Publish the Zap.',
      'Done. From now on, ticking Facebook when you approve a post sends it to your Page.',
    ] },
  { id: 'instagram', title: 'Instagram', how: 'Through Zapier (or Make)', minutes: 25, env: ['STUDIO_HOOK_INSTAGRAM'], summary: 'Posts a picture with a caption to the club\'s Instagram. Instagram always needs a picture, so make the picture card in the Studio first.',
    steps: [
      'The club Instagram must be a Business or Creator account (Instagram: Settings, Account type and tools, Switch to professional account), and linked to the club\'s Facebook Page (Instagram: Edit profile, Page).',
      'In Zapier create a second Zap: trigger "Webhooks by Zapier", event "Catch Hook". Copy its Custom Webhook URL. That is your STUDIO_HOOK_INSTAGRAM.',
      'Add the value in Vercel (steps below) and Redeploy.',
      'Press "Test the connection" here, then in Zapier press Test trigger. You should see the fields text and imageUrl.',
      'Add the action: search "Instagram for Business" and choose "Publish Photo". Connect the account. Set Photo URL to the "imageUrl" field and Caption to the "text" field. Test and Publish the Zap.',
      'Every time: in the Studio press "Make a picture card" on the post first, then tick Instagram when you approve. Without a picture the Studio will say so and send nothing.',
    ] },
  { id: 'hook', title: 'Zapier or Make: everything', how: 'Through Zapier (or Make)', minutes: 10, env: ['STUDIO_HOOK_OTHER'], summary: 'Optional. Sends every post, with all the wording for every platform, to one Zapier or Make link, so you can connect anything else (LinkedIn, X, Slack, a spreadsheet, a newsletter tool).',
    steps: [
      'In Zapier (or Make.com: Webhooks, Custom webhook) create a Zap whose trigger is "Webhooks by Zapier" with event "Catch Hook". Copy the Custom Webhook URL. That is your STUDIO_HOOK_OTHER.',
      'Add it in Vercel and Redeploy, then press "Test the connection" and Test trigger in Zapier. You will see a "variants" group with the text for each platform.',
      'Add whatever action you like and use the matching text from "variants" (for example variants discord, variants bluesky, variants website title).',
    ] },
  { id: 'email', title: 'Email', how: 'By hand, or through Zapier', minutes: 10, env: ['STUDIO_HOOK_EMAIL'], summary: 'Without any set-up the Studio writes the email for you and gives you a button that opens it ready to send. To send it automatically, use Zapier.',
    steps: [
      'Nothing is needed to use it by hand: on a post, find the Email row, press "Open an email", add your recipients and send, then press "I have posted it".',
      'To send automatically: in Zapier create a Zap with trigger "Webhooks by Zapier", event "Catch Hook". Copy the Custom Webhook URL. That is your STUDIO_HOOK_EMAIL.',
      'Add it in Vercel and Redeploy. Press "Test the connection", then Test trigger in Zapier. You will see the fields subject and text.',
      'Add the action "Gmail" (Send Email), "Microsoft Outlook" or your newsletter tool (for example MailerLite or Mailchimp "Add subscriber / Send campaign"). Use "subject" for the subject and "text" for the body.',
    ] },
  { id: 'whatsapp', title: 'WhatsApp', how: 'By hand', minutes: 1, env: [], summary: 'WhatsApp does not allow apps to post into groups, so the Studio does the writing and you press send.',
    steps: [
      'On a post, find the WhatsApp row and press "Open WhatsApp". Choose the group or person and press send.',
      'Press "I have posted it" so the Studio knows.',
    ] },
  { id: 'strava', title: 'Strava club', how: 'By hand', minutes: 2, env: [], summary: 'Strava does not allow apps to post to a club, so the Studio gives you the text and a link to the club.',
    steps: [
      'Open the Studio settings and paste your Strava club address (on Strava open the club and copy the address, it looks like https://www.strava.com/clubs/123456). Save.',
      'On a post, find the Strava row: press "Copy the text", then "Open the Strava club", choose Posts, and paste.',
      'Press "I have posted it".',
    ] },
  { id: 'discord', title: 'Discord', how: 'The app posts', minutes: 0, env: [], summary: 'Already set up: the Studio posts to the club channel with the same Discord link the rest of the app uses.',
    steps: ['Nothing to do. Press "Test the connection" and a test line appears in the admin channel.'] },
];
module.exports = { GUIDE, VERCEL };

if (require.main === module) {
  const lines = ['# Comms Studio: set up each platform', '', 'Written step by step for someone who has never done it before. The same guide, with a "Test the connection" button on each platform, is inside the app under Studio.', '', '## First, how to add a value in Vercel (every platform with a key needs this)', '', ...VERCEL.map((s, i) => `${i + 1}. ${s}`), ''];
  for (const g of GUIDE) {
    lines.push(`## ${g.title}`, '', `**${g.how}** · about ${g.minutes} minutes${g.env.length ? ` · values to add in Vercel: ${g.env.map(e => '`' + e + '`').join(', ')}` : ''}`, '', g.summary, '', ...g.steps.map((s, i) => `${i + 1}. ${s}`), '');
  }
  require('fs').writeFileSync(require('path').join(__dirname, '..', 'docs', 'STUDIO-SETUP.md'), lines.join('\n'));
  console.log('wrote docs/STUDIO-SETUP.md');
}

# HomeRun CS ticket tracker

A small web app for two people:

- **The admin** imports Freshchat chats, picks a product owner on a row and clicks **Confirm**. The owner is emailed the Freshchat link.
- **The product owner** opens the tracker from that email, fixes the issue, and pastes the Google Drive link to their RCA on that chat's row.

There's no sign-in. Access works through a secret **access key**:

- The key is part of the tracker link that you bookmark.
- The emails to product owners include it automatically.
- Anyone without the key can't read or change anything.

The tracker runs on GitHub Pages and Firebase's free plan.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The app |
| `config.js` | Firebase project details, plus optional Gmail auto-send |
| `firestore.rules` | Database rules; this is where your access key goes |
| `firebase.json` | Lets the Firebase CLI deploy the rules |

## Setup (about 10 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and create a project. Keep it on the **Spark (no-cost)** plan.
2. Add a **Web app** under Project settings → General → Your apps, and copy the config into `config.js`.
3. Go to Firestore Database → Create database. Production mode is fine.

You don't need Authentication or Storage.

### 2. Create your access key and lock the database
1. Make a long random key. Either run this in a terminal:
   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```
2. Open Firestore → **Rules**. Paste in `firestore.rules`, replace `REPLACE_WITH_YOUR_ACCESS_KEY` with your key, and click **Publish**.
3. **Don't commit the real key.** Keep the placeholder in the repo's copy of `firestore.rules`. The key only lives in the Firebase console and in your bookmarked link.

### 3. Host on GitHub Pages
1. Push these files to a repo.
2. Go to Settings → Pages and choose your branch with the `/ (root)` folder.
3. Your tracker link is:
   ```
   https://<your-username>.github.io/<repo>/#key=<your access key>
   ```
4. Open it once and bookmark it. The browser also remembers the key.
5. Optionally, put the plain Pages URL (without the key) in `appUrl` in `config.js`.

## Email to product owners
**Default (no setup).** Clicking **Confirm** opens your mail app (Gmail, Outlook, Apple Mail) with the email already written: owner's address, subject, Freshchat link, order details, what the customer said, and the tracker link. You press send. The row then shows "Email opened in mail app".

**Optional: send automatically from Gmail.** Do this in the Google Cloud console for the **same** project (<https://console.cloud.google.com>):
1. Go to APIs & Services → Library and enable the **Gmail API**.
2. Go to APIs & Services → OAuth consent screen. Choose **Internal** and add the scope `https://www.googleapis.com/auth/gmail.send`.
3. Go to APIs & Services → Credentials → Create credentials → **OAuth client ID** and choose **Web application**. Under Authorized JavaScript origins, add `https://<your-username>.github.io`.
4. Copy the client ID into `googleClientId` in `config.js`.

With that set, Confirm sends the email straight from the admin's Gmail. Google asks for permission about once an hour.

## Using it
1. **Set up.** Open **Product owners & settings**. Add each product owner's name and email, and set the Freshchat chat link format, for example `https://homerun.freshchat.com/a/APP_ID/open/conversation/{id}`.
2. **Backfill.** Export this week's conversations (Monday to today) from Freshchat as CSV, then use **Import Freshchat export**. Re-importing later adds new chats and never touches owners, emails, hand-set tags or RCA links.
3. **Assign.** Pick the owner on the row and click **Confirm**. The email goes to them.
4. **RCA.** The owner uploads the RCA (PDF, Excel, Doc or Sheet) to Google Drive and shares it with HomeRun. Then they click **Add RCA Drive link** on the chat's row and paste the link. RCA TAT runs from assignment to the first link.

## Good to know
- **Keep the key private.** Anyone who has the full link with the key can see the chats, including order IDs and what customers said. Only share it with the two people using the tracker. If it leaks, make a new key, update the Firestore rule, and send the new link. The old data stays under the old key, so ask Claude to migrate it if needed.
- **Free plan limits.** The free plan allows about 50,000 database reads a day; check <https://firebase.google.com/pricing>. With two users you'll stay far below it. Nothing is ever charged; if the limit were hit, the tracker would pause until the next day.
- **Real-time Freshchat data.** For live data instead of CSV imports, a backend would receive Freshchat webhooks and write to `workspaces/<key>/tickets` in Firestore.

---

## Live Freshchat sync on Vercel (no imports)

The `api/` folder holds two serverless functions that Vercel runs next to the tracker:

| Function | What it does |
| --- | --- |
| `api/freshchat-webhook.js` | Freshchat calls this whenever a message arrives or a chat is assigned, resolved or reopened. It looks the chat up in the Freshchat API and creates or updates its row in the tracker: date, customer message, order ID, channel, chat link, L1 and L2. |
| `api/sync.js` | Runs once a day (Vercel cron, about 06:00 IST). It re-checks the last 7 days of chats that are still untagged and fills in any category agents added later. |

The tracker page updates live, so new chats appear within seconds of the customer writing.

### 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
| --- | --- |
| `FRESHCHAT_API_KEY` | Freshchat API token (Freshchat → Admin → API Tokens) |
| `FRESHCHAT_BASE` | `https://homerun-team-d09d641d432c3b917703943.freshchat.com/v2` |
| `FRESHCHAT_WEBHOOK_PUBLIC_KEY` | The public key shown on Freshchat's webhook settings page (paste the whole block) |
| `TRACKER_KEY` | The tracker access key (the same one in your Firestore rules) |
| `FIREBASE_API_KEY` | `apiKey` from `config.js` |
| `FIREBASE_PROJECT_ID` | `homerun-cs-tracker` |
| `CRON_SECRET` | Any long random string. Vercel sends it to `/api/sync` automatically. |

Optional settings:
- `L1_FIELD` and `L2_FIELD` override the Freshchat fields. The defaults are `cf_issue_subcategory` and `cf_root_cause`.
- `FRESHCHAT_WEBHOOK_VERIFY=off` turns off the signature check. Use it only to debug, then remove it.

After adding or changing variables, redeploy: go to Deployments → ⋯ → Redeploy.

### 2. Check the function
Open `https://<your-project>.vercel.app/api/freshchat-webhook` in a browser. It should show `"ok": true` with an empty `missing` list.

### 3. Point Freshchat at it
1. In Freshchat, open Admin → Webhooks (also listed as Settings → Integrations → Webhooks).
2. Turn webhooks on and set the URL to `https://<your-project>.vercel.app/api/freshchat-webhook`.
3. Select the events **Message Create**, **Conversation Assignment**, **Conversation Resolution** and **Conversation Reopen**.
4. Copy the **public key** shown there into `FRESHCHAT_WEBHOOK_PUBLIC_KEY`, then redeploy.

### 4. Test
Send a message from the HomeRun app's chat. A new row should appear in the tracker within a few seconds. If it doesn't, open Vercel → Project → Logs and filter by `freshchat-webhook`; each event logs what happened.

### Notes
- **What gets created.** Only chats where the customer wrote something, or that have a category, become rows. Outbound-only threads, such as WhatsApp order confirmations, are skipped.
- **When tags arrive.** L1/L2 usually arrive when an agent resolves the chat. The daily sync catches anything tagged later. To run it by hand, use `curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-project>.vercel.app/api/sync?days=7"`.
- **Hand-set tags.** Tags set by hand in the tracker are never overwritten.
- **Older chats.** History from before the webhook was switched on comes from the CSV import you've already done.
- **Free plan limits.** The free Vercel plan runs the cron once a day. Webhooks are real-time on any plan.

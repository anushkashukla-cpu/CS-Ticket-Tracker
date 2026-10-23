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

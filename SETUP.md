# Set up Firemail AI on Firebase

You need a Firebase project with RTDB, Firebase Authentication, static Hosting, and Cloud Functions. **Deploying Cloud Functions requires Firebase's Blaze billing plan.** This project sets a three-instance function limit; billing and quotas remain governed by your Firebase project.

Use a new RTDB instance for this app, or review its rules before integrating it with an existing app. The included `database.rules.json` denies all direct client access for the database where it is deployed. Existing applications that depend on client-readable paths need a separately reviewed rules configuration.

## 1. Prepare the Firebase project

In [Firebase Console](https://console.firebase.google.com/):

1. Create or select the project you want to use.
2. Enable **Realtime Database**, start with locked rules, and copy the exact database URL.
3. Register a **Web app** under Project settings. Analytics is optional.
4. Enable **Authentication → Sign-in method → Google** and configure the support email.
5. Add the Hosting domain to **Authentication → Settings → Authorized domains** when necessary.
6. Enable Blaze so the Cloud Function can be deployed.

Your RTDB URL might end in `firebaseio.com` or `firebasedatabase.app`, depending on the database location. Copy it from the console rather than guessing the name.

## 2. Enable Gmail and create its Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/), select the same Google Cloud project:

1. Enable **Gmail API**.
2. Configure **Google Auth Platform** branding and audience. For initial private testing, add every Gmail address you will connect as a test user.
3. Add the Gmail permission `https://www.googleapis.com/auth/gmail.modify` to Data Access.
4. Create an OAuth client with application type **Web application**, dedicated to this app's Gmail connection.
5. Add this exact authorized redirect URI, replacing the project ID:

```text
https://YOUR_PROJECT_ID.web.app/api/oauth/callback
```

6. Copy the client ID and client secret. The client ID goes in the function configuration. The client secret goes in Secret Manager.

The redirect URI must match `APP_ORIGIN` below exactly, including hostname and scheme. If you use a custom domain or the `firebaseapp.com` domain, use that same origin consistently and register its corresponding callback.

An external OAuth app in **Testing** normally has Gmail refresh tokens that expire after seven days. Google classifies `gmail.modify` as a restricted scope. Review the applicable Google publishing/verification requirements if you move beyond private testing. Password changes, revoked permissions, and other Google policies can also require reconnecting an inbox.

## 3. Install the local tools

Install Node.js 22 and the Firebase CLI, then open a terminal in the extracted `gmail-mailroom` folder:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
npm install --prefix functions
```

Choose your Firebase project when `firebase use --add` asks. Use the alias `default` for convenience. This writes your local `.firebaserc`; the package does not contain a project identity.

## 4. Fill in the three public configuration values

Copy `functions/.env.example` to `functions/.env.YOUR_PROJECT_ID` and replace its values:

```dotenv
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
APP_ORIGIN=https://YOUR_PROJECT_ID.web.app
DATABASE_URL=https://YOUR_ACTUAL_DATABASE_URL
```

These are server configuration values, not secrets. Do not put the Google client secret, encryption key, account passwords, or refresh tokens in this file.

Firebase Hosting supplies the public Web configuration at `/__/firebase/init.json`. If that endpoint is unavailable, copy `public/firebase-config.example.json` to `public/firebase-config.json` and fill in the public Firebase Web configuration from Project settings.

## 5. Set the two server secrets

Generate an encryption key once on your own computer:

```bash
node scripts/generate-vault-key.mjs
```

Store that value in a private backup. Run the next command and enter the generated value when the CLI prompts:

```bash
firebase functions:secrets:set VAULT_KEY
```

Then set the Google OAuth client secret from step 2:

```bash
firebase functions:secrets:set GOOGLE_CLIENT_SECRET
```

The function reads both secrets directly from Secret Manager. Changing `VAULT_KEY` without migrating existing ciphertext makes stored passwords and Gmail refresh tokens unreadable. Keep the original key while using the vault.

## 6. Check and deploy

```bash
npm run check
npm test
firebase deploy --only database,functions:mailApi,hosting
```

The deployment publishes `public/`, deploys `mailApi` in `us-central1`, and installs the RTDB rules. Approve any required Google APIs or project permissions in your own Firebase account.

## 7. Approve your dashboard administrator

1. Open `https://YOUR_PROJECT_ID.web.app/` and choose **Continue with Google** using your administrator account.
2. You will see an approval message because the allowlist starts empty.
3. In **Firebase Console → Authentication → Users**, copy that user's **UID**.
4. In **Realtime Database → Data**, create the following node using the actual UID:

```json
{
  "adminAllowlist": {
    "YOUR_FIREBASE_AUTH_UID": true
  }
}
```

Use the Boolean value `true`, not the text string `"true"`. Add only this node; avoid importing over existing private data.

5. Reload the dashboard and sign in again if necessary.
6. Create a dashboard passcode of at least eight characters. The server writes its verifier into RTDB and unlocks your workspace.

The Firebase console is an administrative interface, so it can edit this allowlist while ordinary client access is denied by the rules. Each approved UID gets a separate account vault.

## 8. Add and connect Gmail accounts

- **Save account:** In Accounts & lock, add a Gmail address, a label, and optionally a password. The function encrypts the password before writing it to RTDB.
- **Connect inbox:** Select Connect Gmail and finish Google's authorization for that account. Saving a password alone does not connect a mailbox.
- **Read and send:** Connected inboxes appear in All accounts. Select a specific account when needed; the From field chooses which mailbox sends a message.

After connection, the function uses the saved encrypted refresh token to renew Gmail access. Open the dashboard and unlock it to use those mailboxes without signing in to each Gmail account separately. Use Reconnect if Google access expires.

Allow popups for the dashboard's domain. Complete one Gmail connection at a time. The callback is protected by a temporary HttpOnly `__session` cookie and a single-use state tied to the dashboard unlock.

Disconnecting or removing an account deletes its saved Gmail token from this app. To revoke Google's permission itself, also remove the app under [Google Account connections](https://myaccount.google.com/connections).

## Demo

After Hosting deployment, open:

```text
https://YOUR_PROJECT_ID.web.app/?demo=1
```

The sample workspace needs no Firebase sign-in, no approved UID, and no Gmail account. Compose, drafts, folders, and attachments operate on synthetic data in memory. Demo sends deliver no email. If you lock the demo, use `demo1234` to reopen it.

To view the demo locally, use any static HTTP server for the `public/` folder. Opening `index.html` directly as a `file://` URL will not run the browser modules correctly. A static server only previews sample mail; the real API requires Firebase deployment.

## Recovery and maintenance

If you forget the dashboard passcode, use Firebase Console to remove **only** `private/users/YOUR_UID/lock`, `sessions`, and `unlockAttempts`. Reload the dashboard and create a new passcode. Saved account records stay in place.

The optional admin script performs the same operations using Application Default Credentials with RTDB administrative permissions:

```bash
export MAILROOM_DATABASE_URL="https://YOUR_ACTUAL_DATABASE_URL"
node functions/scripts/admin.mjs allow YOUR_UID
node functions/scripts/admin.mjs revoke YOUR_UID
node functions/scripts/admin.mjs reset-lock YOUR_UID
node functions/scripts/admin.mjs prune YOUR_UID
```

Run just the operation you intend. `prune` removes expired unlock/OAuth records and send-operation records older than 30 days. Pruning an old send record ends deduplication for that old send identifier; the app generates fresh identifiers for new messages.

Revoking a UID blocks its API access immediately. Deleting account records or resetting a dashboard lock does not delete mail in Google.

## Common setup issues

| Message or symptom | Check |
| --- | --- |
| Firebase is not configured | Register the Web app; check `/__/firebase/init.json` or fill in `firebase-config.json` |
| Google sign-in is blocked | Enable Firebase Google sign-in, approve the domain, and allow popups |
| Administrator is not approved | Copy the Firebase Auth UID; set `adminAllowlist/UID` to Boolean `true`; reload |
| API is not available | Deploy `mailApi` and the `/api/**` Hosting rewrite together |
| Requests from this website are not allowed | The address you opened must match `APP_ORIGIN` |
| `redirect_uri_mismatch` | Match the OAuth callback URI to `APP_ORIGIN/api/oauth/callback` |
| Gmail permission denied | Enable Gmail API and grant the requested Gmail scope |
| Authorization expired | Reconnect; Testing apps generally expire after seven days |
| Encryption/server configuration failure | Check both Secret Manager values and the actual RTDB URL |
| Connection completes but popup stays open | Close it and refresh the unlocked inbox |

The source checks and mocked tests do not replace a first live connection check. After deploying, authorize a mailbox you control, verify an inbox read, save and reopen a draft, then send a test message to another address you control.

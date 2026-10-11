# Firemail AI

A private Gmail dashboard with a Firebase RTDB account vault and dashboard lock. The interface is ordinary HTML, CSS, and JavaScript deployed on Firebase static Hosting. One Firebase Cloud Function handles private database access, Google authorization, and Gmail requests.

Start with **[SETUP.md](SETUP.md)**. The source is implemented; your Firebase project and Google OAuth client still need configuration before real mail can be accessed.

## Included

- Multiple Gmail accounts and a combined inbox, with account filters.
- Inbox, Starred, Sent, Drafts, All mail, Spam, and Trash.
- Gmail search, pagination, and full conversation reading.
- Read/unread, star/unstar, archive, spam, trash, and restore actions.
- Plain-text compose with To, Cc, Bcc, replies, reply all, and forwarding.
- Gmail drafts, automatic draft saving after 10 seconds of inactivity, and draft editing.
- Attachment uploads and downloads, with a 6 MB total upload limit.
- Saved Gmail addresses, labels, and optional encrypted passwords in RTDB.
- A dashboard passcode verifier stored in RTDB, enforced on the server.
- Approved Firebase administrator identities, account ownership checks, and audit history.
- A responsive layout and a fully separate sample-mail demo at `/?demo=1`.

Gmail access uses a one-time Google authorization for each account. The server stores an encrypted refresh token and renews access when needed. The saved Gmail password is account-vault data; it is not used to open Gmail. Reconnection can still be required when Google access expires or is revoked.

The dashboard also has its own Google administrator sign-in. That identity stays signed in in the browser, while the secondary dashboard passcode is required again after refresh, manual locking, or expiry. Gmail account connections are independent of this dashboard identity.

## Files

| File or folder | Purpose |
| --- | --- |
| `public/` | Static dashboard, styles, icons, identity initialization, email renderer, and demo |
| `functions/index.mjs` | Firebase HTTPS function entry point |
| `functions/lib/` | API routes, encryption, lock checks, Gmail connector, and MIME composer |
| `database.rules.json` | Denies every direct client read and write |
| `firebase.json` | Hosting configuration, security headers, and `/api/**` function rewrite |
| `functions/.env.example` | Three non-secret configuration values |
| `functions/scripts/admin.mjs` | Administrator approval, revocation, lock recovery, and pruning |
| `scripts/generate-vault-key.mjs` | Creates a new encryption key locally |
| `tests/` | Security, API, MIME, Gmail connector, and sample-workspace tests |

## RTDB structure

| Path | Stored data |
| --- | --- |
| `adminAllowlist/{uid}` | Boolean approval for a Firebase administrator |
| `private/users/{uid}/lock` | Salt, scrypt verifier, and lock version |
| `private/users/{uid}/sessions/{hashedToken}` | Unlock expiry and lock version |
| `private/users/{uid}/unlockAttempts` | Passcode attempt count and cooldown |
| `private/users/{uid}/accounts/{accountId}` | Gmail address, label, encrypted password, encrypted refresh token, and connection state |
| `private/users/{uid}/audit` | Latest 100 account, lock, reveal, and send events |
| `private/users/{uid}/limits` | Persisted API and send limits |
| `private/users/{uid}/sendOperations/{hashedKey}` | Duplicate-send guard and delivery confirmation |
| `private/oauthStates/{hashedState}` | Temporary, single-use Google authorization state |

Each approved Firebase UID owns a separate vault. Mail bodies are retrieved from Gmail when requested; they are not copied into RTDB. The encryption key and Google client secret live in Firebase Secret Manager. The browser receives neither of those secrets nor Gmail refresh tokens.

## Check the project

The application tests need Node.js 22 or newer and do not need Firebase credentials or real mailboxes:

```bash
npm run check
npm test
```

The tests cover authentication and ownership, lock expiry and cooldown, lock rotation, encrypted storage, OAuth state binding and replay protection, pagination, drafts, duplicate and uncertain sends, Gmail refresh handling, MIME injection, attachment limits, and sample-mail actions. They use an in-memory RTDB substitute and mocked Google responses.

The included version passed these checks in the build environment. A live Firebase deployment, browser integration check, and a real Google authorization still need to be completed in your project. No real emails were sent while building this package.

## Operating limits

- Up to 30 saved accounts per dashboard owner.
- Unlock sessions last 30 minutes. Idle browser tabs lock after 10 minutes.
- Five incorrect passcode attempts trigger a 15-minute cooldown.
- Compose supports 30 recipients total and 10 attachments totaling 6 MB.
- Individual attachment downloads are limited to 6 MB for the Hosting response budget.
- Very large conversations may require opening Gmail directly.
- Replies and drafts use a plain-text editor; existing HTML drafts are converted to text for editing.
- A combined page fetches up to 12 messages from each connected account. Load more fetches the next page per account and sorts all loaded messages by date.
- The sidebar badge counts unread inbox items in the currently loaded results.
- The interface fetches mail on navigation, refresh, and pagination. It has no background mailbox polling or new-mail notifications.
- Sending is limited to 30 attempts per hour per owner; Gmail's own limits also apply.

If a send result is uncertain, the interface asks you to check Sent before creating another copy. A send identifier is retained in RTDB so retrying that same operation cannot silently duplicate it.

## References

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail sending API](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Firebase Hosting with Cloud Functions](https://firebase.google.com/docs/hosting/functions)
- [Firebase Functions environment and secrets](https://firebase.google.com/docs/functions/config-env)
- [Firebase Hosting cookie forwarding](https://firebase.google.com/docs/hosting/manage-cache)

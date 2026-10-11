# Firemail AI 🚀

A modern, private multi-account Gmail webmail client powered by **Firebase Realtime Database (RTDB)**, direct **IMAP sync**, and **GitHub Actions 24/7 automated runners**.

- **Live Web App:** [https://firemailai.web.app](https://firemailai.web.app)
- **Repository:** [https://github.com/mrsmithcons-tech/firemailai](https://github.com/mrsmithcons-tech/firemailai)

---

## ✨ Features

- **Master Passcode Lock:** No Google OAuth or sign-up needed. A single master passcode unlocks your private dashboard directly from RTDB.
- **Unified Multi-Account Inbox:** View all Gmail accounts in one combined inbox with filters per account.
- **Real-Time 24/7 Sync Online:** Automated GitHub Actions runner (`.github/workflows/sync.yml`) checks inboxes every 5 minutes and pushes new messages into Firebase RTDB without keeping your computer on.
- **Folder Navigation:** Inbox, Starred, Sent, Drafts, Trash, and Spam.
- **Compose & Reply:** Rich email composer with To, Cc, Bcc, attachments, and reply/forward support.
- **Account Vault:** Store multiple Gmail addresses with Google App Passwords; reveal/hide passwords with 1-click.
- **On-Demand Sync:** Sync inboxes immediately from the dashboard with the **Sync Now** button.

---

## 🛠️ Architecture

```
Gmail IMAP (imap.gmail.com:993)
         │
         ▼
[GitHub Actions Runner (Every 5 mins) / Local `npm run sync`]
         │
         ▼
[Firebase Realtime Database] (https://firemailai-default-rtdb.firebaseio.com)
         │
         ▼ (Realtime WebSocket listener)
[Firemail AI Web App] (https://firemailai.web.app)
```

---

## 💻 Local Commands

- **Start IMAP Sync once:**
  ```bash
  npm run sync
  ```
- **Run continuous local watcher (polls every 30s + listens to dashboard triggers):**
  ```bash
  npm run sync:watch
  ```
- **Deploy Frontend to Firebase:**
  ```bash
  firebase deploy --only hosting
  ```
- **Trigger GitHub Actions Sync manually:**
  ```bash
  gh workflow run sync.yml
  ```

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// Run locally using Application Default Credentials with RTDB administrative access.
// Never put a service account file inside public/ or commit one to this project.
const [command, uid] = process.argv.slice(2);
const url = process.env.MAILROOM_DATABASE_URL;
if (!['allow', 'revoke', 'reset-lock', 'prune'].includes(command) || !/^[a-zA-Z0-9_-]{1,128}$/.test(uid || '') || !url) {
  console.error('Usage: MAILROOM_DATABASE_URL=https://... node functions/scripts/admin.mjs allow|revoke|reset-lock|prune FIREBASE_UID');
  process.exit(1);
}
initializeApp({ credential: applicationDefault(), databaseURL: url });
const db = getDatabase();
const root = `private/users/${uid}`;
try {
  if (command === 'allow') await db.ref(`adminAllowlist/${uid}`).set(true);
  if (command === 'revoke') { await db.ref(`adminAllowlist/${uid}`).remove(); await db.ref(`${root}/sessions`).remove(); }
  if (command === 'reset-lock') { await db.ref(root).update({ lock: null, sessions: null, unlockAttempts: null }); }
  if (command === 'prune') {
    const now = Date.now();
    const updates = {};
    const [sessions, operations, states] = await Promise.all([
      db.ref(`${root}/sessions`).get(), db.ref(`${root}/sendOperations`).get(), db.ref('private/oauthStates').get()
    ]);
    for (const [key, value] of Object.entries(sessions.val() || {})) if (value.expiresAt <= now) updates[`${root}/sessions/${key}`] = null;
    for (const [key, value] of Object.entries(operations.val() || {})) if (value.at < now - 30 * 86400000) updates[`${root}/sendOperations/${key}`] = null;
    for (const [key, value] of Object.entries(states.val() || {})) if (value.uid === uid && value.expiresAt <= now) updates[`private/oauthStates/${key}`] = null;
    if (Object.keys(updates).length) await db.ref().update(updates);
  }
  console.log(`Completed ${command} for the selected UID.`);
} finally { await db.goOffline(); }

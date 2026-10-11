import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { createHandler } from './lib/app.mjs';

const vaultKey = defineSecret('VAULT_KEY');
const clientSecret = defineSecret('GOOGLE_CLIENT_SECRET');
const clientId = defineString('GOOGLE_CLIENT_ID');
const origin = defineString('APP_ORIGIN');
const databaseURL = defineString('DATABASE_URL');

// Initialize inside the request, after runtime parameters/secrets are available.
let handler;
export const mailApi = onRequest({
  region: 'us-central1',
  secrets: [vaultKey, clientSecret],
  timeoutSeconds: 120,
  memory: '512MiB',
  maxInstances: 3,
  concurrency: 20,
  invoker: 'public',
  cors: false
}, async (req, res) => {
  if (!handler) {
    const app = initializeApp({ databaseURL: databaseURL.value() });
    handler = createHandler({
      db: getDatabase(app),
      auth: getAuth(app),
      config: {
        vaultKey: vaultKey.value(),
        clientSecret: clientSecret.value(),
        clientId: clientId.value(),
        origin: origin.value()
      }
    });
  }
  return handler(req, res);
});

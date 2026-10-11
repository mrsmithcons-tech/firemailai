import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDB } from './memory-db.mjs';
import { createGmail, GMAIL_SCOPE } from '../functions/lib/gmail.mjs';
import { seal } from '../functions/lib/security.mjs';
function setup(fetcher) {
  const db = new MemoryDB(); const config = { vaultKey: Buffer.alloc(32, 9).toString('base64'), clientId: 'test-client', clientSecret: 'test-secret', origin: 'https://mailroom.example' };
  const record = { email: 'owned@example.com', connectedAt: 1, refreshToken: seal('private-refresh', config.vaultKey, 'owner:account:refresh') };
  return { db, record, gmail: createGmail({ db, config, fetcher }) };
}
const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
test('refresh tokens remain server-side and simultaneous Gmail reads share one renewal', async () => {
  const requests = [];
  const { record, gmail } = setup(async (url, options) => { requests.push({ url: String(url), options }); if (String(url).endsWith('/token')) return response(200, { access_token: 'access-only', expires_in: 3600 }); return response(200, { messages: [] }); });
  await Promise.all([gmail.call('owner', 'account', record, '/messages'), gmail.call('owner', 'account', record, '/messages')]);
  assert.equal(requests.filter(r => r.url.endsWith('/token')).length, 1);
  const mail = requests.find(r => r.url.includes('/gmail/v1/'));
  assert.equal(mail.options.headers.Authorization, 'Bearer access-only');
  assert.equal(mail.url.includes('private-refresh'), false);
  assert.equal(requests.find(r => r.url.endsWith('/token')).options.body.get('refresh_token'), 'private-refresh');
});
test('revoked Google refresh tokens flag an account for reconnection', async () => {
  const { db, record, gmail } = setup(async () => response(400, { error: 'invalid_grant' }));
  await assert.rejects(gmail.call('owner', 'account', record, '/messages'), err => err.code === 'RECONNECT_REQUIRED');
  assert.equal((await db.ref('private/users/owner/accounts/account/status').get()).val(), 'reconnect');
});
test('Google query parameters and multi-value metadata headers are encoded safely', async () => {
  let requested;
  const { record, gmail } = setup(async (url, options) => { if (String(url).endsWith('/token')) return response(200, { access_token: 'access-only', expires_in: 3600 }); requested = new URL(url); return response(200, {}); });
  await gmail.call('owner', 'account', record, '/messages', { query: { q: 'from:a@example.com & subject:test', metadataHeaders: ['From', 'To'], includeSpamTrash: true } });
  assert.equal(requested.searchParams.get('q'), 'from:a@example.com & subject:test');
  assert.deepEqual(requested.searchParams.getAll('metadataHeaders'), ['From', 'To']);
  assert.equal(requested.searchParams.get('includeSpamTrash'), 'true');
});
test('a failed send is never automatically retried after a network error', async () => {
  let sends = 0;
  const { record, gmail } = setup(async url => { if (String(url).endsWith('/token')) return response(200, { access_token: 'access-only', expires_in: 3600 }); sends++; throw new Error('Connection lost'); });
  await assert.rejects(gmail.call('owner', 'account', record, '/messages/send', { method: 'POST', body: { raw: 'AA' } }), err => err.code === 'GOOGLE_NETWORK');
  assert.equal(sends, 1);
});
test('a consent callback must grant Gmail modify and identify an actual mailbox', async () => {
  const { gmail } = setup(async () => response(200, { access_token: 'access-only', refresh_token: 'refresh', scope: 'openid email' }));
  await assert.rejects(gmail.exchange('code'), err => err.code === 'OAUTH_SCOPE');
  const good = setup(async url => String(url).endsWith('/token') ? response(200, { access_token: 'access-only', refresh_token: 'refresh', scope: GMAIL_SCOPE }) : response(200, { emailAddress: 'owned@example.com' }));
  assert.equal((await good.gmail.exchange('code')).email, 'owned@example.com');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDB } from './memory-db.mjs';
import { createHandler } from '../functions/lib/app.mjs';
import { accountId, seal, digest, AppError } from '../functions/lib/security.mjs';
import { GMAIL_SCOPE } from '../functions/lib/gmail.mjs';

function fixture() {
  let clock = 1700000000000; const calls = []; const logs = [];
  const db = new MemoryDB({ adminAllowlist: { owner: true, other: true } });
  const config = { origin: 'https://mailroom.example', vaultKey: Buffer.alloc(32, 8).toString('base64'), clientId: 'test-client', clientSecret: 'test-secret' };
  const gmail = {
    exchange: async () => ({ email: 'owned@example.com', access_token: 'test-access', refresh_token: 'test-refresh', scope: GMAIL_SCOPE }),
    call: async (uid, aid, record, path, options = {}) => {
      calls.push({ uid, aid, path, options });
      if (path === '/messages') return { messages: [{ id: 'mail1', threadId: 'thread1' }], nextPageToken: 'page-two' };
      if (path === '/messages/mail1') return { id: 'mail1', threadId: 'thread1', internalDate: '1700000000000', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'Subject', value: 'Test mail' }], mimeType: 'text/plain', body: { data: Buffer.from('Inbox text').toString('base64url') } } };
      if (path === '/threads/thread1') return { id: 'thread1', messages: [await gmail.call(uid, aid, record, '/messages/mail1')] };
      if (path === '/drafts' && options.method === 'POST') return { id: 'draft1', message: { id: 'draftmail1' } };
      if (path === '/messages/send' || path === '/drafts/send') return { id: 'sent1', threadId: 'thread1' };
      return {};
    }
  };
  const handler = createHandler({ db, config, gmail, now: () => clock, auth: { verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); if (!token.startsWith('token-')) throw Error('Invalid'); const uid = token.slice(6); return { uid, email: uid + '@example.com' }; } }, logger: { error: (...args) => logs.push(args) } });
  async function request(path, { method = 'GET', uid = 'owner', token, session, body, origin = config.origin, cookie } = {}) {
    const req = { method, originalUrl: path, headers: { ...(uid ? { authorization: token || 'Bearer token-' + uid } : {}), origin, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-vault-session': session } : {}), ...(cookie ? { cookie } : {}) }, body: body || {}, rawBody: Buffer.from(JSON.stringify(body || {})) };
    const result = { status: 200, headers: {} };
    const res = { setHeader: (name, value) => { result.headers[name] = value; }, status: code => { result.status = code; return res; }, json: value => { result.body = value; return res; }, redirect: (code, location) => { result.status = code; result.location = location; return res; } };
    await handler(req, res); return result;
  }
  async function unlock(uid = 'owner') { return (await request('/api/lock/setup', { method: 'POST', uid, body: { passcode: 'owner-demo-lock' } })).body.token; }
  async function connected(uid = 'owner') {
    const aid = accountId('owned@example.com');
    await db.ref(`private/users/${uid}/accounts/${aid}`).set({ email: 'owned@example.com', label: 'Owned account', createdAt: clock, connectedAt: clock, status: 'active', refreshToken: seal('test-refresh', config.vaultKey, `${uid}:${aid}:refresh`) });
    return aid;
  }
  return { db, config, gmail, calls, logs, request, unlock, connected, advance: ms => { clock += ms; } };
}

test('no authentication, unknown administrator and missing unlock cannot read account data', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/accounts', { uid: null })).status, 401);
  assert.equal((await f.request('/api/accounts', { uid: 'stranger' })).status, 403);
  assert.equal((await f.request('/api/accounts')).status, 423);
  assert.equal((await f.request('/api/accounts', { origin: 'https://evil.example' })).status, 403);
  assert.equal(f.calls.length, 0);
});
test('first-run lock setup is restricted and a stored password is encrypted, with no listing leak', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/lock/setup', { method: 'POST', uid: 'stranger', body: { passcode: 'stolen-lock' } })).status, 403);
  const session = await f.unlock();
  const saved = await f.request('/api/accounts', { method: 'PUT', session, body: { email: 'owned@example.com', label: 'Personal', password: 'sample-private-password' } });
  assert.equal(saved.status, 200); assert.equal(saved.body.account.hasPassword, true);
  const aid = saved.body.account.id;
  assert.equal(JSON.stringify(f.db.data).includes('sample-private-password'), false);
  assert.equal(JSON.stringify((await f.request('/api/accounts', { session })).body).includes('ciphertext'), false);
  assert.equal((await f.request(`/api/accounts/${aid}/password`, { method: 'POST', session })).body.password, 'sample-private-password');
  assert.equal((await f.request('/api/lock/setup', { method: 'POST', body: { passcode: 'replacement-lock' } })).status, 409);
});
test('an approved second administrator cannot use the first owner’s session or account', async () => {
  const f = fixture(); const ownerSession = await f.unlock(); const aid = await f.connected();
  assert.equal((await f.request('/api/accounts', { uid: 'other', session: ownerSession })).status, 423);
  const otherSession = await f.unlock('other');
  assert.equal((await f.request(`/api/accounts/${aid}/threads/thread1`, { uid: 'other', session: otherSession })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('incorrect passcodes are persisted and the sixth attempt is blocked even in another session', async () => {
  const f = fixture(); await f.unlock();
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/lock/unlock', { method: 'POST', body: { passcode: 'wrong' } })).status, 401);
  assert.equal((await f.request('/api/lock/unlock', { method: 'POST', body: { passcode: 'owner-demo-lock' } })).body.error.code, 'LOCK_COOLDOWN');
  f.advance(15 * 60000 + 1);
  assert.equal((await f.request('/api/lock/unlock', { method: 'POST', body: { passcode: 'owner-demo-lock' } })).status, 200);
});
test('manual lock, expiry, passcode rotation and allowlist revocation invalidate API access', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  const changed = await f.request('/api/lock/change', { method: 'POST', session, body: { currentPasscode: 'owner-demo-lock', passcode: 'a-new-demo-lock' } });
  assert.equal(changed.status, 200);
  assert.equal((await f.request('/api/accounts', { session })).status, 423);
  const newSession = changed.body.token;
  assert.equal((await f.request('/api/accounts', { session: newSession })).status, 200);
  f.advance(30 * 60000 + 1);
  assert.equal((await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session: newSession, body: { to: 'a@example.com', text: 'Hi', sendKey: 'key-1' } })).status, 423);
  assert.equal(f.calls.some(c => c.path.endsWith('/send')), false);
  const unlocked = (await f.request('/api/lock/unlock', { method: 'POST', body: { passcode: 'a-new-demo-lock' } })).body.token;
  await f.request('/api/lock', { method: 'POST', session: unlocked });
  assert.equal((await f.request('/api/accounts', { session: unlocked })).status, 423);
  await f.db.ref('adminAllowlist/owner').remove();
  assert.equal((await f.request('/api/accounts', { session: newSession })).status, 403);
});
test('OAuth state is opaque, browser-bound, tied to a live unlock, and single-use', async () => {
  const f = fixture(); const session = await f.unlock();
  const start = await f.request('/api/oauth/start', { method: 'POST', session });
  const url = new URL(start.body.url); const state = url.searchParams.get('state'); const cookie = start.headers['Set-Cookie'].split(';')[0];
  assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('scope'), GMAIL_SCOPE);
  const mismatch = await f.request(`/api/oauth/callback?state=${state}&code=example-code`, { uid: null });
  assert.match(mismatch.location, /oauth=error/); assert.ok((await f.db.ref(`private/oauthStates/${digest(state)}`).get()).val());
  const callback = await f.request(`/api/oauth/callback?state=${state}&code=example-code`, { uid: null, cookie });
  assert.equal(callback.status, 303); assert.match(callback.location, /oauth=connected/);
  const listing = await f.request('/api/accounts', { session });
  assert.equal(listing.body.accounts[0].connected, true);
  assert.equal(JSON.stringify(f.db.data).includes('test-refresh'), false);
  const replay = await f.request(`/api/oauth/callback?state=${state}&code=example-code`, { uid: null, cookie });
  assert.match(replay.location, /oauth=error/);
});
test('OAuth cannot reconnect a saved account by authorizing a different Google account', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  f.gmail.exchange = async () => ({ email: 'different@example.com', refresh_token: 'test-other-refresh' });
  const start = await f.request('/api/oauth/start', { method: 'POST', session, body: { accountId: aid } });
  const url = new URL(start.body.url); const cookie = start.headers['Set-Cookie'].split(';')[0];
  const result = await f.request(`/api/oauth/callback?state=${url.searchParams.get('state')}&code=x`, { uid: null, cookie });
  assert.match(result.location, /OAUTH_ACCOUNT_MISMATCH/);
  assert.equal((await f.request('/api/accounts', { session })).body.accounts.length, 1);
});
test('Gmail search, folder filtering, pagination and thread bodies stay within the owner’s mailboxes', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  const page = await f.request('/api/messages?folder=INBOX&q=from%3Aa%40example.com', { session });
  assert.equal(page.body.messages[0].accountId, aid); assert.equal(page.body.messages[0].subject, 'Test mail');
  assert.equal(f.calls.find(c => c.path === '/messages').options.query.q, 'from:a@example.com');
  await f.request('/api/messages?folder=INBOX&cursor=' + page.body.nextCursor, { session });
  assert.equal(f.calls.filter(c => c.path === '/messages').at(-1).options.query.pageToken, 'page-two');
  assert.equal((await f.request(`/api/accounts/${aid}/threads/thread1`, { session })).body.messages[0].text.trim(), 'Inbox text');
  assert.equal((await f.request('/api/messages?folder=INVALID', { session })).status, 400);
});
test('blank-recipient drafts can be saved, while sending requires recipients', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  assert.equal((await f.request(`/api/accounts/${aid}/drafts`, { method: 'POST', session, body: { text: 'An unfinished thought' } })).body.id, 'draft1');
  assert.equal((await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body: { text: 'An unfinished thought', sendKey: 'key-empty' } })).status, 400);
});
test('a repeated send key delivers at most once and cannot be reused for different content', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  const body = { to: 'a@example.com', subject: 'Hi', text: 'Only once', sendKey: 'send-key-1' };
  const a = await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body });
  const b = await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body });
  assert.equal(a.body.sent, true); assert.deepEqual(a.body, b.body);
  assert.equal(f.calls.filter(c => c.path === '/messages/send').length, 1);
  const changed = await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body: { ...body, text: 'Different message' } });
  assert.equal(changed.body.error.code, 'SEND_KEY_REUSED');
});
test('parallel requests sharing a send key cannot send duplicate mail', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  const body = { to: 'a@example.com', text: 'Only once', sendKey: 'parallel-send' };
  await Promise.all([f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body }), f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body })]);
  assert.equal(f.calls.filter(c => c.path === '/messages/send').length, 1);
});
test('uncertain delivery is not silently retried and logs never include the message', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  f.gmail.call = async () => { throw new AppError(502, 'GOOGLE_NETWORK', 'Provider unreachable'); };
  const body = { to: 'a@example.com', text: 'sensitive-message-text', sendKey: 'uncertain-send' };
  const first = await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body });
  assert.equal(first.body.error.code, 'SEND_UNCERTAIN');
  const second = await f.request(`/api/accounts/${aid}/send`, { method: 'POST', session, body });
  assert.equal(second.body.error.code, 'SEND_UNCERTAIN');
  assert.equal(JSON.stringify(f.logs).includes('sensitive-message-text'), false);
});
test('unsupported actions and unlisted attachments cannot produce a Gmail mutation or data download', async () => {
  const f = fixture(); const session = await f.unlock(); const aid = await f.connected();
  assert.equal((await f.request(`/api/accounts/${aid}/messages/mail1/action`, { method: 'POST', session, body: { action: 'constructor' } })).status, 400);
  assert.equal((await f.request(`/api/accounts/${aid}/messages/mail1/attachments/not-in-this-message`, { session })).status, 404);
  assert.equal(f.calls.some(c => c.path.includes('/attachments/')), false);
});

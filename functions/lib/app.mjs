import { AppError, ensure, digest, randomToken, accountId, emailAddress, safeId, passcode, createLock, verifyLock, seal, unseal, publicAccount, limitedMap, SESSION_MS } from './security.mjs';
import { createGmail, GMAIL_SCOPE } from './gmail.mjs';
import { buildMime, messageSummary, messageBody } from './mime.mjs';

const FOLDERS = new Set(['INBOX', 'STARRED', 'SENT', 'DRAFT', 'ALL', 'SPAM', 'TRASH']);
export function createHandler({ db, auth, config, fetcher = fetch, now = Date.now, logger = console, gmail: suppliedGmail }) {
  const origin = new URL(config.origin).origin;
  config = { ...config, origin };
  const gmail = suppliedGmail || createGmail({ db, config, fetcher, now });
  const root = uid => `private/users/${uid}`;
  const read = async path => (await db.ref(path).get()).val();

  async function allowed(uid) {
    ensure(await read(`adminAllowlist/${uid}`) === true, 403, 'ADMIN_REQUIRED', 'This Google account is not an approved dashboard administrator.');
  }
  async function authenticate(req) {
    const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
    ensure(bearer, 401, 'SIGN_IN_REQUIRED', 'Sign in to your dashboard first.');
    let user;
    try { user = await auth.verifyIdToken(bearer[1], true); } catch { throw new AppError(401, 'SIGN_IN_REQUIRED', 'Your dashboard sign-in expired. Sign in again.'); }
    ensure(user.uid && !/[.#$\[\]/]/.test(user.uid), 401, 'SIGN_IN_REQUIRED', 'Invalid dashboard account.');
    await allowed(user.uid);
    return user;
  }
  async function rate(uid, name, maximum, windowMs) {
    const at = now();
    const result = await db.ref(`${root(uid)}/limits/${name}`).transaction(value => {
      const current = value && value.resetAt > at ? value : { count: 0, resetAt: at + windowMs };
      if (current.count >= maximum) return;
      return { ...current, count: current.count + 1 };
    });
    ensure(result.committed, 429, 'RATE_LIMIT', 'Too many requests. Wait a moment and try again.');
  }
  async function audit(uid, action, aid = null) {
    const key = `${now()}_${randomToken(8)}`;
    await db.ref(`${root(uid)}/audit`).transaction(value => {
      const entries = { ...(value || {}), [key]: { action, accountId: aid, at: now() } };
      const keys = Object.keys(entries).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - 100))) delete entries[old];
      return entries;
    });
  }
  async function validSession(uid, token) {
    ensure(typeof token === 'string' && /^[\w-]{43}$/.test(token), 423, 'DASHBOARD_LOCKED', 'Unlock the dashboard to continue.');
    const sessionHash = digest(token);
    const [lock, session] = await Promise.all([read(`${root(uid)}/lock`), read(`${root(uid)}/sessions/${sessionHash}`)]);
    ensure(lock && session && session.expiresAt > now() && session.version === lock.version, 423, 'DASHBOARD_LOCKED', 'Your dashboard is locked. Unlock it to continue.');
    return { lock, session, sessionHash };
  }
  async function newSession(uid, lock) {
    const token = randomToken();
    const at = now();
    const expiresAt = at + SESSION_MS;
    await db.ref(`${root(uid)}/sessions`).transaction(value => {
      const entries = Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item.expiresAt > at && item.version === lock.version));
      const sorted = Object.keys(entries).sort((a, b) => entries[a].expiresAt - entries[b].expiresAt);
      for (const old of sorted.slice(0, Math.max(0, sorted.length - 9))) delete entries[old];
      entries[digest(token)] = { expiresAt, version: lock.version };
      return entries;
    });
    return { token, expiresAt };
  }
  async function verifyPasscode(uid, value, lock) {
    const at = now();
    const result = await db.ref(`${root(uid)}/unlockAttempts`).transaction(value => {
      if (value?.blockedUntil > at) return;
      const old = value && value.windowUntil > at ? value : { count: 0, windowUntil: at + 15 * 60000 };
      return { ...old, count: old.count + 1, blockedUntil: old.count + 1 >= 5 ? at + 15 * 60000 : 0 };
    });
    ensure(result.committed, 429, 'LOCK_COOLDOWN', 'Too many incorrect passcodes. Try again in 15 minutes.');
    ensure(await verifyLock(value, lock), 401, 'PASSCODE_INVALID', 'Incorrect dashboard passcode.');
    await db.ref(`${root(uid)}/unlockAttempts`).remove();
  }
  async function getAccount(uid, aid, connected = true) {
    safeId(aid, 32);
    const record = await read(`${root(uid)}/accounts/${aid}`);
    ensure(record, 404, 'ACCOUNT_NOT_FOUND', 'This account is not saved in your dashboard.');
    if (connected) ensure(record.refreshToken, 409, 'NOT_CONNECTED', 'Connect this account to Gmail first.');
    return record;
  }
  async function saveAccount(uid, aid, fn) {
    const result = await db.ref(`${root(uid)}/accounts`).transaction(value => {
      const entries = value || {};
      if (!entries[aid] && Object.keys(entries).length >= 30) return;
      return { ...entries, [aid]: fn(entries[aid] || {}) };
    });
    ensure(result.committed, 409, 'ACCOUNT_LIMIT', 'This dashboard supports up to 30 saved accounts.');
    return result.snapshot.val()[aid];
  }
  async function oauthCallback(req, res, url) {
    const state = url.searchParams.get('state') || '';
    safeId(state, 64);
    const stateRef = db.ref(`private/oauthStates/${digest(state)}`);
    const stateRecord = (await stateRef.get()).val();
    const cookie = /(?:^|;\s*)__session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
    ensure(stateRecord && stateRecord.expiresAt > now() && cookie && digest(cookie) === stateRecord.binder, 400, 'OAUTH_STATE', 'The connection request expired or came from a different browser. Start again.');
    let consumed;
    const result = await stateRef.transaction(value => {
      if (!value || value.expiresAt <= now() || value.binder !== digest(cookie)) return;
      consumed = value; return null;
    });
    ensure(result.committed && consumed, 400, 'OAUTH_STATE', 'This connection request has already been used. Start again.');
    const uid = consumed.uid;
    await allowed(uid);
    const [lock, session] = await Promise.all([read(`${root(uid)}/lock`), read(`${root(uid)}/sessions/${consumed.sessionHash}`)]);
    ensure(lock && session && session.expiresAt > now() && session.version === lock.version, 423, 'DASHBOARD_LOCKED', 'The dashboard locked before Gmail was connected. Unlock and start again.');
    ensure(!url.searchParams.get('error'), 400, 'OAUTH_CANCELLED', 'Google authorization was cancelled.');
    const code = url.searchParams.get('code');
    ensure(code && code.length <= 4096, 400, 'OAUTH_CODE', 'No valid Google authorization code was returned.');
    const tokens = await gmail.exchange(code);
    const email = emailAddress(tokens.email);
    const aid = accountId(email);
    if (consumed.expectedAccountId) ensure(aid === consumed.expectedAccountId, 400, 'OAUTH_ACCOUNT_MISMATCH', 'The Google account you selected does not match the saved account.');
    const old = await read(`${root(uid)}/accounts/${aid}`);
    const refresh = tokens.refresh_token ? seal(tokens.refresh_token, config.vaultKey, `${uid}:${aid}:refresh`) : old?.status === 'active' ? old.refreshToken : null;
    ensure(refresh, 400, 'OAUTH_REFRESH', 'Google did not grant offline access. Remove the old app permission in Google Account settings and connect again.');
    await saveAccount(uid, aid, previous => ({ ...previous, email, label: previous.label || email.split('@')[0], refreshToken: refresh, status: 'active', connectedAt: now(), createdAt: previous.createdAt || now() }));
    await audit(uid, 'gmail.connected', aid);
    res.setHeader('Set-Cookie', '__session=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res.redirect(303, `${origin}/?oauth=connected`);
  }
  async function listMessages(uid, url) {
    const folder = url.searchParams.get('folder') || 'INBOX';
    ensure(FOLDERS.has(folder), 400, 'FOLDER_INVALID', 'Unknown mail folder.');
    const q = url.searchParams.get('q') || '';
    ensure(q.length <= 500, 400, 'SEARCH_TOO_LONG', 'Keep Gmail searches under 500 characters.');
    const filter = url.searchParams.get('account') || 'all';
    let cursors = {};
    if (url.searchParams.get('cursor')) {
      const cursor = url.searchParams.get('cursor');
      ensure(cursor.length <= 16000, 400, 'CURSOR_INVALID', 'Invalid inbox cursor.');
      try { cursors = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new AppError(400, 'CURSOR_INVALID', 'Invalid inbox cursor.'); }
      ensure(cursors && typeof cursors === 'object' && !Array.isArray(cursors), 400, 'CURSOR_INVALID', 'Invalid inbox cursor.');
    }
    const all = await read(`${root(uid)}/accounts`) || {};
    if (filter !== 'all') { safeId(filter, 32); ensure(all[filter], 404, 'ACCOUNT_NOT_FOUND', 'This account is not saved in your dashboard.'); }
    const accounts = Object.entries(all).filter(([aid, record]) => record.refreshToken && (filter === 'all' || aid === filter) && (!url.searchParams.get('cursor') || Object.hasOwn(cursors, aid)));
    const pages = await limitedMap(accounts, 3, async ([aid, record]) => {
      try {
        const pageToken = cursors[aid];
        ensure(pageToken === undefined || typeof pageToken === 'string' && pageToken.length <= 4096, 400, 'CURSOR_INVALID', 'Invalid inbox cursor.');
        const maxResults = filter === 'all' ? 12 : 30;
        let list, draftIds = {};
        if (folder === 'DRAFT') {
          list = await gmail.call(uid, aid, record, '/drafts', { query: { maxResults, pageToken, q } });
          for (const draft of list.drafts || []) draftIds[draft.message.id] = draft.id;
          list.messages = (list.drafts || []).map(draft => draft.message);
        } else {
          list = await gmail.call(uid, aid, record, '/messages', { query: { maxResults, pageToken, q: folder === 'ALL' ? `${q} -in:spam -in:trash`.trim() : q, labelIds: folder === 'ALL' ? undefined : [folder], includeSpamTrash: ['SPAM', 'TRASH'].includes(folder) } });
        }
        const messages = await limitedMap(list.messages || [], 5, async item => {
          const data = await gmail.call(uid, aid, record, `/messages/${safeId(item.id)}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } });
          return { ...messageSummary(data, aid, record.email), ...(draftIds[item.id] ? { draftId: draftIds[item.id] } : {}) };
        });
        return { aid, messages, next: list.nextPageToken || null };
      } catch (err) {
        return { aid, messages: [], error: { accountId: aid, email: record.email, code: err.code || 'GMAIL_ERROR', message: err instanceof AppError ? err.message : 'This inbox could not be loaded.' } };
      }
    });
    const next = Object.fromEntries(pages.filter(p => p.next).map(p => [p.aid, p.next]));
    return { messages: pages.flatMap(p => p.messages).sort((a, b) => b.date - a.date), nextCursor: Object.keys(next).length ? Buffer.from(JSON.stringify(next)).toString('base64url') : null, errors: pages.filter(p => p.error).map(p => p.error) };
  }
  async function sendMail(uid, aid, record, input) {
    const raw = buildMime(input, record.email);
    safeId(input.sendKey, 100);
    const payloadHash = digest(JSON.stringify({ aid, to: input.to || '', cc: input.cc || '', bcc: input.bcc || '', subject: input.subject || '', text: input.text || '', attachments: input.attachments || [], draftId: input.draftId || '', threadId: input.threadId || '', inReplyTo: input.inReplyTo || '', references: input.references || '' }));
    const opRef = db.ref(`${root(uid)}/sendOperations/${digest(input.sendKey)}`);
    const prior = (await opRef.get()).val();
    if (prior) ensure(prior.accountId === aid && prior.payloadHash === payloadHash, 409, 'SEND_KEY_REUSED', 'This send identifier was used with different message content.');
    if (prior?.status === 'sent') { ensure(prior.accountId === aid, 409, 'SEND_KEY_REUSED', 'This send identifier belongs to another account.'); return prior.result; }
    const claimed = await opRef.transaction(value => value ? undefined : { status: 'sending', accountId: aid, payloadHash, at: now() });
    if (!claimed.committed) {
      const operation = (await opRef.get()).val();
      ensure(operation?.accountId === aid && operation.payloadHash === payloadHash, 409, 'SEND_KEY_REUSED', 'This send identifier was used with different message content.');
      if (operation?.status === 'sent') return operation.result;
      if (operation?.status === 'failed') throw new AppError(operation.error.status, operation.error.code, operation.error.message);
      throw new AppError(409, 'SEND_UNCERTAIN', 'This send was already started. Check Sent before trying to send it again.');
    }
    let sent;
    try {
      await rate(uid, 'send', 30, 3600000);
      const message = { raw, ...(input.threadId ? { threadId: safeId(input.threadId) } : {}) };
      if (input.draftId) {
        const draftId = safeId(input.draftId);
        await gmail.call(uid, aid, record, `/drafts/${draftId}`, { method: 'PUT', body: { message } });
        sent = await gmail.call(uid, aid, record, '/drafts/send', { method: 'POST', body: { id: draftId } });
      } else sent = await gmail.call(uid, aid, record, '/messages/send', { method: 'POST', body: message });
    } catch (err) {
      const uncertain = ['GOOGLE_NETWORK', 'GOOGLE_API'].includes(err.code) || !(err instanceof AppError);
      await opRef.set({ status: uncertain ? 'unknown' : 'failed', accountId: aid, payloadHash, at: now(), ...(!uncertain ? { error: { status: err.status, code: err.code, message: err.message } } : {}) });
      if (uncertain) throw new AppError(502, 'SEND_UNCERTAIN', 'Delivery could not be confirmed. Check Sent before sending again; do not assume it failed.');
      throw err;
    }
    const result = { id: sent.id, threadId: sent.threadId, sent: true };
    // A Gmail send may have succeeded even if recording/auditing subsequently fails.
    try { await opRef.set({ status: 'sent', accountId: aid, payloadHash, at: now(), result }); await audit(uid, 'mail.sent', aid); }
    catch { throw new AppError(502, 'SEND_UNCERTAIN', 'Gmail accepted the message, but confirmation could not be saved. Check Sent before sending again.'); }
    return result;
  }

  return async function handler(req, res) {
    const requestId = randomToken(8);
    const url = new URL(req.originalUrl || req.url || req.path, origin);
    const path = url.pathname.replace(/\/$/, '');
    const method = req.method.toUpperCase();
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Vary', 'Authorization, X-Vault-Session');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (path === '/api/health' && method === 'GET') return res.json({ status: 'ok' });
      if (path === '/api/oauth/callback' && method === 'GET') return await oauthCallback(req, res, url);
      ensure(!req.headers.origin || req.headers.origin === origin, 403, 'ORIGIN_DENIED', 'Requests from this website are not allowed.');
      ensure(['GET', 'POST', 'PUT', 'DELETE'].includes(method), 405, 'METHOD_DENIED', 'This request method is not supported.');
      if (method !== 'GET') ensure(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 415, 'JSON_REQUIRED', 'Send a JSON request.');
      ensure(!req.rawBody || req.rawBody.length <= 9 * 1024 * 1024, 413, 'REQUEST_TOO_LARGE', 'The request is too large. Attachments must total 6 MB or less.');
      const user = await authenticate(req);
      const uid = user.uid;
      await rate(uid, 'api', 150, 60000);
      const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (path === '/api/session' && method === 'GET') return res.json({ uid, email: user.email || '', configured: Boolean(await read(`${root(uid)}/lock`)), sessionMinutes: SESSION_MS / 60000 });
      if (path === '/api/lock/setup' && method === 'POST') {
        const lock = await createLock(input.passcode, now());
        const setup = await db.ref(`${root(uid)}/lock`).transaction(value => value ? undefined : lock);
        ensure(setup.committed, 409, 'LOCK_EXISTS', 'The dashboard already has a passcode. Unlock it instead.');
        await audit(uid, 'lock.created');
        return res.json(await newSession(uid, lock));
      }
      if (path === '/api/lock/unlock' && method === 'POST') {
        const lock = await read(`${root(uid)}/lock`);
        ensure(lock, 409, 'LOCK_NOT_CONFIGURED', 'Create a dashboard passcode first.');
        await verifyPasscode(uid, input.passcode, lock);
        return res.json(await newSession(uid, lock));
      }
      if (path === '/api/lock' && method === 'POST') {
        const token = req.headers['x-vault-session'];
        if (typeof token === 'string' && /^[\w-]{43}$/.test(token)) await db.ref(`${root(uid)}/sessions/${digest(token)}`).remove();
        return res.json({ locked: true });
      }
      const { lock } = await validSession(uid, req.headers['x-vault-session']);
      if (path === '/api/lock/change' && method === 'POST') {
        await verifyPasscode(uid, input.currentPasscode, lock);
        const replacement = await createLock(input.passcode, now());
        // Change the version atomically. Any session with an older version is immediately rejected.
        const changed = await db.ref(`${root(uid)}/lock`).transaction(value => value?.version === lock.version ? replacement : undefined);
        ensure(changed.committed, 409, 'LOCK_CHANGED', 'The lock changed in another session. Unlock again.');
        await db.ref(`${root(uid)}/sessions`).remove();
        await audit(uid, 'lock.changed');
        return res.json(await newSession(uid, replacement));
      }
      if (path === '/api/accounts' && method === 'GET') {
        const records = await read(`${root(uid)}/accounts`) || {};
        return res.json({ accounts: Object.entries(records).map(([id, record]) => publicAccount(id, record)) });
      }
      if (path === '/api/accounts' && method === 'PUT') {
        const email = emailAddress(input.email);
        const aid = accountId(email);
        ensure(typeof input.label === 'string' && input.label.length <= 60, 400, 'LABEL_INVALID', 'Account labels must be under 60 characters.');
        ensure(input.password === undefined || typeof input.password === 'string' && input.password.length <= 2048, 400, 'PASSWORD_INVALID', 'The saved password is too long.');
        const record = await saveAccount(uid, aid, previous => {
          const next = { ...previous, email, label: input.label.trim(), createdAt: previous.createdAt || now() };
          if (input.password) next.password = seal(input.password, config.vaultKey, `${uid}:${aid}:password`);
          if (input.clearPassword) delete next.password;
          return next;
        });
        await audit(uid, 'account.saved', aid);
        return res.json({ account: publicAccount(aid, record) });
      }
      const accountPath = /^\/api\/accounts\/([\w-]+)$/.exec(path);
      if (accountPath && method === 'DELETE') {
        await getAccount(uid, accountPath[1], false);
        await db.ref(`${root(uid)}/accounts/${accountPath[1]}`).remove();
        await audit(uid, 'account.removed', accountPath[1]);
        return res.json({ removed: true });
      }
      const passwordPath = /^\/api\/accounts\/([\w-]+)\/password$/.exec(path);
      if (passwordPath && method === 'POST') {
        await rate(uid, 'reveal', 5, 60000);
        const aid = passwordPath[1]; const record = await getAccount(uid, aid, false);
        ensure(record.password, 404, 'PASSWORD_NOT_SAVED', 'This account has no saved password.');
        await audit(uid, 'password.revealed', aid);
        return res.json({ password: unseal(record.password, config.vaultKey, `${uid}:${aid}:password`) });
      }
      const disconnectPath = /^\/api\/accounts\/([\w-]+)\/disconnect$/.exec(path);
      if (disconnectPath && method === 'POST') {
        const aid = disconnectPath[1]; await getAccount(uid, aid, false);
        await db.ref(`${root(uid)}/accounts/${aid}`).update({ refreshToken: null, status: 'saved', connectedAt: null });
        await audit(uid, 'gmail.disconnected', aid);
        return res.json({ disconnected: true });
      }
      if (path === '/api/audit' && method === 'GET') {
        const events = await read(`${root(uid)}/audit`) || {};
        return res.json({ events: Object.entries(events).map(([id, event]) => ({ id, ...event })).sort((a, b) => b.at - a.at) });
      }
      if (path === '/api/oauth/start' && method === 'POST') {
        await rate(uid, 'connect', 10, 3600000);
        let hint = '', expectedAccountId = null;
        if (input.accountId) { const record = await getAccount(uid, input.accountId, false); hint = record.email; expectedAccountId = input.accountId; }
        const state = randomToken(); const binder = randomToken();
        const sessionHash = digest(req.headers['x-vault-session']);
        // Bound the state store: only one pending Google connection per dashboard owner.
        const previous = await read(`${root(uid)}/pendingOAuth`);
        if (previous) await db.ref(`private/oauthStates/${previous}`).remove();
        await db.ref(`private/oauthStates/${digest(state)}`).set({ uid, sessionHash, binder: digest(binder), expiresAt: now() + 10 * 60000, expectedAccountId });
        await db.ref(`${root(uid)}/pendingOAuth`).set(digest(state));
        res.setHeader('Set-Cookie', `__session=${binder}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
        const authURL = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        Object.entries({ client_id: config.clientId, redirect_uri: `${origin}/api/oauth/callback`, response_type: 'code', scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent select_account', state, ...(hint ? { login_hint: hint } : {}) }).forEach(([k, v]) => authURL.searchParams.set(k, v));
        return res.json({ url: authURL.href });
      }
      if (path === '/api/messages' && method === 'GET') return res.json(await listMessages(uid, url));
      const threadPath = /^\/api\/accounts\/([\w-]+)\/threads\/([\w-]+)$/.exec(path);
      if (threadPath && method === 'GET') {
        const [, aid, tid] = threadPath; const record = await getAccount(uid, aid);
        const thread = await gmail.call(uid, aid, record, `/threads/${safeId(tid)}`, { query: { format: 'full' } });
        const result = { id: thread.id, messages: (thread.messages || []).map(m => messageBody(m, aid, record.email)) };
        // Large body parts may be referenced as attachments. Load those only within the Hosting limit.
        await limitedMap(result.messages, 4, async message => {
          for (const part of message.attachments.filter(a => a.bodyPart && a.size <= 1024 * 1024)) {
            const body = await gmail.call(uid, aid, record, `/messages/${safeId(message.id)}/attachments/${safeId(part.id, 1024)}`);
            message[part.type === 'text/html' ? 'html' : 'text'] += Buffer.from(body.data || '', 'base64url').toString('utf8');
            message.attachments = message.attachments.filter(a => a !== part);
          }
        });
        ensure(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024, 413, 'THREAD_TOO_LARGE', 'This conversation is too large for the dashboard. Open it in Gmail.');
        return res.json(result);
      }
      const attachmentPath = /^\/api\/accounts\/([\w-]+)\/messages\/([\w-]+)\/attachments\/([\w-]+)$/.exec(path);
      if (attachmentPath && method === 'GET') {
        const [, aid, mid, attachmentId] = attachmentPath; const record = await getAccount(uid, aid);
        const message = await gmail.call(uid, aid, record, `/messages/${safeId(mid)}`, { query: { format: 'full' } });
        const file = messageBody(message, aid, record.email).attachments.find(a => a.id === attachmentId);
        ensure(file, 404, 'ATTACHMENT_NOT_FOUND', 'This attachment is not part of the selected message.');
        ensure(file.size <= 6 * 1024 * 1024, 413, 'DOWNLOAD_TOO_LARGE', 'Download attachments larger than 6 MB from Gmail.');
        const attachment = await gmail.call(uid, aid, record, `/messages/${safeId(mid)}/attachments/${safeId(attachmentId, 1024)}`);
        ensure(String(attachment.data || '').length <= 8 * 1024 * 1024, 413, 'DOWNLOAD_TOO_LARGE', 'This attachment is too large for the dashboard.');
        return res.json({ data: attachment.data, name: file.name, type: file.type });
      }
      const modifyPath = /^\/api\/accounts\/([\w-]+)\/messages\/([\w-]+)\/action$/.exec(path);
      if (modifyPath && method === 'POST') {
        const [, aid, mid] = modifyPath; const record = await getAccount(uid, aid); safeId(mid);
        const actions = {
          read: { removeLabelIds: ['UNREAD'] }, unread: { addLabelIds: ['UNREAD'] },
          star: { addLabelIds: ['STARRED'] }, unstar: { removeLabelIds: ['STARRED'] },
          archive: { removeLabelIds: ['INBOX'] }, spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
          notspam: { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] }
        };
        if (['trash', 'restore'].includes(input.action)) {
          await gmail.call(uid, aid, record, `/messages/${mid}/${input.action === 'trash' ? 'trash' : 'untrash'}`, { method: 'POST' });
        } else {
          ensure(Object.hasOwn(actions, input.action), 400, 'ACTION_INVALID', 'Unknown inbox action.');
          await gmail.call(uid, aid, record, `/messages/${mid}/modify`, { method: 'POST', body: actions[input.action] });
        }
        return res.json({ updated: true });
      }
      const draftsPath = /^\/api\/accounts\/([\w-]+)\/drafts(?:\/([\w-]+))?$/.exec(path);
      if (draftsPath) {
        const [, aid, did] = draftsPath; const record = await getAccount(uid, aid);
        if (method === 'GET' && did) {
          const draft = await gmail.call(uid, aid, record, `/drafts/${safeId(did)}`, { query: { format: 'full' } });
          return res.json({ id: draft.id, message: messageBody(draft.message, aid, record.email) });
        }
        if (method === 'DELETE' && did) {
          await gmail.call(uid, aid, record, `/drafts/${safeId(did)}`, { method: 'DELETE' });
          return res.json({ removed: true });
        }
        if (method === 'POST' && !did) {
          const message = { raw: buildMime(input, record.email, { draft: true }), ...(input.threadId ? { threadId: safeId(input.threadId) } : {}) };
          const draft = await gmail.call(uid, aid, record, input.draftId ? `/drafts/${safeId(input.draftId)}` : '/drafts', { method: input.draftId ? 'PUT' : 'POST', body: { message } });
          return res.json({ id: draft.id, messageId: draft.message?.id });
        }
      }
      const sendPath = /^\/api\/accounts\/([\w-]+)\/send$/.exec(path);
      if (sendPath && method === 'POST') {
        const aid = sendPath[1]; const record = await getAccount(uid, aid);
        return res.json(await sendMail(uid, aid, record, input));
      }
      throw new AppError(404, 'NOT_FOUND', 'This API route does not exist.');
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const code = err instanceof AppError ? err.code : 'SERVER_ERROR';
      const message = err instanceof AppError ? err.message : 'The server could not complete this request. Check its configuration and try again.';
      // Do not log request bodies, Google responses, auth codes, tokens, or passwords.
      if (status >= 500) logger.error('Mailroom request failed', { requestId, code });
      if (path === '/api/oauth/callback') return res.redirect(303, `${origin}/?oauth=error&code=${encodeURIComponent(code)}`);
      return res.status(status).json({ error: { code, message, requestId } });
    }
  };
}

// Pure Firebase Realtime Database Client for Mailroom
let dbUrl = 'https://firemailai-default-rtdb.firebaseio.com';

export async function initRTDB() {
  try {
    const res = await fetch('/firebase-config.json', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.databaseURL) dbUrl = cfg.databaseURL.replace(/\/+$/, '');
    }
  } catch (err) {
    console.warn('Using default RTDB URL', err);
  }
  return dbUrl;
}

function rtdbUrl(path) {
  const clean = path.replace(/^\/+/, '');
  return `${dbUrl}/${clean}.json`;
}

async function request(path, method = 'GET', body = null) {
  const url = rtdbUrl(path);
  const options = {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== null && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`RTDB Error: ${res.statusText} (${res.status})`);
  return res.json();
}

// Passcode Hashing using Web Crypto API
export async function hashPasscode(passcode, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${passcode}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Lock APIs
export async function getLockStatus() {
  const lock = await request('mailroom/lock');
  if (!lock || !lock.hash || !lock.salt) {
    return { configured: false };
  }
  return { configured: true, salt: lock.salt, hash: lock.hash };
}

export async function setupPasscode(passcode) {
  if (!passcode || passcode.length < 4) {
    throw new Error('Passcode must be at least 4 characters.');
  }
  const salt = generateSalt();
  const hash = await hashPasscode(passcode, salt);
  const lockData = {
    salt,
    hash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1
  };
  await request('mailroom/lock', 'PUT', lockData);
  await logAudit('lock.created');
  return { token: crypto.randomUUID(), expiresAt: Date.now() + 30 * 60000 };
}

export async function verifyPasscode(passcode) {
  const status = await getLockStatus();
  if (!status.configured) {
    throw new Error('Lock is not configured yet.');
  }
  const computedHash = await hashPasscode(passcode, status.salt);
  if (computedHash !== status.hash) {
    throw new Error('Incorrect dashboard passcode. Please try again.');
  }
  await logAudit('dashboard.unlocked');
  return { token: crypto.randomUUID(), expiresAt: Date.now() + 30 * 60000 };
}

export async function changePasscode(currentPasscode, newPasscode) {
  if (!newPasscode || newPasscode.length < 4) {
    throw new Error('New passcode must be at least 4 characters.');
  }
  await verifyPasscode(currentPasscode);
  const salt = generateSalt();
  const hash = await hashPasscode(newPasscode, salt);
  const lockData = {
    salt,
    hash,
    updatedAt: Date.now(),
    version: 2
  };
  await request('mailroom/lock', 'PUT', lockData);
  await logAudit('lock.changed');
  return { token: crypto.randomUUID(), expiresAt: Date.now() + 30 * 60000 };
}

// Accounts APIs
export async function getAccounts() {
  const data = await request('mailroom/accounts');
  if (!data) return [];
  return Object.values(data).map(acc => ({
    id: acc.id,
    email: acc.email,
    label: acc.label || acc.email.split('@')[0],
    connected: true,
    hasPassword: Boolean(acc.password),
    status: 'connected',
    createdAt: acc.createdAt || Date.now()
  }));
}

export async function getAccountPassword(accountId) {
  const acc = await request(`mailroom/accounts/${accountId}`);
  if (!acc) throw new Error('Account not found');
  await logAudit('password.revealed', accountId);
  return acc.password || '';
}

export async function saveAccount({ id, email, label, password, clearPassword }) {
  if (!email || !email.includes('@')) throw new Error('Please enter a valid Gmail address.');
  const accountId = id || 'acc_' + Math.random().toString(36).slice(2, 10);
  let existing = null;
  if (id) {
    existing = await request(`mailroom/accounts/${id}`);
  }
  
  let savedPassword = password;
  if (clearPassword) {
    savedPassword = '';
  } else if (!savedPassword && existing) {
    savedPassword = existing.password || '';
  }

  const payload = {
    id: accountId,
    email: email.trim().toLowerCase(),
    label: (label || email.split('@')[0]).trim(),
    password: savedPassword || '',
    connected: true,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  await request(`mailroom/accounts/${accountId}`, 'PUT', payload);
  await logAudit('account.saved', accountId);

  return payload;
}

export async function removeAccount(accountId) {
  await request(`mailroom/accounts/${accountId}`, 'DELETE');
  await logAudit('account.removed', accountId);
  return { success: true };
}

// Messages APIs
// Ultra-Fast In-Memory & Session Caching
let _messagesCache = null;
let _bodyCache = {};
let _lastFetchTime = 0;
const CACHE_TTL = 30000; // Cache valid for 30 seconds

// Load cache from sessionStorage on startup
try {
  const saved = sessionStorage.getItem('firemail_msgs_cache');
  if (saved) {
    const parsed = JSON.parse(saved);
    if (Date.now() - parsed.savedAt < 120000) {
      _messagesCache = parsed.data;
      _lastFetchTime = parsed.savedAt;
    }
  }
} catch {}

export function invalidateMessageCache() {
  _messagesCache = null;
  _lastFetchTime = 0;
  try { sessionStorage.removeItem('firemail_msgs_cache'); } catch {}
}

// Messages APIs (Optimized for Sub-Second Loading)
export async function getMessages({ folder = 'INBOX', account = 'all', q = '', forceRefresh = false } = {}) {
  const now = Date.now();
  const isCacheValid = _messagesCache && (now - _lastFetchTime < CACHE_TTL) && !forceRefresh;

  if (!isCacheValid) {
    try {
      const data = await request('mailroom/messages');
      if (data) {
        _messagesCache = Object.values(data);
        _lastFetchTime = now;
        try {
          sessionStorage.setItem('firemail_msgs_cache', JSON.stringify({ savedAt: now, data: _messagesCache }));
        } catch {}
      } else {
        _messagesCache = [];
      }
    } catch (err) {
      console.warn('Failed to refresh messages, falling back to cache:', err);
      if (!_messagesCache) throw err;
    }
  }

  let list = [...(_messagesCache || [])];

  // Filter by account
  if (account && account !== 'all') {
    list = list.filter(m => m.accountId === account);
  }

  // Filter by folder
  if (folder === 'INBOX') {
    list = list.filter(m => m.folder === 'INBOX' || (m.labels && m.labels.includes('INBOX')));
  } else if (folder === 'STARRED') {
    list = list.filter(m => m.starred);
  } else if (folder === 'SENT') {
    list = list.filter(m => m.folder === 'SENT');
  } else if (folder === 'DRAFT') {
    list = list.filter(m => m.folder === 'DRAFT' || m.draftId);
  } else if (folder === 'SPAM') {
    list = list.filter(m => m.folder === 'SPAM');
  } else if (folder === 'TRASH') {
    list = list.filter(m => m.folder === 'TRASH');
  } else if (folder === 'ALL') {
    list = list.filter(m => m.folder !== 'SPAM' && m.folder !== 'TRASH');
  }

  // Filter by search query
  if (q && q.trim()) {
    const term = q.toLowerCase().trim();
    list = list.filter(m => {
      const subject = (m.subject || '').toLowerCase();
      const snippet = (m.snippet || '').toLowerCase();
      const from = (m.from || '').toLowerCase();
      const to = (m.to || '').toLowerCase();
      return subject.includes(term) || snippet.includes(term) || from.includes(term) || to.includes(term);
    });
  }

  list.sort((a, b) => (b.date || 0) - (a.date || 0));

  return { messages: list, errors: [], nextCursor: null };
}

export async function getThread(accountId, threadId) {
  // 1. Find summary from local cache or single fetch (instant)
  let summary = _messagesCache?.find(m => m.id === threadId || m.threadId === threadId);
  if (!summary) {
    summary = await request(`mailroom/messages/${threadId}`);
  }
  if (!summary) throw new Error('Message not found');

  // 2. Fetch only this single message's body on demand (fast, ~1-5 KB)
  let body = _bodyCache[threadId];
  if (!body) {
    try {
      body = await request(`mailroom/bodies/${threadId}`);
      if (body) _bodyCache[threadId] = body;
    } catch {
      // Fallback if body is still stored inline in old format
      body = summary;
    }
  }

  const finalBody = body || summary;

  return {
    id: threadId,
    messages: [{
      id: summary.id,
      threadId: summary.threadId || summary.id,
      accountId: summary.accountId,
      accountEmail: summary.accountEmail || summary.to || '',
      from: summary.from || '',
      to: summary.to || '',
      cc: summary.cc || '',
      bcc: summary.bcc || '',
      subject: summary.subject || '',
      snippet: summary.snippet || '',
      text: finalBody.text || summary.snippet || '',
      html: finalBody.html || `<div style="font-family:sans-serif;line-height:1.6;color:#333"><p>${(finalBody.text || summary.snippet || '').replace(/\n/g, '<br>')}</p></div>`,
      date: summary.date || Date.now(),
      unread: Boolean(summary.unread),
      starred: Boolean(summary.starred),
      labels: summary.labels || ['INBOX'],
      attachments: finalBody.attachments || []
    }]
  };
}

export async function messageAction(accountId, messageId, action) {
  const msg = await request(`mailroom/messages/${messageId}`);
  if (!msg) return;

  const updates = {};
  if (action === 'star') updates.starred = true;
  else if (action === 'unstar') updates.starred = false;
  else if (action === 'read') updates.unread = false;
  else if (action === 'unread') updates.unread = true;
  else if (action === 'archive') {
    updates.folder = 'ALL';
    updates.labels = (msg.labels || []).filter(l => l !== 'INBOX');
  } else if (action === 'trash') {
    updates.folder = 'TRASH';
    updates.labels = ['TRASH'];
  } else if (action === 'restore') {
    updates.folder = 'INBOX';
    updates.labels = ['INBOX'];
  } else if (action === 'spam') {
    updates.folder = 'SPAM';
    updates.labels = ['SPAM'];
  } else if (action === 'notspam') {
    updates.folder = 'INBOX';
    updates.labels = ['INBOX'];
  }

  await request(`mailroom/messages/${messageId}`, 'PATCH', updates);
  invalidateMessageCache();
  return { ok: true };
}

export async function saveDraftMessage(accountId, payload) {
  const id = payload.draftId || 'msg_' + Math.random().toString(36).slice(2, 11);
  const accounts = await getAccounts();
  const acc = accounts.find(a => a.id === accountId) || { email: 'you@gmail.com' };

  const message = {
    id,
    draftId: id,
    threadId: payload.threadId || id,
    accountId,
    accountEmail: acc.email,
    from: acc.email,
    to: payload.to || '',
    cc: payload.cc || '',
    bcc: payload.bcc || '',
    subject: payload.subject || '(No subject)',
    snippet: payload.text ? payload.text.slice(0, 140) : 'Draft message',
    text: payload.text || '',
    html: payload.text ? `<p>${payload.text.replace(/\n/g, '<br>')}</p>` : '',
    date: Date.now(),
    unread: false,
    starred: false,
    folder: 'DRAFT',
    labels: ['DRAFT'],
    attachments: payload.attachments || []
  };

  await request(`mailroom/messages/${id}`, 'PUT', message);
  invalidateMessageCache();
  return { id };
}

export async function sendEmailMessage(accountId, payload) {
  const id = 'msg_' + Math.random().toString(36).slice(2, 11);
  const accounts = await getAccounts();
  const acc = accounts.find(a => a.id === accountId) || { email: 'you@gmail.com' };

  if (!payload.to || !payload.to.trim()) {
    throw new Error('Please add at least one recipient in the To field.');
  }

  // Delete draft if editing one
  if (payload.draftId) {
    try { await request(`mailroom/messages/${payload.draftId}`, 'DELETE'); } catch {}
  }

  const message = {
    id,
    threadId: payload.threadId || id,
    accountId,
    accountEmail: acc.email,
    from: acc.email,
    to: payload.to.trim(),
    cc: payload.cc || '',
    bcc: payload.bcc || '',
    subject: payload.subject || '(No subject)',
    snippet: payload.text ? payload.text.slice(0, 140) : 'Sent message',
    text: payload.text || '',
    html: `<div style="font-family:sans-serif;line-height:1.6;color:#222"><p>${(payload.text || '').replace(/\n/g, '<br>')}</p></div>`,
    date: Date.now(),
    unread: false,
    starred: false,
    folder: 'SENT',
    labels: ['SENT'],
    attachments: payload.attachments || []
  };

  await request(`mailroom/messages/${id}`, 'PUT', message);
  await logAudit('mail.sent', accountId);
  invalidateMessageCache();
  return { sent: true, id };
}

// Audit Logs
export async function logAudit(action, accountId = null) {
  const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const entry = {
    id,
    action,
    accountId,
    at: Date.now()
  };
  try {
    await request(`mailroom/audit/${id}`, 'PUT', entry);
  } catch (err) {
    console.warn('Could not log audit event', err);
  }
}

export async function getAudit() {
  const data = await request('mailroom/audit');
  if (!data) return { events: [] };
  const events = Object.values(data).sort((a, b) => b.at - a.at);
  return { events };
}

export async function triggerSyncRequest() {
  await request('mailroom/syncTrigger', 'PUT', { requestedAt: Date.now() });
  invalidateMessageCache();
  return { requested: true };
}

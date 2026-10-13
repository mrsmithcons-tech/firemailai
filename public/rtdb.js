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

// Plan Definitions
export const PLANS = {
  FREE: { id: 'free', name: 'Free Plan', maxAccounts: 5, price: '$0/mo', description: 'Save up to 5 emails / accounts' },
  STARTER: { id: 'starter', name: 'Starter Plan', maxAccounts: 10, price: '$2/mo', description: 'Save up to 10 emails / accounts' },
  PRO: { id: 'pro', name: 'Pro Plan', maxAccounts: 25, price: '$5/mo', description: 'Save up to 25 emails / accounts' },
  BUSINESS: { id: 'business', name: 'Business Plan', maxAccounts: 50, price: '$10/mo', description: 'Save up to 50 emails / accounts' },
  CUSTOM: { id: 'custom', name: 'Enterprise', maxAccounts: 9999, price: 'Custom', description: 'More than 50 emails - Contact mrsmithcons@gmail.com' }
};

// Lock & Multi-Workspace APIs
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
  return { token: crypto.randomUUID(), expiresAt: Date.now() + 30 * 60000, role: 'owner' };
}

// User Workspace Creation (Allow anyone to create passcode & workspace)
export async function createWorkspace({ name, passcode, email = '', phone = '' }) {
  if (!passcode || passcode.length < 4) {
    throw new Error('Passcode must be at least 4 characters.');
  }
  const wsId = 'ws_' + Math.random().toString(36).slice(2, 10);
  const salt = generateSalt();
  const hash = await hashPasscode(passcode, salt);

  const workspace = {
    id: wsId,
    name: name || 'My Mailroom',
    salt,
    hash,
    plan: 'free',
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await request(`mailroom/workspaces/${wsId}`, 'PUT', workspace);

  // Initialize default profile
  await saveProfile(wsId, {
    name: name || 'Workspace User',
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    plan: 'free',
    createdAt: Date.now()
  });

  // Log in admin recovery directory
  if (email) {
    await request(`mailroom/admin/recovery/${encodeURIComponent(email.replace(/[.$#[\]]/g, '_'))}`, 'PUT', {
      workspaceId: wsId,
      email,
      name,
      createdAt: Date.now()
    });
  }

  await logAudit('workspace.created', wsId);
  return {
    token: crypto.randomUUID(),
    workspaceId: wsId,
    name: workspace.name,
    plan: 'free',
    expiresAt: Date.now() + 30 * 60000,
    role: 'owner'
  };
}

export async function verifyPasscode(passcode) {
  // 1. Check Master / Owner Lock
  const status = await getLockStatus();
  if (status.configured) {
    const computedHash = await hashPasscode(passcode, status.salt);
    if (computedHash === status.hash) {
      await logAudit('dashboard.unlocked');
      const profile = await getProfile('master');
      return {
        token: crypto.randomUUID(),
        workspaceId: 'master',
        role: 'owner',
        plan: profile.plan || 'free',
        expiresAt: Date.now() + 30 * 60000
      };
    }
  }

  // 2. Check User Workspaces (Multi-tenant)
  const workspacesData = await request('mailroom/workspaces');
  if (workspacesData) {
    for (const ws of Object.values(workspacesData)) {
      if (ws.salt && ws.hash) {
        const h = await hashPasscode(passcode, ws.salt);
        if (h === ws.hash) {
          await logAudit('workspace.unlocked', ws.id);
          const profile = await getProfile(ws.id);
          return {
            token: crypto.randomUUID(),
            workspaceId: ws.id,
            role: 'owner',
            name: ws.name,
            plan: ws.plan || profile.plan || 'free',
            expiresAt: Date.now() + 30 * 60000
          };
        }
      }
    }
  }

  // 3. Check Shared Inboxes (Guest Passcode Access)
  const sharesData = await request('mailroom/shares');
  if (sharesData) {
    for (const share of Object.values(sharesData)) {
      if (share.salt && share.hash) {
        const sh = await hashPasscode(passcode, share.salt);
        if (sh === share.hash) {
          await logAudit('share.accessed', share.id);
          const matchedIds = Array.isArray(share.accountIds) && share.accountIds.length ? share.accountIds : [share.accountId];
          const matchedEmails = Array.isArray(share.accountEmails) && share.accountEmails.length ? share.accountEmails : [share.accountEmail];
          return {
            token: crypto.randomUUID(),
            isShared: true,
            role: 'guest',
            shareId: share.id,
            accountId: matchedIds[0],
            accountIds: matchedIds,
            accountEmail: matchedEmails[0],
            accountEmails: matchedEmails,
            label: share.label || 'Shared Inbox',
            shareType: share.shareType || 'all',
            filterSender: share.filterSender || '',
            selectedMessageIds: Array.isArray(share.selectedMessageIds) ? share.selectedMessageIds : [],
            permissions: share.permissions || { canRead: true, canCompose: true },
            expiresAt: Date.now() + 60 * 60000
          };
        }
      }
    }
  }

  throw new Error('Incorrect passcode. Please check your passcode or contact admin at mrsmithcons@gmail.com.');
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

// User Profile APIs
export async function getProfile(workspaceId = 'master') {
  const profile = await request(`mailroom/profiles/${workspaceId}`);
  return profile || {
    name: 'Chen Yu Ting',
    email: 'mrsmithcons@gmail.com',
    phone: '',
    bio: 'Firemail AI Administrator',
    company: 'MrSmith Consulting',
    plan: 'free',
    createdAt: Date.now()
  };
}

export async function saveProfile(workspaceId = 'master', data = {}) {
  const existing = await getProfile(workspaceId);
  const payload = {
    ...existing,
    ...data,
    updatedAt: Date.now()
  };
  await request(`mailroom/profiles/${workspaceId}`, 'PUT', payload);
  await logAudit('profile.updated', workspaceId);
  return payload;
}

// Shared Inboxes Management (Share specific inboxes via Passcode)
export async function getSharedInboxes() {
  const data = await request('mailroom/shares');
  if (!data) return [];
  return Object.values(data).map(s => ({
    id: s.id,
    accountId: s.accountId,
    accountIds: Array.isArray(s.accountIds) && s.accountIds.length ? s.accountIds : [s.accountId],
    accountEmail: s.accountEmail,
    accountEmails: Array.isArray(s.accountEmails) && s.accountEmails.length ? s.accountEmails : [s.accountEmail],
    label: s.label || 'Shared View',
    createdAt: s.createdAt,
    shareType: s.shareType || 'all',
    filterSender: s.filterSender || '',
    selectedMessageIds: Array.isArray(s.selectedMessageIds) ? s.selectedMessageIds : [],
    permissions: s.permissions || { canRead: true, canCompose: true }
  }));
}

export async function createSharedInbox({
  accountId,
  accountIds = [],
  label,
  passcode,
  shareType = 'all',
  filterSender = '',
  selectedMessageIds = [],
  permissions = { canRead: true, canCompose: true }
}) {
  if (!passcode || passcode.length < 4) {
    throw new Error('Share passcode must be at least 4 characters.');
  }
  const allAccounts = await getAccounts();
  const targetIds = Array.isArray(accountIds) && accountIds.length ? accountIds : (accountId ? [accountId] : []);
  if (!targetIds.length) {
    throw new Error('Please select at least one linked account to share.');
  }
  const matchedAccounts = allAccounts.filter(a => targetIds.includes(a.id));
  if (!matchedAccounts.length) throw new Error('Selected account(s) not found.');

  if (shareType === 'sender' && !filterSender.trim()) {
    throw new Error('Please enter a sender email address or domain to filter by.');
  }
  if (shareType === 'selected' && (!selectedMessageIds || !selectedMessageIds.length)) {
    throw new Error('Please select at least one email to share.');
  }

  const shareId = 'share_' + Math.random().toString(36).slice(2, 10);
  const salt = generateSalt();
  const hash = await hashPasscode(passcode, salt);

  const defaultLabel = matchedAccounts.length > 1
    ? `${matchedAccounts.length} Linked Accounts Shared`
    : `Share: ${matchedAccounts[0].label || matchedAccounts[0].email}`;

  const payload = {
    id: shareId,
    accountId: matchedAccounts[0].id,
    accountIds: matchedAccounts.map(a => a.id),
    accountEmail: matchedAccounts[0].email,
    accountEmails: matchedAccounts.map(a => a.email),
    label: (label || defaultLabel).trim(),
    salt,
    hash,
    shareType,
    filterSender: filterSender.trim().toLowerCase(),
    selectedMessageIds: Array.isArray(selectedMessageIds) ? selectedMessageIds : [],
    permissions,
    createdAt: Date.now()
  };

  await request(`mailroom/shares/${shareId}`, 'PUT', payload);
  await logAudit('share.created', `${shareId} (${shareType})`);
  return payload;
}

export async function removeSharedInbox(shareId) {
  await request(`mailroom/shares/${shareId}`, 'DELETE');
  await logAudit('share.removed', shareId);
  return { success: true };
}

// Accounts APIs (Supporting both Gmail Password & App Password separately)
export async function getAccounts() {
  const data = await request('mailroom/accounts');
  if (!data) return [];
  return Object.values(data).map(acc => ({
    id: acc.id,
    email: acc.email,
    label: acc.label || acc.email.split('@')[0],
    connected: true,
    authType: acc.authType || (acc.accessToken ? 'oauth' : 'password'),
    isOAuth: acc.authType === 'oauth' || Boolean(acc.accessToken),
    hasAppPassword: Boolean(acc.appPassword || acc.password),
    hasGmailPassword: Boolean(acc.gmailPassword),
    appPassword: acc.appPassword || acc.password || '',
    gmailPassword: acc.gmailPassword || '',
    status: 'connected',
    createdAt: acc.createdAt || Date.now()
  }));
}

export async function getAccountPasswords(accountId) {
  const acc = await request(`mailroom/accounts/${accountId}`);
  if (!acc) throw new Error('Account not found');
  await logAudit('password.revealed', accountId);
  return {
    appPassword: acc.appPassword || acc.password || '',
    gmailPassword: acc.gmailPassword || ''
  };
}

export async function saveAccount({ id, email, label, appPassword, gmailPassword, clearAppPassword, clearGmailPassword, currentPlan = 'free' }) {
  if (!email || !email.includes('@')) throw new Error('Please enter a valid Gmail address.');

  const accounts = await getAccounts();
  const maxAllowed = PLANS[currentPlan.toUpperCase()]?.maxAccounts || 5;

  // Enforce Plan Limits for new accounts
  if (!id && accounts.length >= maxAllowed) {
    throw new Error(`Plan limit reached! Your ${PLANS[currentPlan.toUpperCase()]?.name || 'Free Plan'} allows up to ${maxAllowed} accounts. Please upgrade your plan or contact admin at mrsmithcons@gmail.com.`);
  }

  const accountId = id || 'acc_' + Math.random().toString(36).slice(2, 10);
  let existing = null;
  if (id) {
    existing = await request(`mailroom/accounts/${id}`);
  }

  // App Password handling
  let savedAppPassword = appPassword;
  if (clearAppPassword) {
    savedAppPassword = '';
  } else if (!savedAppPassword && existing) {
    savedAppPassword = existing.appPassword || existing.password || '';
  }

  // Gmail Password handling
  let savedGmailPassword = gmailPassword;
  if (clearGmailPassword) {
    savedGmailPassword = '';
  } else if (!savedGmailPassword && existing) {
    savedGmailPassword = existing.gmailPassword || '';
  }

  const payload = {
    id: accountId,
    email: email.trim().toLowerCase(),
    label: (label || email.split('@')[0]).trim(),
    appPassword: savedAppPassword || '',
    gmailPassword: savedGmailPassword || '',
    password: savedAppPassword || '', // Backwards compatibility for IMAP sync script
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

// Google OAuth 2.0 Integration APIs
export async function getOAuthConfig() {
  try {
    const config = await request('mailroom/config/oauth');
    if (config?.clientId) return config;
  } catch {}
  return {
    clientId: '',
    clientSecret: '',
    redirectUri: 'https://firemailai.web.app/api/oauth/callback'
  };
}

export async function saveOAuthConfig({ clientId, clientSecret }) {
  const payload = {
    clientId: (clientId || '').trim(),
    clientSecret: (clientSecret || '').trim(),
    redirectUri: 'https://firemailai.web.app/api/oauth/callback',
    updatedAt: Date.now()
  };
  await request('mailroom/config/oauth', 'PUT', payload);
  await logAudit('oauth.config_updated');
  return payload;
}

export async function saveOAuthAccount({ email, label, accessToken, refreshToken, expiresIn, currentPlan = 'free' }) {
  if (!email || !email.includes('@')) throw new Error('Valid email address required.');
  const accounts = await getAccounts();
  const maxAllowed = PLANS[currentPlan.toUpperCase()]?.maxAccounts || 5;

  const existing = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
  if (!existing && accounts.length >= maxAllowed) {
    throw new Error(`Plan limit reached! Your ${PLANS[currentPlan.toUpperCase()]?.name || 'Free Plan'} allows up to ${maxAllowed} accounts. Please upgrade your plan or contact admin at mrsmithcons@gmail.com.`);
  }

  const accountId = existing?.id || 'acc_oauth_' + Math.random().toString(36).slice(2, 10);
  const payload = {
    id: accountId,
    email: email.trim().toLowerCase(),
    label: (label || email.split('@')[0]).trim(),
    authType: 'oauth',
    accessToken,
    refreshToken: refreshToken || existing?.refreshToken || '',
    tokenExpiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
    connected: true,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  await request(`mailroom/accounts/${accountId}`, 'PUT', payload);
  await logAudit('oauth.connected', accountId);
  return payload;
}

// AI Integration APIs (Groq Ultra-Fast AI Engine)
export async function getAIConfig() {
  try {
    const config = await request('mailroom/config/ai');
    if (config && (config.apiKey || config.groqApiKey)) {
      const activeKey = config.apiKey || config.groqApiKey || '';
      return {
        provider: 'groq',
        apiKey: activeKey,
        model: config.model || 'llama-3.3-70b-versatile',
        isConfigured: Boolean(activeKey),
        updatedAt: config.updatedAt
      };
    }
  } catch {}
  return {
    provider: 'groq',
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    isConfigured: false
  };
}

export async function saveAIConfig({ apiKey = '', model = '' }) {
  const payload = {
    provider: 'groq',
    apiKey: apiKey.trim(),
    model: (model || 'llama-3.3-70b-versatile').trim(),
    updatedAt: Date.now()
  };
  await request('mailroom/config/ai', 'PUT', payload);
  await logAudit('ai.config_updated', `groq:${payload.model}`);
  return payload;
}

export async function callGroqAI({ apiKey, model, messages }) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('Groq API Key is required. Please enter your Groq API key.');
  const chosenModel = model || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: chosenModel,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = `Groq API error (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error?.message) msg = parsed.error.message;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const choice = data.choices?.[0]?.message?.content;
  if (!choice) throw new Error('No content returned from Groq AI.');
  return choice;
}

export async function classifyEmailsWithAI({ apiKey, model, emails }) {
  if (!Array.isArray(emails) || !emails.length) {
    return { classifications: [], summary: 'No emails to analyze.' };
  }

  const condensed = emails.map(m => ({
    id: m.id,
    accountId: m.accountId,
    from: m.from,
    subject: m.subject,
    date: m.date ? new Date(m.date).toISOString().slice(0, 10) : '',
    snippet: (m.snippet || '').slice(0, 160)
  }));

  const systemPrompt = `You are Firemail AI Triage & Inbox Cleaner powered by Groq.
Your goal is to inspect incoming emails and classify each one to help users clean out useless clutter and keep only important emails.

CRITERIA:
1. "useless": Automated marketing blasts, promotional discounts, newsletters with no personal relevance, cold outreach / sales pitches, bulk social media digest notifications, product update spam.
2. "important": Personal communication from humans, critical business emails, invoices / receipts / orders, security alerts, calendar invitations, flights/travel tickets, direct client inquiries.
3. "normal": Useful informational updates that the user might want to keep but are not urgent.

You must respond in VALID JSON ONLY with this exact schema:
{
  "classifications": [
    {
      "id": "email_id",
      "category": "useless" | "important" | "normal",
      "reason": "Brief 4-8 word reason (e.g. 'Promotional retail discount promo', 'Urgent business inquiry')",
      "suggestedAction": "trash" | "keep" | "archive"
    }
  ],
  "summary": "Brief 1-sentence summary of findings."
}
Do not include any conversational filler, markdown fences, or extra text. Output valid JSON only.`;

  const userContent = JSON.stringify(condensed);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  const rawText = await callGroqAI({ apiKey, model, messages });

  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error('Groq AI returned an unexpected format. Please try again.');
  }
}

// Groq AI email classifier alias
export const classifyEmailsWithGroq = classifyEmailsWithAI;




import { icon, hydrateIcons } from './icons.js';
import { sanitizeEmailHTML, emailPlainText } from './email-sanitizer.js';
import { demoRequest, connectDemo } from './demo.js';
import {
  initRTDB,
  getLockStatus,
  setupPasscode,
  verifyPasscode,
  changePasscode,
  createWorkspace,
  getProfile,
  saveProfile,
  getSharedInboxes,
  createSharedInbox,
  removeSharedInbox,
  getAccounts,
  getAccountPasswords,
  saveAccount,
  removeAccount,
  getMessages,
  getThread,
  messageAction as rtdbMessageAction,
  saveDraftMessage,
  sendEmailMessage,
  getAudit,
  logAudit,
  triggerSyncRequest,
  invalidateMessageCache,
  getOAuthConfig,
  saveOAuthConfig,
  saveOAuthAccount,
  PLANS
} from './rtdb.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const demo = new URLSearchParams(location.search).get('demo') === '1';
const palette = ['#e8c9b2', '#c4dcae', '#d6ccdf', '#b8d3dd', '#e7dda6', '#cfddce'];
const folders = { INBOX: ['Inbox', 'All your conversations, in one place.'], STARRED: ['Starred', 'The conversations you want to keep close.'], SENT: ['Sent', 'A little record of what you have shared.'], DRAFT: ['Drafts', 'Good ideas, ready when you are.'], ALL: ['All mail', 'Your mail, across every folder except Spam and Trash.'], SPAM: ['Spam', 'Messages Gmail has kept out of your inbox.'], TRASH: ['Trash', 'Deleted mail stays here until Gmail removes it.'] };
const state = {
  user: null,
  identity: null,
  configured: true,
  vaultToken: '',
  expiresAt: 0,
  epoch: 0,
  controller: new AbortController(),
  accounts: [],
  messages: [],
  folder: 'INBOX',
  account: 'all',
  search: '',
  filter: 'all',
  cursor: null,
  listVersion: 0,
  readerVersion: 0,
  reader: null,
  activeId: null,
  compose: null,
  lastActivity: Date.now(),
  loading: false,
  oauthPending: false,
  settings: false,
  isGuest: false,
  shareInfo: null,
  workspaceId: 'master',
  currentPlan: 'free',
  shares: []
};
let revealTimer;

function notice(id, message = '', success = false) { $(id).hidden = !message; $(id).textContent = message; $(id).classList.toggle('success', success); }
function toast(message, error = false) { const item = document.createElement('div'); item.className = `toast${error ? ' error' : ''}`; item.innerHTML = icon(error ? 'alert' : 'check') + `<span>${esc(message)}</span>`; $('toast-container').appendChild(item); setTimeout(() => item.remove(), error ? 8500 : 4200); }
function report(err, id) { if (['STALE', 'DASHBOARD_LOCKED', 'SIGN_IN_REQUIRED'].includes(err.code) || err.name === 'AbortError') return; if (id) notice(id, err.message); else toast(err.message || 'The action could not be completed.', true); }
function person(from) { return String(from || '').replace(/<[^>]*>/g, '').replaceAll('"', '').trim() || String(from).split('@')[0] || 'Unknown sender'; }
function initials(value) { const name = person(value); const bits = name.split(/[\s@._-]+/).filter(Boolean); return ((bits[0]?.[0] || '?') + (bits.length > 1 ? bits[1][0] : '')).toUpperCase(); }
function color(value) { return palette[[...String(value)].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length]; }
function accountLabel(aid) { return state.accounts.find(a => a.id === aid)?.label || state.accounts.find(a => a.id === aid)?.email?.split('@')[0] || 'Account'; }
function stamp(value, full = false) { const d = new Date(value); if (!Number.isFinite(d.getTime())) return ''; if (full) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); const today = new Date(); return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function bytes(value) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB`; }
function extractEmails(value) { return [...new Set((String(value || '').match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g) || []).map(e => e.toLowerCase()))]; }
function query(params) { return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString(); }
function connectedAccounts() { return state.accounts.filter(a => a.connected); }
function canUseWorkspace() { return Boolean(state.vaultToken); }

async function api(path, { method = 'GET', body } = {}) {
  if (demo) return demoRequest(path, { method, body });

  // Direct Firebase RTDB routing
  if (path === '/api/session') {
    return getLockStatus();
  }
  if (path === '/api/lock/setup') {
    return setupPasscode(body.passcode);
  }
  if (path === '/api/lock/unlock') {
    return verifyPasscode(body.passcode);
  }
  if (path === '/api/lock/change') {
    return changePasscode(body.currentPasscode, body.passcode);
  }
  if (path === '/api/lock') {
    return { success: true };
  }

  if (path === '/api/workspaces/create') {
    return createWorkspace(body);
  }

  if (path === '/api/profile' && method === 'GET') {
    return getProfile(state.workspaceId);
  }
  if (path === '/api/profile' && method === 'POST') {
    return saveProfile(state.workspaceId, body);
  }

  if (path === '/api/shares' && method === 'GET') {
    return getSharedInboxes();
  }
  if (path === '/api/shares' && method === 'POST') {
    return createSharedInbox(body);
  }
  const shareMatch = path.match(/^\/api\/shares\/([^/]+)$/);
  if (shareMatch && method === 'DELETE') {
    return removeSharedInbox(shareMatch[1]);
  }

  if (path === '/api/accounts' && method === 'GET') {
    const accounts = await getAccounts();
    return { accounts };
  }
  if (path === '/api/accounts' && method === 'PUT') {
    return saveAccount({ ...body, currentPlan: state.currentPlan });
  }
  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && method === 'DELETE') {
    return removeAccount(accountMatch[1]);
  }
  const passwordMatch = path.match(/^\/api\/accounts\/([^/]+)\/passwords$/);
  if (passwordMatch) {
    return getAccountPasswords(passwordMatch[1]);
  }

  if (path.startsWith('/api/messages')) {
    const url = new URL('http://local' + path);
    const folder = url.searchParams.get('folder') || 'INBOX';
    const account = state.isGuest ? state.shareInfo.accountId : (url.searchParams.get('account') || 'all');
    const q = url.searchParams.get('q') || '';
    const force = url.searchParams.get('force') === '1';
    return getMessages({ folder, account, q, forceRefresh: force });
  }

  const threadMatch = path.match(/^\/api\/accounts\/([^/]+)\/threads\/([^/]+)$/);
  if (threadMatch) {
    return getThread(threadMatch[1], threadMatch[2]);
  }

  const actionMatch = path.match(/^\/api\/accounts\/([^/]+)\/messages\/([^/]+)\/action$/);
  if (actionMatch) {
    return rtdbMessageAction(actionMatch[1], actionMatch[2], body.action);
  }

  const draftMatch = path.match(/^\/api\/accounts\/([^/]+)\/drafts$/);
  if (draftMatch) {
    return saveDraftMessage(draftMatch[1], body);
  }

  const sendMatch = path.match(/^\/api\/accounts\/([^/]+)\/send$/);
  if (sendMatch) {
    return sendEmailMessage(sendMatch[1], body);
  }

  if (path === '/api/audit') {
    return getAudit();
  }

  if (path === '/api/oauth/config' && method === 'GET') {
    return getOAuthConfig();
  }
  if (path === '/api/oauth/config' && method === 'POST') {
    return saveOAuthConfig(body);
  }

  throw new Error(`Route not supported: ${path}`);
}

function showGate(message = '') {
  $('workspace').hidden = true;
  $('gate').hidden = false;
  $('unlock-form').hidden = false;
  $('create-ws-form').hidden = true;
  $('tab-unlock').classList.add('active');
  $('tab-create').classList.remove('active');
  $('confirm-field').hidden = state.configured;
  $('confirm-passcode').required = !state.configured;
  $('passcode').autocomplete = state.configured ? 'current-password' : 'new-password';
  $('gate-title').textContent = state.configured ? 'Firemail AI Access' : 'Set Master Passcode';
  $('gate-description').textContent = state.configured
    ? 'Unlock your workspace, enter a shared inbox, or create a new passcode.'
    : 'Create a master passcode (at least 4 characters). Stored in Firebase Realtime Database.';
  $('unlock-button').innerHTML = (state.configured ? 'Unlock Workspace ' : 'Set passcode & enter ') + icon('arrow-right');
  notice('gate-notice', message);
}
function clearPrivateUI() {
  state.accounts = []; state.messages = []; state.reader = null; state.activeId = null; state.cursor = null; state.listVersion++; state.readerVersion++;
  if (state.compose) clearTimeout(state.compose.saveTimer);
  state.compose = null; clearTimeout(revealTimer);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close('cancel');
  for (const id of ['message-list', 'reader', 'settings-accounts', 'account-nav', 'audit-list', 'compose-attachments', 'toast-container']) $(id).replaceChildren();
  for (const form of document.querySelectorAll('form')) form.reset();
  $('revealed-password').value = ''; $('password-email').textContent = ''; $('profile-email').textContent = '';
  $('search').value = ''; $('compose-body').value = ''; $('compose-from').replaceChildren(); $('account-filter').replaceChildren();
  $('inbox-errors').replaceChildren(); $('inbox-errors').hidden = true;
  state.search = ''; state.filter = 'all'; state.settings = false; state.loading = false; state.oauthPending = false;
  state.account = 'all'; state.folder = 'INBOX'; $('sidebar').classList.remove('open');
  closeReader();
  stopSyncTimer();
}
function lockDashboard(message = '', invalidate = true) {
  const oldToken = state.vaultToken, oldUser = state.user;
  state.vaultToken = ''; state.expiresAt = 0; state.epoch++; state.controller.abort(); state.controller = new AbortController();
  clearPrivateUI(); showGate(message);
  if (invalidate && oldToken && oldUser && !demo) oldUser.getIdToken().then(token => fetch('/api/lock', { method: 'POST', cache: 'no-store', keepalive: true, headers: { Authorization: `Bearer ${token}`, 'X-Vault-Session': oldToken, 'Content-Type': 'application/json' }, body: '{}' })).catch(() => {});
}
async function enterWorkspace(session) {
  state.vaultToken = session.token;
  state.expiresAt = session.expiresAt;
  state.lastActivity = Date.now();
  state.configured = true;
  $('passcode').value = '';
  $('confirm-passcode').value = '';
  $('gate').hidden = true;
  $('workspace').hidden = false;
  $('demo-badge').hidden = !demo;
  $('settings-area').hidden = true;
  $('mail-area').hidden = false;
  state.settings = false;

  if (session.isShared || session.role === 'guest') {
    state.isGuest = true;
    state.shareInfo = session;
    state.account = session.accountId;
    state.folder = 'INBOX';
    $('guest-banner').hidden = false;
    if ($('plan-widget')) $('plan-widget').hidden = true;
    if ($('topbar-plans-btn')) $('topbar-plans-btn').hidden = true;
    if ($('settings-button')) $('settings-button').hidden = true;
    if ($('share-inbox-btn')) $('share-inbox-btn').hidden = true;
    if ($('share-inbox-header-btn')) $('share-inbox-header-btn').hidden = true;
    if ($('connect-main')) $('connect-main').hidden = true;
    if ($('accounts-heading')) $('accounts-heading').hidden = true;
    if ($('account-nav')) $('account-nav').hidden = true;
    if ($('profile-button')) $('profile-button').hidden = true;
    // Restrict folder navigation for guest: only INBOX is accessible
    document.querySelectorAll('.folder-nav .nav-item').forEach(el => {
      if (el.dataset.folder && el.dataset.folder !== 'INBOX') el.hidden = true;
    });
    $('breadcrumb').textContent = session.label || session.accountEmail || 'Shared Inbox';
    state.accounts = [{
      id: session.accountId,
      email: session.accountEmail,
      label: session.label || 'Shared Inbox',
      connected: true
    }];
    renderAccounts();
  } else {
    state.isGuest = false;
    state.shareInfo = null;
    state.workspaceId = session.workspaceId || 'master';
    state.currentPlan = session.plan || 'free';
    $('guest-banner').hidden = true;
    if ($('plan-widget')) $('plan-widget').hidden = false;
    if ($('topbar-plans-btn')) $('topbar-plans-btn').hidden = false;
    if ($('settings-button')) $('settings-button').hidden = false;
    if ($('share-inbox-btn')) $('share-inbox-btn').hidden = false;
    if ($('share-inbox-header-btn')) $('share-inbox-header-btn').hidden = false;
    if ($('connect-main')) $('connect-main').hidden = false;
    if ($('accounts-heading')) $('accounts-heading').hidden = false;
    if ($('account-nav')) $('account-nav').hidden = false;
    if ($('profile-button')) $('profile-button').hidden = false;
    document.querySelectorAll('.folder-nav .nav-item').forEach(el => { el.hidden = false; });

    try {
      const prof = await api('/api/profile');
      if (prof) {
        state.user = { displayName: prof.name, email: prof.email };
        state.currentPlan = prof.plan || session.plan || 'free';
        $('profile-button').textContent = initials(prof.name || prof.email || 'Owner');
      }
    } catch {}
    updatePlanUI();
    try { await loadAccounts(); } catch (err) { report(err); }
  }

  try { await loadMessages(); } catch (err) { report(err); }
  startSyncTimer();
}

function updatePlanUI() {
  if (state.isGuest) return;
  const planKey = (state.currentPlan || 'free').toUpperCase();
  const planObj = PLANS[planKey] || PLANS.FREE;
  const max = planObj.maxAccounts;
  const count = state.accounts.length;
  if ($('plan-name')) $('plan-name').textContent = planObj.name;
  if ($('plan-usage')) $('plan-usage').textContent = `${count} / ${max} accounts`;
  if ($('topbar-plan-label')) $('topbar-plan-label').textContent = planObj.name;
  if ($('profile-plan-name')) $('profile-plan-name').textContent = `${planObj.name} (${max} accounts)`;
  
  document.querySelectorAll('#plans-dialog .plan-card').forEach(card => {
    const p = card.dataset.plan;
    card.classList.toggle('active-plan', p === state.currentPlan);
  });
}

async function loadAccounts() {
  if (state.isGuest) return;
  const result = await api('/api/accounts');
  if (!canUseWorkspace()) return;
  state.accounts = result.accounts;
  if (state.account !== 'all' && !state.accounts.some(a => a.id === state.account)) state.account = 'all';
  renderAccounts();
  updatePlanUI();
}

function renderAccounts() {
  const connected = connectedAccounts();
  $('account-nav').innerHTML = `<button class="account-item ${state.account === 'all' ? 'active' : ''}" data-account="all"><span class="account-color" style="background:#c6e4ad"></span><span class="account-copy"><strong>All accounts</strong><small>${connected.length} connected inbox${connected.length === 1 ? '' : 'es'}</small></span></button>` + (state.accounts.length ? state.accounts.map(a => `<button class="account-item ${state.account === a.id ? 'active' : ''}" data-account="${esc(a.id)}"><span class="account-color" style="background:${color(a.email)}"></span><span class="account-copy"><strong>${esc(a.label || a.email.split('@')[0])}</strong><small>${esc(a.connected ? a.email : 'Saved · connect to read mail')}</small></span></button>`).join('') : '<p class="sidebar-empty">A fresh start.<br>Connect your first Gmail inbox.</p>');
  $('account-filter').innerHTML = '<option value="all">All accounts</option>' + state.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.email)}</option>`).join(''); $('account-filter').value = state.account;
  $('breadcrumb').textContent = state.account === 'all' ? 'All accounts' : accountLabel(state.account);
  if (state.settings) renderSettingsAccounts();
}
function updateHeadings() {
  $('folder-title').textContent = state.search ? 'Search results' : folders[state.folder][0];
  const dot = document.createElement('span'); dot.className = 'heading-dot'; dot.textContent = '.'; $('folder-title').appendChild(dot);
  $('folder-description').textContent = state.search ? `Matching “${state.search}” in ${folders[state.folder][0].toLowerCase()}.` : folders[state.folder][1];
  document.querySelectorAll('[data-folder]').forEach(el => el.classList.toggle('active', el.dataset.folder === state.folder));
  document.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('active', el.dataset.filter === state.filter));
}
function skeletonRows() { return Array.from({ length: 6 }, () => '<div class="loading-row"><div class="skeleton"></div><div class="skeleton-lines"><div class="skeleton"></div><div class="skeleton"></div></div></div>').join(''); }
async function loadMessages(append = false, force = false) {
  if (!canUseWorkspace()) return;
  const version = ++state.listVersion; state.loading = true; updateHeadings(); $('refresh-button').disabled = true; $('load-more').disabled = true;
  if (!append) { state.messages = []; state.cursor = null; $('message-list').innerHTML = skeletonRows(); $('inbox-errors').hidden = true; closeReader(); }
  const search = [state.search, state.filter === 'unread' ? 'is:unread' : ''].filter(Boolean).join(' ');
  try {
    const data = await api(`/api/messages?${query({ folder: state.folder, account: state.account, q: search, cursor: append ? state.cursor : null, force: force ? 1 : null })}`);
    if (version !== state.listVersion || !canUseWorkspace()) return;
    const dedup = new Map([...state.messages, ...data.messages].map(m => [`${m.accountId}:${m.id}`, m]));
    state.messages = [...dedup.values()].sort((a, b) => b.date - a.date); state.cursor = data.nextCursor;
    renderMessages();
    $('inbox-errors').hidden = !data.errors.length;
    $('inbox-errors').innerHTML = data.errors.map(e => `<p><strong>${esc(e.email)}</strong>: ${esc(e.message)}${['RECONNECT_REQUIRED', 'GMAIL_PERMISSION'].includes(e.code) ? ` <button class="text-button" data-reconnect="${esc(e.accountId)}">Reconnect</button>` : ''}</p>`).join('');
    $('sync-time').textContent = `Updated ${stamp(Date.now())}`;
    // The sidebar count is the unread count of loaded messages, not an invented total.
    $('unread-count').textContent = state.messages.filter(m => m.unread && m.labels.includes('INBOX')).length;
    $('unread-count').title = 'Unread inbox messages in the loaded results';
  } catch (err) {
    if (version !== state.listVersion || !canUseWorkspace()) return;
    report(err); if (!append) { $('message-list').innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('alert')}</div><h3>Could not load this folder</h3><p>${esc(err.message)}</p><button class="button secondary" data-retry>Try again</button></div>`; }
  } finally { if (version === state.listVersion) { state.loading = false; $('refresh-button').disabled = false; $('load-more').disabled = false; } }
}
function renderMessages() {
  $('message-count').textContent = `${state.messages.length} loaded`; $('load-more').hidden = !state.cursor;
  if (!state.messages.length) {
    const first = !connectedAccounts().length;
    $('message-list').innerHTML = `<div class="empty-state"><div class="empty-icon">${icon(first ? 'mail' : 'inbox')}</div><h3>${first ? 'Your inboxes belong here' : state.search || state.filter === 'unread' ? 'No matching messages' : 'A little breathing room'}</h3><p>${first ? 'Connect a Gmail account once, then read and reply from this private workspace.' : state.search ? 'Try a different search. Gmail search operators work here too.' : 'There are no messages in this folder right now.'}</p>${first ? '<button class="button primary" data-connect-first>Connect your first Gmail</button>' : ''}</div>`; return;
  }
  $('message-list').innerHTML = state.messages.map((m, index) => `<article class="message-row ${m.unread ? 'unread' : ''} ${state.activeId === `${m.accountId}:${m.id}` ? 'active' : ''}"><button class="row-open" data-open="${index}" aria-label="${esc(`Open ${m.subject} from ${person(m.from)}`)}"></button><div class="sender-avatar" style="background:${color(m.from)}">${esc(initials(m.from))}</div><div class="message-main"><div class="message-main-top"><span class="sender-name">${esc(person(m.from))}</span><span class="account-tag">${esc(accountLabel(m.accountId))}</span><span class="message-date">${esc(stamp(m.date))}</span></div><div class="message-summary-line">${m.draftId ? '<span class="draft-chip">Draft</span> ' : ''}<span class="message-subject">${esc(m.subject)}</span><span class="message-preview">${esc(m.snippet)}</span></div></div><button class="icon-button star-button ${m.starred ? 'starred' : ''}" data-star="${index}" aria-label="${m.starred ? 'Unstar' : 'Star'} message" aria-pressed="${m.starred}">${icon('star')}</button></article>`).join('');
}
function closeReader() { state.readerVersion++; state.reader = null; state.activeId = null; $('reader').hidden = true; $('reader').replaceChildren(); $('message-layout').classList.remove('has-reader'); }
async function openThread(message) {
  if (message.draftId) return editDraft(message);
  const version = ++state.readerVersion; state.activeId = `${message.accountId}:${message.id}`; renderMessages();
  $('reader').hidden = false; $('message-layout').classList.add('has-reader');
  $('reader').innerHTML = `<div class="reader-toolbar"><button class="icon-button reader-close" data-reader-close aria-label="Close conversation">${icon('arrow-left')}</button></div><div class="reader-skeleton">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
  try {
    const data = await api(`/api/accounts/${message.accountId}/threads/${message.threadId}`);
    if (version !== state.readerVersion || !canUseWorkspace()) return;
    state.reader = { ...data, accountId: message.accountId };
    renderReader();
    const unread = data.messages.filter(m => m.unread);
    const results = await Promise.allSettled(unread.map(m => api(`/api/accounts/${m.accountId}/messages/${m.id}/action`, { method: 'POST', body: { action: 'read' } })));
    if (version !== state.readerVersion || !canUseWorkspace()) return;
    results.forEach((r, i) => { if (r.status === 'fulfilled') { unread[i].unread = false; const row = state.messages.find(m => m.id === unread[i].id && m.accountId === unread[i].accountId); if (row) { row.unread = false; row.labels = row.labels.filter(l => l !== 'UNREAD'); } } });
    renderMessages();
  } catch (err) { if (version !== state.readerVersion) return; report(err); $('reader').innerHTML = `<div class="reader-toolbar"><button class="icon-button reader-close" data-reader-close aria-label="Close conversation">${icon('arrow-left')}</button></div><div class="empty-state"><div class="empty-icon">${icon('alert')}</div><h3>Could not open this conversation</h3><p>${esc(err.message)}</p></div>`; }
}
function renderReader() {
  if (!state.reader) return;
  const messages = state.reader.messages; const last = messages.at(-1); if (!last) return;
  $('reader').innerHTML = `<div class="reader-toolbar"><button class="icon-button reader-close" data-reader-close aria-label="Close conversation">${icon('arrow-left')}</button><button class="icon-button" data-thread-action="archive" aria-label="Archive conversation">${icon('archive')}</button><button class="icon-button" data-thread-action="unread" aria-label="Mark conversation unread">${icon('mail')}</button><button class="icon-button" data-thread-action="${state.folder === 'SPAM' ? 'notspam' : 'spam'}" aria-label="${state.folder === 'SPAM' ? 'Move out of spam' : 'Mark as spam'}">${icon('alert')}</button><button class="icon-button" data-thread-action="${state.folder === 'TRASH' ? 'restore' : 'trash'}" aria-label="${state.folder === 'TRASH' ? 'Restore conversation' : 'Move conversation to Trash'}">${icon(state.folder === 'TRASH' ? 'refresh' : 'trash')}</button></div><div class="reader-content"><h2>${esc(last.subject)}</h2><span class="account-tag">${esc(last.accountEmail)}</span>${messages.map((m, i) => `<details class="reader-mail" ${i === messages.length - 1 ? 'open' : ''}><summary><span class="sender-avatar" style="background:${color(m.from)}">${esc(initials(m.from))}</span><span class="sender-details"><strong>${esc(person(m.from))}</strong><small>${esc(m.from)}</small><small>To: ${esc(m.to)}${m.cc ? '<br>Cc: ' + esc(m.cc) : ''}</small></span><span class="reader-time">${esc(stamp(m.date, true))}</span></summary><div class="reader-message" data-body-index="${i}"></div><div class="attachment-list">${m.attachments.filter(a => !a.contentId || a.name !== 'inline-image').map((a, j) => `<button class="attachment-chip" data-attachment-message="${i}" data-attachment-id="${esc(a.id || '')}" data-attachment-part="${esc(a.partId || '')}">${icon('paperclip')}<span>${esc(a.name)} · ${bytes(a.size || 0)}</span>${icon('download')}</button>`).join('')}</div><div class="reply-actions"><button class="button secondary small" data-reply="${i}">${icon('reply')} Reply</button><button class="button secondary small" data-reply-all="${i}">Reply all</button><button class="button secondary small" data-forward="${i}">${icon('forward')} Forward</button></div></details>`).join('')}</div>`;
  messages.forEach((m, i) => renderBody(m, i));
}
function renderBody(message, index, allowRemote = false) {
  const container = $('reader').querySelector(`[data-body-index="${index}"]`); if (!container) return;
  if (!message.html) { container.innerHTML = `<pre dir="auto">${esc(message.text || '(This message has no readable body.)')}</pre>`; return; }
  const inlineImages = {};
  for (const file of message.attachments) if (file.contentId && file.inlineData && /^image\/(png|jpeg|gif|webp)$/.test(file.type || '')) inlineImages[file.contentId.replace(/[<>]/g, '')] = `data:${file.type};base64,${file.inlineData.replaceAll('-', '+').replaceAll('_', '/')}`;
  const clean = sanitizeEmailHTML(message.html, { allowRemote, inlineImages });
  container.replaceChildren();
  if (clean.remoteImages && !allowRemote) { const note = document.createElement('div'); note.className = 'remote-image-notice'; note.innerHTML = `<span>Remote images are blocked for privacy.</span><button class="text-button" data-load-images="${index}">Load images</button>`; container.appendChild(note); }
  const iframe = document.createElement('iframe'); iframe.className = 'email-frame'; iframe.title = `Message from ${person(message.from)}`; iframe.setAttribute('sandbox', ''); iframe.referrerPolicy = 'no-referrer'; iframe.srcdoc = clean.srcdoc; iframe.style.height = `${Math.min(650, Math.max(300, message.html.length / 5))}px`; container.appendChild(iframe);
  if (clean.links.length) { const links = document.createElement('div'); links.className = 'message-links'; links.innerHTML = clean.links.slice(0, 30).map(link => `<a href="${esc(link.href)}" target="_blank" rel="noopener noreferrer" title="${esc(link.href)}">${esc(link.text || link.href)}</a>`).join(''); container.appendChild(links); }
  if (clean.limited) { const note = document.createElement('p'); note.textContent = 'This very large HTML message was shortened for display.'; container.appendChild(note); }
}
async function messageAction(message, action) {
  await api(`/api/accounts/${message.accountId}/messages/${message.id}/action`, { method: 'POST', body: { action } });
  const update = { star: ['STARRED', true], unstar: ['STARRED', false], read: ['UNREAD', false], unread: ['UNREAD', true] }[action];
  if (update) { message.labels = message.labels.filter(l => l !== update[0]); if (update[1]) message.labels.push(update[0]); message.unread = message.labels.includes('UNREAD'); message.starred = message.labels.includes('STARRED'); }
  renderMessages();
}
async function threadAction(action) {
  if (!state.reader) return;
  const messages = state.reader.messages.slice();
  const results = await Promise.allSettled(messages.map(m => messageAction(m, action)));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) report(failed.reason);
  else toast(({ archive: 'Conversation archived.', trash: 'Conversation moved to Trash.', restore: 'Conversation restored.', unread: 'Conversation marked unread.', spam: 'Conversation moved to Spam.', notspam: 'Conversation moved back to the inbox.' })[action]);
  if (canUseWorkspace()) await loadMessages();
}
function base64Bytes(value) { const raw = atob(String(value).replaceAll('-', '+').replaceAll('_', '/')); const data = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i); return data; }
function standardBase64(value) { const data = String(value).replaceAll('-', '+').replaceAll('_', '/'); return data + '='.repeat((4 - data.length % 4) % 4); }
async function attachmentData(message, file) { if (file.data || file.inlineData) return { data: file.data || file.inlineData, name: file.name, type: file.type }; if (!file.id) throw new Error('This attachment has no downloadable data.'); return api(`/api/accounts/${message.accountId}/messages/${message.id}/attachments/${file.id}`); }
async function downloadAttachment(message, file) {
  try { const content = await attachmentData(message, file); const url = URL.createObjectURL(new Blob([base64Bytes(content.data)], { type: 'application/octet-stream' })); const link = document.createElement('a'); link.href = url; link.download = content.name || 'attachment'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); } catch (err) { report(err); }
}
async function beginConnect(aid) {
  if (!canUseWorkspace()) return;
  openAccount(aid || null);
}
async function showSettings() {
  if (state.isGuest) return;
  state.settings = true;
  closeReader();
  $('mail-area').hidden = true;
  $('settings-area').hidden = false;
  $('sidebar').classList.remove('open');
  renderSettingsAccounts();
  renderSettingsShares();
  $('audit-list').textContent = 'Loading activity…';
  try {
    const data = await api('/api/audit');
    if (!state.settings || !canUseWorkspace()) return;
    const descriptions = {
      'lock.created': 'Master passcode created',
      'lock.changed': 'Master passcode changed',
      'dashboard.unlocked': 'Dashboard unlocked',
      'account.saved': 'Account details & passwords saved in RTDB',
      'account.removed': 'Account removed',
      'password.revealed': 'Saved password revealed',
      'mail.sent': 'Message sent',
      'share.created': 'Shared inbox passcode created',
      'share.removed': 'Shared inbox access revoked',
      'profile.updated': 'User profile updated in RTDB',
      'workspace.created': 'User workspace created with passcode'
    };
    $('audit-list').innerHTML = data.events.length
      ? data.events.slice(0, 20).map(e => `<div class="audit-row"><span>${esc(descriptions[e.action] || e.action)}${e.accountId ? ' · ' + esc(accountLabel(e.accountId)) : ''}</span><span>${esc(stamp(e.at, true))}</span></div>`).join('')
      : '<p class="audit-empty">Your workspace activity will appear here.</p>';
  } catch (err) { report(err); }
}

function renderSettingsAccounts() {
  $('settings-accounts').innerHTML = state.accounts.length
    ? state.accounts.map(a => `
        <div class="saved-account">
          <div class="sender-avatar" style="background:${color(a.email)}">${esc(initials(a.label || a.email))}</div>
          <div class="saved-account-main">
            <strong>${esc(a.label || a.email.split('@')[0])} <span class="account-status connected">${a.isOAuth || a.authType === 'oauth' ? 'GOOGLE OAUTH (1-CLICK)' : 'SAVED IN RTDB'}</span></strong>
            <small>${esc(a.email)}${a.isOAuth || a.authType === 'oauth' ? ' · Connected via 1-Click Google OAuth' : (a.hasAppPassword ? ' · App Password saved' : '') + (a.hasGmailPassword ? ' · Gmail Password saved' : '')}</small>
          </div>
          <div class="saved-account-actions">
            ${(a.hasAppPassword || a.hasGmailPassword) ? `<button class="icon-button" data-reveal="${esc(a.id)}" aria-label="Reveal passwords for ${esc(a.email)}">${icon('eye')}</button>` : ''}
            <button class="icon-button" data-edit-account="${esc(a.id)}" aria-label="Edit ${esc(a.email)}">${icon('edit')}</button>
            <button class="icon-button" data-remove-account="${esc(a.id)}" aria-label="Remove ${esc(a.email)}">${icon('trash')}</button>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state"><div class="empty-icon">' + icon('mail') + '</div><h3>Your first Gmail account</h3><p>Save your Gmail address or connect with 1-Click Google OAuth.</p><button class="button primary" data-connect-first>Add Gmail account</button></div>';
}

async function renderSettingsShares() {
  const container = $('settings-shares');
  if (!container) return;
  container.innerHTML = '<p class="field-hint">Loading shared inboxes…</p>';
  try {
    const shares = await api('/api/shares');
    state.shares = shares || [];
    if (!state.shares.length) {
      container.innerHTML = '<p class="sidebar-empty">No inboxes are shared yet.<br>Click "Share inbox" to give restricted access to anyone via passcode.</p>';
      return;
    }
    container.innerHTML = state.shares.map(s => `
      <div class="saved-account">
        <div class="sender-avatar" style="background:#b8d3dd">${icon('share')}</div>
        <div class="saved-account-main">
          <strong>${esc(s.label)} <span class="account-status connected">PASSCODE ACTIVE</span></strong>
          <small>Account: ${esc(s.accountEmail)} · Created ${esc(stamp(s.createdAt))}</small>
        </div>
        <div class="saved-account-actions">
          <button class="icon-button" data-remove-share="${esc(s.id)}" aria-label="Revoke share access">${icon('trash')}</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="field-hint error">${esc(err.message)}</p>`;
  }
}

function openAccount(aid = null) {
  if (state.isGuest) return;
  const account = state.accounts.find(a => a.id === aid);

  if (!account) {
    const planKey = (state.currentPlan || 'free').toUpperCase();
    const max = PLANS[planKey]?.maxAccounts || 5;
    if (state.accounts.length >= max) {
      toast(`You have reached the ${PLANS[planKey]?.name || 'Free Plan'} limit (${max} accounts). Please upgrade your plan.`, true);
      $('plans-dialog').showModal();
      return;
    }
  }

  $('account-form').reset();
  $('account-form').dataset.accountId = aid || '';
  $('saved-email').disabled = Boolean(account);
  $('saved-email').value = account?.email || '';
  $('saved-label').value = account?.label || '';
  
  $('saved-gmail-password').value = '';
  $('saved-gmail-password').type = 'password';
  $('saved-gmail-password').placeholder = account?.hasGmailPassword ? 'Saved in RTDB · Leave blank to keep unchanged' : 'Normal Gmail login password';
  $('clear-gmail-pwd-label').hidden = !account?.hasGmailPassword;
  $('clear-gmail-pwd').checked = false;

  $('saved-app-password').value = '';
  $('saved-app-password').type = 'password';
  $('saved-app-password').placeholder = account?.hasAppPassword ? 'Saved in RTDB · Leave blank to keep unchanged' : '16-character code (e.g. abcd efgh ijkl mnop)';
  $('clear-app-pwd-label').hidden = !account?.hasAppPassword;
  $('clear-app-pwd').checked = false;

  $('account-dialog-title').textContent = account ? 'Edit account details' : 'Save an account';
  notice('account-notice');
  $('account-dialog').showModal();
}

async function askConfirm(title, message, button = 'Continue') {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = message;
  $('confirm-ok').textContent = button;
  const dialog = $('confirm-dialog');
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

function clearRevealedPasswords() {
  clearTimeout(revealTimer);
  $('revealed-app-password').value = '';
  $('revealed-app-password').type = 'password';
  $('revealed-gmail-password').value = '';
  $('revealed-gmail-password').type = 'password';
  $('password-email').textContent = '';
}

async function revealPassword(aid) {
  try {
    const data = await api(`/api/accounts/${aid}/passwords`);
    if (!canUseWorkspace()) return;
    clearRevealedPasswords();
    const acc = state.accounts.find(a => a.id === aid);
    $('password-email').textContent = `${acc?.label || ''} (${acc?.email || ''})`;
    $('revealed-app-password').value = data.appPassword || '(No App Password saved)';
    $('revealed-app-password').type = 'password';
    $('revealed-gmail-password').value = data.gmailPassword || '(No Gmail Password saved)';
    $('revealed-gmail-password').type = 'password';
    $('password-dialog').showModal();
    revealTimer = setTimeout(() => {
      $('password-dialog').close();
      clearRevealedPasswords();
    }, 30000);
  } catch (err) {
    report(err);
  }
}

function composerPayload() {
  const context = state.compose;
  if (!context) throw Object.assign(new Error('Compose is closed.'), { code: 'STALE' });
  if (context.attachments.some(a => a.error)) throw new Error('An original attachment could not be loaded. Reopen the draft, or remove the missing attachment before saving or sending.');
  return { to: $('compose-to').value.trim(), cc: $('compose-cc').value.trim(), bcc: $('compose-bcc').value.trim(), subject: $('compose-subject').value, text: $('compose-body').value, attachments: context.attachments.map(a => ({ name: a.name, type: a.type, data: a.data })), draftId: context.draftId || undefined, threadId: context.threadId || undefined, inReplyTo: context.inReplyTo || undefined, references: context.references || undefined, sendKey: context.sendKey };
}
function composerBusy(value) {
  const context = state.compose; if (context) context.busy = value;
  for (const id of ['send-button', 'save-draft', 'attachment-input', 'compose-to', 'compose-cc', 'compose-bcc', 'compose-subject', 'compose-body']) $(id).disabled = value;
  $('compose-from').disabled = value || Boolean(context?.draftId) || ['reply', 'reply-all'].includes(context?.mode);
}
function composerChanged() {
  const context = state.compose; if (!context || context.busy) return;
  context.revision++; context.sendKey = crypto.randomUUID(); $('draft-status').textContent = 'Unsaved changes'; notice('compose-notice');
  clearTimeout(context.saveTimer); context.saveTimer = setTimeout(() => { if (state.compose === context) saveDraft(false).catch(err => report(err, 'compose-notice')); }, 10000);
}
function renderComposerAttachments() { const context = state.compose; if (!context) return; $('compose-attachments').innerHTML = context.attachments.map((a, i) => `<span class="attachment-chip"><span>${esc(a.name)} · ${a.error ? 'could not load' : bytes(a.size)}</span><button class="icon-button" type="button" data-remove-attachment="${i}" aria-label="Remove ${esc(a.name)}">${icon('x')}</button></span>`).join(''); }
function resetComposer() { if (state.compose) clearTimeout(state.compose.saveTimer); state.compose = null; $('compose-form').reset(); $('compose-from').disabled = false; $('compose-attachments').replaceChildren(); $('compose-body').value = ''; notice('compose-notice'); }
function openCompose({ mode = 'new', message = null, draftId = null } = {}) {
  const accounts = connectedAccounts(); if (!accounts.length) { toast('Connect a Gmail inbox before composing a message.', true); return null; }
  resetComposer();
  const aid = state.isGuest
    ? state.shareInfo.accountId
    : (message?.accountId || (state.account !== 'all' && accounts.some(a => a.id === state.account) ? state.account : accounts[0].id));
  const context = state.compose = { accountId: aid, draftId, mode, attachments: [], revision: 0, savedRevision: 0, sendKey: crypto.randomUUID(), busy: false };
  $('compose-from').innerHTML = accounts.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.email)} — ${esc(a.email)}</option>`).join(''); $('compose-from').value = aid;
  $('compose-from').disabled = state.isGuest || Boolean(draftId) || ['reply', 'reply-all'].includes(mode);
  $('cc-fields').hidden = true; $('draft-status').textContent = draftId ? 'Saved in Gmail' : 'Not saved';
  $('compose-title').textContent = ({ new: 'New message', reply: 'Reply', 'reply-all': 'Reply to everyone', forward: 'Forward message', draft: 'Edit draft' })[mode];
  if (message) {
    const own = state.accounts.find(a => a.id === aid)?.email.toLowerCase();
    const text = message.text || emailPlainText(message.html);
    if (mode === 'draft') { $('compose-to').value = extractEmails(message.to).join(', '); $('compose-cc').value = extractEmails(message.cc).join(', '); $('compose-bcc').value = extractEmails(message.bcc).join(', '); $('compose-subject').value = message.subject === '(No subject)' ? '' : message.subject; $('compose-body').value = text; context.threadId = message.threadId; context.inReplyTo = message.inReplyTo || ''; context.references = message.references || ''; $('cc-fields').hidden = !message.cc && !message.bcc; }
    else if (mode === 'forward') { $('compose-subject').value = /^fwd?:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`; $('compose-body').value = `\n\n---------- Forwarded message ----------\nFrom: ${message.from}\nDate: ${stamp(message.date, true)}\nSubject: ${message.subject}\nTo: ${message.to}\n\n${text}`; }
    else {
      $('compose-to').value = extractEmails(message.replyTo || message.from).filter(e => e !== own).join(', ');
      if (mode === 'reply-all') { const to = extractEmails($('compose-to').value); $('compose-cc').value = [...new Set([...extractEmails(message.to), ...extractEmails(message.cc)])].filter(e => e !== own && !to.includes(e)).join(', '); $('cc-fields').hidden = !$('compose-cc').value; }
      $('compose-subject').value = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`; $('compose-body').value = `\n\nOn ${stamp(message.date, true)}, ${message.from} wrote:\n${text.split('\n').map(s => '> ' + s).join('\n')}`;
      context.threadId = message.threadId; context.inReplyTo = message.messageId; context.references = [message.references, message.messageId].filter(Boolean).join(' ');
    }
  }
  composerBusy(false); $('compose-dialog').showModal(); if (mode === 'new' || mode === 'forward') $('compose-to').focus(); else { $('compose-body').focus(); $('compose-body').setSelectionRange(0, 0); }
  return context;
}
async function importOriginalAttachments(message, context) {
  const files = message.attachments.filter(a => !a.contentId || a.name !== 'inline-image');
  if (!files.length) return;
  composerBusy(true);
  let total = 0;
  try {
    for (const file of files) {
      if (state.compose !== context) return;
      total += file.size || 0;
      if (total > 6 * 1024 * 1024) { context.attachments.push({ name: file.name, size: file.size, error: true }); continue; }
      try { const data = await attachmentData(message, file); if (state.compose !== context) return; context.attachments.push({ ...data, data: standardBase64(data.data), size: base64Bytes(data.data).length }); }
      catch (err) { if (state.compose !== context) return; context.attachments.push({ name: file.name, size: file.size, error: true }); }
    }
    renderComposerAttachments();
    if (context.attachments.some(a => a.error)) notice('compose-notice', 'Some original attachments could not be loaded. Reopen the draft or remove the missing files before saving or sending.');
  } finally { if (state.compose === context) composerBusy(false); }
}
async function editDraft(summary) {
  try { const data = await api(`/api/accounts/${summary.accountId}/drafts/${summary.draftId}`); const context = openCompose({ mode: 'draft', message: data.message, draftId: data.id }); if (context) await importOriginalAttachments(data.message, context); } catch (err) { report(err); }
}
async function saveDraft(showToast = true) {
  const context = state.compose; if (!context || context.busy) return;
  if (context.savePromise) return context.savePromise;
  clearTimeout(context.saveTimer);
  const revision = context.revision; const input = composerPayload(); $('draft-status').textContent = 'Saving…';
  $('compose-from').disabled = true;
  context.savePromise = (async () => {
    try { const data = await api(`/api/accounts/${context.accountId}/drafts`, { method: 'POST', body: input }); if (state.compose !== context || !canUseWorkspace()) return; context.draftId = data.id; context.savedRevision = revision; $('compose-from').disabled = true; $('draft-status').textContent = revision === context.revision ? 'Saved in Gmail' : 'Unsaved changes'; if (showToast) toast(demo ? 'Sample draft saved. Demo only.' : 'Draft saved in Gmail.'); }
    finally { context.savePromise = null; if (state.compose === context && !context.draftId && !context.busy && !['reply', 'reply-all'].includes(context.mode)) $('compose-from').disabled = false; }
  })();
  return context.savePromise;
}
async function closeComposer() {
  const context = state.compose; if (!context) { $('compose-dialog').close(); return; }
  if (context.busy) { toast('Wait for the current action to finish.'); return; }
  if (context.revision !== context.savedRevision && !(await askConfirm('Discard unsaved changes?', 'Your last saved Gmail draft will stay in Drafts. Changes made since that save will be discarded.', 'Discard changes'))) return;
  clearTimeout(context.saveTimer); if (context.savePromise) try { await context.savePromise; } catch (err) { /* An in-flight draft never triggers a send. */ }
  $('compose-dialog').close(); resetComposer();
  if (state.folder === 'DRAFT' && canUseWorkspace()) await loadMessages();
}
async function addFiles(files) {
  const context = state.compose; if (!context || context.busy) return;
  composerBusy(true); clearTimeout(context.saveTimer);
  let total = context.attachments.reduce((n, file) => n + (file.size || 0), 0);
  try {
  for (const file of files) {
    total += file.size;
    if (total > 6 * 1024 * 1024 || context.attachments.length >= 10) { toast('Use up to 10 attachments, totaling 6 MB or less.', true); break; }
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('This file could not be read.')); reader.readAsDataURL(file); });
    if (state.compose !== context) return;
    context.attachments.push({ name: file.name, type: file.type || 'application/octet-stream', data, size: file.size });
  }
  $('attachment-input').value = ''; renderComposerAttachments();
  } finally { if (state.compose === context) { composerBusy(false); composerChanged(); } }
}

hydrateIcons();

// Gate Unlock & Workspace Creation Tabs
$('tab-unlock').addEventListener('click', () => {
  $('tab-unlock').classList.add('active');
  $('tab-create').classList.remove('active');
  $('unlock-form').hidden = false;
  $('create-ws-form').hidden = true;
  notice('gate-notice');
});

$('tab-create').addEventListener('click', () => {
  $('tab-create').classList.add('active');
  $('tab-unlock').classList.remove('active');
  $('create-ws-form').hidden = false;
  $('unlock-form').hidden = true;
  notice('gate-notice');
});

$('toggle-passcode').addEventListener('click', () => {
  $('passcode').type = $('passcode').type === 'password' ? 'text' : 'password';
  $('toggle-passcode').setAttribute('aria-label', $('passcode').type === 'password' ? 'Show passcode' : 'Hide passcode');
});

$('toggle-ws-passcode').addEventListener('click', () => {
  $('ws-passcode').type = $('ws-passcode').type === 'password' ? 'text' : 'password';
});

$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  notice('gate-notice');
  if (!state.configured && $('passcode').value !== $('confirm-passcode').value) {
    notice('gate-notice', 'The passcodes do not match.');
    return;
  }
  $('unlock-button').disabled = true;
  try {
    const session = await api(state.configured ? '/api/lock/unlock' : '/api/lock/setup', {
      method: 'POST',
      body: { passcode: $('passcode').value }
    });
    await enterWorkspace(session);
  } catch (err) {
    notice('gate-notice', err.message);
  } finally {
    $('unlock-button').disabled = false;
  }
});

$('create-ws-form').addEventListener('submit', async event => {
  event.preventDefault();
  notice('gate-notice');
  const name = $('ws-name').value.trim();
  const email = $('ws-email').value.trim();
  const pwd = $('ws-passcode').value;
  const confirm = $('ws-confirm').value;

  if (pwd !== confirm) {
    notice('gate-notice', 'The passcodes do not match.');
    return;
  }
  if (pwd.length < 4) {
    notice('gate-notice', 'Passcode must be at least 4 characters.');
    return;
  }

  $('create-ws-button').disabled = true;
  try {
    const session = await api('/api/workspaces/create', {
      method: 'POST',
      body: { name, email, passcode: pwd }
    });
    toast('Workspace created successfully! Remember to keep your passcode safe.');
    await enterWorkspace(session);
  } catch (err) {
    notice('gate-notice', err.message);
  } finally {
    $('create-ws-button').disabled = false;
  }
});

// Guest Mode Exit
$('guest-exit').addEventListener('click', () => {
  lockDashboard('Exited shared inbox.');
});

// Plans & Pricing Modal
function openPlansDialog() {
  updatePlanUI();
  $('plans-dialog').showModal();
}
$('upgrade-plan-btn').addEventListener('click', openPlansDialog);
$('topbar-plans-btn').addEventListener('click', openPlansDialog);
$('profile-upgrade-btn').addEventListener('click', () => {
  $('profile-dialog').close();
  openPlansDialog();
});

// Complete User Profile Dialog
async function openProfileDialog() {
  if (state.isGuest) return;
  try {
    const prof = await api('/api/profile');
    $('profile-name').value = prof.name || '';
    $('profile-email').value = prof.email || '';
    $('profile-phone').value = prof.phone || '';
    $('profile-company').value = prof.company || '';
    $('profile-bio').value = prof.bio || '';
    const planObj = PLANS[(prof.plan || state.currentPlan || 'free').toUpperCase()] || PLANS.FREE;
    $('profile-plan-name').textContent = `${planObj.name} (${planObj.maxAccounts} accounts)`;
    notice('profile-notice');
    $('profile-dialog').showModal();
  } catch (err) {
    report(err);
  }
}

$('profile-button').addEventListener('click', openProfileDialog);
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  notice('profile-notice');
  const btn = event.submitter;
  btn.disabled = true;
  try {
    const updated = await api('/api/profile', {
      method: 'POST',
      body: {
        name: $('profile-name').value.trim(),
        email: $('profile-email').value.trim(),
        phone: $('profile-phone').value.trim(),
        company: $('profile-company').value.trim(),
        bio: $('profile-bio').value.trim()
      }
    });
    if (updated.name) {
      $('profile-button').textContent = initials(updated.name);
    }
    $('profile-dialog').close();
    toast('Profile saved successfully in RTDB.');
  } catch (err) {
    report(err, 'profile-notice');
  } finally {
    btn.disabled = false;
  }
});
$('signout').addEventListener('click', () => {
  $('profile-dialog').close();
  lockDashboard('Dashboard locked.');
});

// Shared Inboxes Management
function openShareDialog() {
  if (state.isGuest) return;
  const accounts = state.accounts;
  if (!accounts.length) {
    toast('Add a Gmail account before creating a shared inbox link.', true);
    return;
  }
  $('share-account-select').innerHTML = accounts.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.email)} (${esc(a.email)})</option>`).join('');
  $('share-form').reset();
  $('share-passcode').type = 'password';
  notice('share-notice');
  $('share-dialog').showModal();
}
$('share-inbox-btn').addEventListener('click', openShareDialog);
$('share-inbox-header-btn').addEventListener('click', openShareDialog);
$('add-share').addEventListener('click', openShareDialog);
$('toggle-share-pwd').addEventListener('click', () => {
  $('share-passcode').type = $('share-passcode').type === 'password' ? 'text' : 'password';
});
$('share-form').addEventListener('submit', async event => {
  event.preventDefault();
  notice('share-notice');
  const accountId = $('share-account-select').value;
  const label = $('share-label').value.trim();
  const passcode = $('share-passcode').value;

  const btn = event.submitter;
  btn.disabled = true;
  try {
    await api('/api/shares', {
      method: 'POST',
      body: { accountId, label, passcode }
    });
    $('share-dialog').close();
    $('share-form').reset();
    toast('Shared inbox passcode created! The recipient can enter it at the Gate screen.');
    if (state.settings) renderSettingsShares();
  } catch (err) {
    report(err, 'share-notice');
  } finally {
    btn.disabled = false;
  }
});
$('settings-shares').addEventListener('click', async event => {
  const remove = event.target.closest('[data-remove-share]');
  if (remove && await askConfirm('Revoke shared access?', 'This will immediately revoke the guest passcode. The recipient will no longer be able to access this inbox.', 'Revoke access')) {
    try {
      await api(`/api/shares/${remove.dataset.removeShare}`, { method: 'DELETE' });
      await renderSettingsShares();
      toast('Shared inbox access revoked.');
    } catch (err) {
      report(err);
    }
  }
});

// Passwords Toggle & Copy Buttons
$('toggle-gmail-pwd').addEventListener('click', () => {
  $('saved-gmail-password').type = $('saved-gmail-password').type === 'password' ? 'text' : 'password';
});
$('toggle-app-pwd').addEventListener('click', () => {
  $('saved-app-password').type = $('saved-app-password').type === 'password' ? 'text' : 'password';
});
$('show-app-pwd-btn').addEventListener('click', () => {
  $('revealed-app-password').type = $('revealed-app-password').type === 'password' ? 'text' : 'password';
});
$('show-gmail-pwd-btn').addEventListener('click', () => {
  $('revealed-gmail-password').type = $('revealed-gmail-password').type === 'password' ? 'text' : 'password';
});
$('copy-app-pwd-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('revealed-app-password').value);
    toast('App password copied to clipboard.');
  } catch {
    toast('Clipboard access denied.', true);
  }
});
$('copy-gmail-pwd-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('revealed-gmail-password').value);
    toast('Gmail password copied to clipboard.');
  } catch {
    toast('Clipboard access denied.', true);
  }
});

for (const id of ['lock-button', 'settings-lock']) $(id).addEventListener('click', () => lockDashboard());
$('menu-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
document.addEventListener('click', event => { if ($('sidebar').classList.contains('open') && !event.target.closest('#sidebar, #menu-toggle')) $('sidebar').classList.remove('open'); });
for (const id of ['connect-sidebar', 'connect-main']) $(id).addEventListener('click', () => beginConnect());
$('compose-button').addEventListener('click', () => { openCompose(); $('sidebar').classList.remove('open'); });
$('sidebar').addEventListener('click', async event => {
  const folder = event.target.closest('[data-folder]');
  if (folder) {
    if (state.isGuest && folder.dataset.folder !== 'INBOX') return;
    state.folder = folder.dataset.folder;
    state.search = '';
    $('search').value = '';
    state.settings = false;
    $('settings-area').hidden = true;
    $('mail-area').hidden = false;
    $('sidebar').classList.remove('open');
    await loadMessages();
  }
  const account = event.target.closest('[data-account]');
  if (account) {
    if (state.isGuest) return;
    state.account = account.dataset.account;
    renderAccounts();
    state.settings = false;
    $('settings-area').hidden = true;
    $('mail-area').hidden = false;
    $('sidebar').classList.remove('open');
    await loadMessages();
  }
});
$('search-form').addEventListener('submit', event => { event.preventDefault(); state.search = $('search').value.trim(); loadMessages(); });
document.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => { state.filter = el.dataset.filter; loadMessages(); }));
$('account-filter').addEventListener('change', () => { state.account = $('account-filter').value; renderAccounts(); loadMessages(); });
// Live 24/7 Resync Progress Bar & Timer Engine
const syncState = {
  intervalSeconds: 30,
  countdown: 30,
  isSyncing: false,
  timerId: null,
  lastSync: Date.now()
};

function formatTimeAgo(timestamp) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return stamp(timestamp);
}

function updateSyncUI(progress, stageText, isSyncing) {
  const bar = $('sync-progress-bar');
  const pct = $('sync-progress-percentage');
  const ind = $('sync-status-indicator');
  const cdLabel = $('sync-countdown-label');
  const syncBtn = $('sync-now-btn');
  const btnIcon = $('sync-btn-icon');
  const refreshBtn = $('refresh-button');
  const topbarBtn = $('topbar-sync-btn');
  const topbarTimer = $('topbar-sync-timer');
  const stage = $('sync-stage-text');
  const lastTs = $('sync-last-timestamp');

  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    bar.classList.toggle('syncing', isSyncing);
    bar.classList.toggle('idle', !isSyncing);
  }
  if (pct) pct.textContent = `${Math.round(progress)}%`;
  if (ind) {
    ind.classList.toggle('syncing', isSyncing);
    ind.classList.toggle('idle', !isSyncing);
  }
  if (cdLabel) cdLabel.textContent = isSyncing ? 'Syncing...' : `Resync in ${syncState.countdown}s`;
  if (syncBtn) syncBtn.classList.toggle('syncing', isSyncing);
  if (btnIcon) btnIcon.classList.toggle('spinning', isSyncing);
  if (refreshBtn) refreshBtn.classList.toggle('spinning', isSyncing);
  if (topbarBtn) topbarBtn.classList.toggle('syncing', isSyncing);
  if (topbarTimer) topbarTimer.textContent = isSyncing ? 'Syncing...' : `Sync: ${syncState.countdown}s`;
  if (stage && stageText) stage.textContent = stageText;
  if (lastTs) lastTs.textContent = `Updated ${formatTimeAgo(syncState.lastSync)}`;
}

function startSyncTimer() {
  stopSyncTimer();
  syncState.countdown = syncState.intervalSeconds;
  syncState.timerId = setInterval(() => {
    if (!canUseWorkspace()) return;
    if (syncState.isSyncing) return;

    syncState.countdown--;
    if (syncState.countdown <= 0) {
      executeResync('auto');
    } else {
      const pct = Math.max(4, (syncState.countdown / syncState.intervalSeconds) * 100);
      updateSyncUI(pct, `Continuous 30s background sync active · RTDB connected`, false);
    }
  }, 1000);
}

function stopSyncTimer() {
  if (syncState.timerId) {
    clearInterval(syncState.timerId);
    syncState.timerId = null;
  }
}

async function syncOAuthAccountsInBrowser() {
  const oauthAccounts = state.accounts.filter(a => (a.authType === 'oauth' || a.isOAuth) && a.accessToken);
  if (!oauthAccounts.length) return 0;

  let totalFetched = 0;
  for (const account of oauthAccounts) {
    try {
      let token = account.accessToken;
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=in:inbox', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const msgs = data.messages || [];

      for (const item of msgs) {
        try {
          const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const headers = detail.payload?.headers || [];
          const getH = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

          const msgId = String(detail.id).replace(/[<>#$[\]/.]/g, '_').slice(0, 80);
          const labels = detail.labelIds || [];
          const isStarred = labels.includes('STARRED');
          const isUnread = labels.includes('UNREAD');
          const dHeader = getH('Date');
          const timestamp = dHeader ? new Date(dHeader).getTime() : (Number(detail.internalDate) || Date.now());

          let text = '';
          let html = '';
          function parseP(part) {
            if (!part) return;
            if (part.mimeType === 'text/plain' && part.body?.data) {
              try { text = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/')); } catch {}
            } else if (part.mimeType === 'text/html' && part.body?.data) {
              try { html = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/')); } catch {}
            }
            if (part.parts) for (const c of part.parts) parseP(c);
          }
          parseP(detail.payload);

          const summary = {
            id: msgId,
            threadId: detail.threadId || msgId,
            accountId: account.id,
            accountEmail: account.email,
            from: getH('From') || 'Unknown',
            to: getH('To') || account.email,
            cc: getH('Cc') || '',
            bcc: getH('Bcc') || '',
            subject: getH('Subject') || '(No subject)',
            snippet: (detail.snippet || text || '').slice(0, 160),
            date: timestamp,
            unread: isUnread,
            starred: isStarred,
            folder: 'INBOX',
            labels: isStarred ? ['INBOX', 'STARRED'] : ['INBOX'],
            hasAttachments: false,
            attachmentsCount: 0
          };

          const body = {
            id: msgId,
            text: text || detail.snippet || '',
            html: html || (text ? `<div><p>${text.replace(/\n/g, '<br>')}</p></div>` : ''),
            attachments: []
          };

          await fetch(`https://firemailai-default-rtdb.firebaseio.com/mailroom/messages/${msgId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(summary)
          });
          await fetch(`https://firemailai-default-rtdb.firebaseio.com/mailroom/bodies/${msgId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          totalFetched++;
        } catch {}
      }
    } catch {}
  }
  return totalFetched;
}

async function executeResync(trigger = 'manual') {
  if (syncState.isSyncing || !canUseWorkspace()) return;
  syncState.isSyncing = true;
  syncState.countdown = syncState.intervalSeconds;

  const wait = ms => new Promise(res => setTimeout(res, ms));

  try {
    // Stage 1: Initiating
    updateSyncUI(15, 'Connecting to Gmail servers (IMAP & OAuth REST API)...', true);
    await wait(200);

    // Stage 2: Triggering background sync & syncing browser-side OAuth
    updateSyncUI(40, 'Scanning incoming folders for new messages...', true);
    await triggerSyncRequest();
    invalidateMessageCache();
    await syncOAuthAccountsInBrowser();
    await wait(250);

    // Stage 3: Fetching and writing to RTDB
    updateSyncUI(75, 'Synchronizing live messages from RTDB...', true);
    await Promise.allSettled([loadAccounts(), loadMessages(false, true)]);
    await wait(250);

    // Stage 4: Cache revalidation
    updateSyncUI(95, 'Updating live inbox view...', true);
    await wait(200);

    // Stage 5: Completed
    syncState.lastSync = Date.now();
    updateSyncUI(100, 'Sync completed · All inboxes are up to date', true);
    if (trigger === 'manual') {
      toast('Inbox synchronized successfully!');
    }
    await wait(500);
  } catch (err) {
    report(err);
    updateSyncUI(100, `Sync notice: ${err.message || 'Updated'}`, false);
  } finally {
    syncState.isSyncing = false;
    syncState.countdown = syncState.intervalSeconds;
    updateSyncUI(100, 'Live Continuous Sync active · checks every 30s', false);
  }
}

$('refresh-button').addEventListener('click', () => executeResync('manual'));
$('sync-now-btn').addEventListener('click', () => executeResync('manual'));
$('topbar-sync-btn').addEventListener('click', () => executeResync('manual'));

$('load-more').addEventListener('click', () => loadMessages(true));
$('message-list').addEventListener('click', async event => {
  const open = event.target.closest('[data-open]');
  if (open) openThread(state.messages[Number(open.dataset.open)]);
  const star = event.target.closest('[data-star]');
  if (star) {
    star.disabled = true;
    const m = state.messages[Number(star.dataset.star)];
    try { await messageAction(m, m.starred ? 'unstar' : 'star'); }
    catch (err) { report(err); star.disabled = false; }
  }
  if (event.target.closest('[data-connect-first]')) beginConnect();
  if (event.target.closest('[data-retry]')) loadMessages();
});
$('inbox-errors').addEventListener('click', event => {
  const button = event.target.closest('[data-reconnect]');
  if (button) beginConnect(button.dataset.reconnect);
});
$('reader').addEventListener('click', async event => {
  if (event.target.closest('[data-reader-close]')) { closeReader(); renderMessages(); return; }
  const action = event.target.closest('[data-thread-action]'); if (action) { action.disabled = true; await threadAction(action.dataset.threadAction); return; }
  const remote = event.target.closest('[data-load-images]'); if (remote && state.reader) renderBody(state.reader.messages[Number(remote.dataset.loadImages)], Number(remote.dataset.loadImages), true);
  const attachment = event.target.closest('[data-attachment-message]'); if (attachment && state.reader) { const m = state.reader.messages[Number(attachment.dataset.attachmentMessage)]; const file = m.attachments.find(a => (a.id || '') === attachment.dataset.attachmentId && (a.partId || '') === attachment.dataset.attachmentPart); if (file) downloadAttachment(m, file); }
  for (const [attribute, mode] of [['data-reply', 'reply'], ['data-reply-all', 'reply-all'], ['data-forward', 'forward']]) { const button = event.target.closest(`[${attribute}]`); if (button && state.reader) { const message = state.reader.messages[Number(button.getAttribute(attribute))]; const context = openCompose({ mode, message }); if (context && mode === 'forward') await importOriginalAttachments(message, context); } }
});
$('settings-button').addEventListener('click', showSettings);
$('back-inbox').addEventListener('click', () => { state.settings = false; $('settings-area').hidden = true; $('mail-area').hidden = false; loadMessages(); });
$('add-account').addEventListener('click', () => openAccount());
$('settings-accounts').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-account]'); if (edit) openAccount(edit.dataset.editAccount);
  const connect = event.target.closest('[data-connect-account]'); if (connect) beginConnect(connect.dataset.connectAccount);
  const reveal = event.target.closest('[data-reveal]'); if (reveal) revealPassword(reveal.dataset.reveal);
  if (event.target.closest('[data-connect-first]')) beginConnect();
  const remove = event.target.closest('[data-remove-account]'); if (remove && await askConfirm('Remove this account?', 'This removes its saved password and Gmail connection from this workspace. Your Gmail messages will stay in Google.', 'Remove account')) { try { await api(`/api/accounts/${remove.dataset.removeAccount}`, { method: 'DELETE', body: {} }); await loadAccounts(); toast('Account removed from this workspace.'); } catch (err) { report(err); } }
  const disconnect = event.target.closest('[data-disconnect]'); if (disconnect && await askConfirm('Disconnect this inbox?', 'This removes the saved Gmail token. Account details stay in your vault. You can reconnect later.', 'Disconnect')) { try { await api(`/api/accounts/${disconnect.dataset.disconnect}/disconnect`, { method: 'POST', body: {} }); await loadAccounts(); toast('Inbox disconnected.'); } catch (err) { report(err); } }
});

$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  notice('account-notice');
  const button = event.submitter;
  button.disabled = true;
  try {
    const aid = $('account-form').dataset.accountId || undefined;
    await api('/api/accounts', {
      method: 'PUT',
      body: {
        id: aid,
        email: $('saved-email').value.trim(),
        label: $('saved-label').value.trim(),
        gmailPassword: $('saved-gmail-password').value || undefined,
        appPassword: $('saved-app-password').value || undefined,
        clearGmailPassword: $('clear-gmail-pwd').checked,
        clearAppPassword: $('clear-app-pwd').checked
      }
    });
    $('saved-gmail-password').value = '';
    $('saved-app-password').value = '';
    $('account-dialog').close();
    await loadAccounts();
    if (state.settings) renderSettingsAccounts();
    toast('Account & passwords saved securely in RTDB.');
  } catch (err) {
    report(err, 'account-notice');
  } finally {
    button.disabled = false;
  }
});

$('change-lock').addEventListener('click', () => { $('change-lock-form').reset(); notice('change-lock-notice'); $('change-lock-dialog').showModal(); });
$('change-lock-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('new-passcode').value !== $('repeat-passcode').value) {
    notice('change-lock-notice', 'The new passcodes do not match.');
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  try {
    const session = await api('/api/lock/change', {
      method: 'POST',
      body: { currentPasscode: $('current-passcode').value, passcode: $('new-passcode').value }
    });
    state.vaultToken = session.token;
    state.expiresAt = session.expiresAt;
    $('change-lock-dialog').close();
    $('change-lock-form').reset();
    toast(demo ? 'Passcode change previewed. Demo unlock remains demo1234.' : 'Passcode updated. Other sessions are now locked.');
  } catch (err) {
    report(err, 'change-lock-notice');
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
$('account-dialog').addEventListener('close', () => {
  $('saved-gmail-password').value = '';
  $('saved-app-password').value = '';
  delete $('account-form').dataset.accountId;
});
$('change-lock-dialog').addEventListener('close', () => $('change-lock-form').reset());
$('password-dialog').addEventListener('close', clearRevealedPasswords);
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('cancel'));
$('confirm-ok').addEventListener('click', () => $('confirm-dialog').close('confirm'));
$('compose-close').addEventListener('click', closeComposer); $('compose-dialog').addEventListener('cancel', event => { event.preventDefault(); closeComposer(); });
$('compose-form').addEventListener('input', composerChanged);
$('compose-from').addEventListener('change', () => { if (state.compose) { state.compose.accountId = $('compose-from').value; composerChanged(); } });
$('toggle-cc').addEventListener('click', () => { $('cc-fields').hidden = !$('cc-fields').hidden; });
$('attachment-input').addEventListener('change', () => addFiles([...$('attachment-input').files]).catch(err => report(err, 'compose-notice')));
$('compose-attachments').addEventListener('click', event => { const button = event.target.closest('[data-remove-attachment]'); if (button && state.compose && !state.compose.busy) { state.compose.attachments.splice(Number(button.dataset.removeAttachment), 1); renderComposerAttachments(); composerChanged(); } });
$('save-draft').addEventListener('click', () => saveDraft(true).catch(err => report(err, 'compose-notice')));
$('compose-form').addEventListener('submit', async event => {
  event.preventDefault(); const context = state.compose; if (!context || context.busy) return; clearTimeout(context.saveTimer); notice('compose-notice'); composerBusy(true);
  let sendStarted = false;
  try { if (context.savePromise) await context.savePromise; if (state.compose !== context) return; const payload = composerPayload(); sendStarted = true; const result = await api(`/api/accounts/${context.accountId}/send`, { method: 'POST', body: payload }); if (!result.sent || state.compose !== context) return; $('compose-dialog').close(); resetComposer(); toast(demo ? 'Sample message added to Sent. No email was delivered.' : 'Message sent.'); if (['SENT', 'DRAFT'].includes(state.folder)) await loadMessages(); }
  catch (err) { if (state.compose !== context) return; if (err.code === 'SEND_UNCERTAIN' || sendStarted && !err.status && !demo) { context.deliveryUncertain = true; $('send-button').disabled = true; notice('compose-notice', (err.code === 'SEND_UNCERTAIN' ? err.message : 'The connection was lost before delivery could be confirmed.') + ' Close this window and check Sent before creating another copy.'); } else { report(err, 'compose-notice'); if (err.status && err.status < 500) context.sendKey = crypto.randomUUID(); } }
  finally { if (state.compose === context) { composerBusy(false); if (context.deliveryUncertain) $('send-button').disabled = true; } }
});
// Google OAuth 2.0 PKCE & 1-Click Connection
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, dec => ('0' + dec.toString(16)).slice(-2)).join('');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function initiateGoogleOAuth() {
  if (state.isGuest) return;
  const planKey = (state.currentPlan || 'free').toUpperCase();
  const max = PLANS[planKey]?.maxAccounts || 5;
  if (state.accounts.length >= max) {
    toast(`Plan limit reached! Your ${PLANS[planKey]?.name || 'Free Plan'} allows up to ${max} accounts. Please upgrade.`, true);
    openPlansDialog();
    return;
  }

  try {
    const config = await api('/api/oauth/config');
    const clientId = config?.clientId || localStorage.getItem('firemail_oauth_client_id') || '';
    const redirectUri = config?.redirectUri || (window.location.origin + '/api/oauth/callback');

    if (!clientId) {
      toast('Please configure your Google OAuth Client ID first.', true);
      openOAuthConfigDialog();
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem('firemail_oauth_verifier', verifier);
    localStorage.setItem('firemail_oauth_verifier', verifier);
    sessionStorage.setItem('firemail_oauth_client_id', clientId);
    state.oauthPending = true;

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      include_granted_scopes: 'true'
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const popup = window.open(authUrl, 'firemail_google_oauth', 'width=560,height=680,menubar=no,toolbar=no');
    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      window.location.href = authUrl;
    }
  } catch (err) {
    report(err);
  }
}

async function openOAuthConfigDialog() {
  if (state.isGuest) return;
  try {
    const config = await api('/api/oauth/config');
    $('oauth-client-id').value = config?.clientId || '';
    $('oauth-client-secret').value = config?.clientSecret || '';
    $('oauth-redirect-uri').textContent = config?.redirectUri || (window.location.origin + '/api/oauth/callback');
    notice('oauth-notice');
    $('oauth-config-dialog').showModal();
  } catch (err) {
    report(err);
  }
}

async function handleOAuthConfigSubmit(event) {
  event.preventDefault();
  notice('oauth-notice');
  const clientId = $('oauth-client-id').value.trim();
  const clientSecret = $('oauth-client-secret').value.trim();

  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/oauth/config', {
      method: 'POST',
      body: { clientId, clientSecret }
    });
    $('oauth-config-dialog').close();
    toast('Google OAuth 2.0 configuration saved in RTDB.');
  } catch (err) {
    report(err, 'oauth-notice');
  } finally {
    button.disabled = false;
  }
}

// OAuth Button Event Listeners
if ($('google-oauth-btn')) $('google-oauth-btn').addEventListener('click', initiateGoogleOAuth);
if ($('configure-oauth-btn')) $('configure-oauth-btn').addEventListener('click', () => {
  $('account-dialog').close();
  openOAuthConfigDialog();
});
if ($('oauth-settings-btn')) $('oauth-settings-btn').addEventListener('click', openOAuthConfigDialog);
if ($('oauth-config-form')) $('oauth-config-form').addEventListener('submit', handleOAuthConfigSubmit);
if ($('copy-redirect-uri-btn')) $('copy-redirect-uri-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('oauth-redirect-uri').textContent);
    toast('Authorized redirect URI copied to clipboard.');
  } catch {
    toast('Clipboard access denied.', true);
  }
});

window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.data?.type !== 'mailroom:oauth') return;
  state.oauthPending = false;
  if ($('account-dialog').open) $('account-dialog').close();
  if ($('oauth-config-dialog').open) $('oauth-config-dialog').close();
  if (!event.data.ok) {
    toast('Google OAuth connection was cancelled or incomplete.', true);
    return;
  }
  if (canUseWorkspace()) {
    try {
      await loadAccounts();
      if (state.settings) await showSettings();
      else await loadMessages();
      toast(`Google account connected via 1-Click OAuth! (${event.data.detail || ''})`);
      executeResync('auto');
    } catch (err) {
      report(err);
    }
  }
});
for (const name of ['pointerdown', 'keydown', 'input', 'scroll']) document.addEventListener(name, () => { state.lastActivity = Date.now(); }, { capture: true, passive: true });
setInterval(() => { if (!canUseWorkspace()) return; if (Date.now() >= state.expiresAt || Date.now() - state.lastActivity > 10 * 60000) lockDashboard('Your dashboard locked automatically. Enter your passcode to continue.'); else $('session-label').textContent = `Unlocked · ${Math.ceil((state.expiresAt - Date.now()) / 60000)}m`; }, 5000);
document.addEventListener('visibilitychange', () => { if (canUseWorkspace() && (Date.now() >= state.expiresAt || Date.now() - state.lastActivity > 10 * 60000)) lockDashboard('Your dashboard locked while you were away.'); });
document.addEventListener('keydown', event => { if (event.target.matches('input, textarea, select') || document.querySelector('dialog[open]') || !canUseWorkspace()) return; if (event.key === '/') { event.preventDefault(); $('search').focus(); } if (event.key.toLowerCase() === 'c') { event.preventDefault(); openCompose(); } if (event.key === 'Escape') { closeReader(); renderMessages(); $('sidebar').classList.remove('open'); } });

async function boot() {
  if (demo) {
    state.user = { email: 'you@mailroom.example', displayName: 'Your Workspace' };
    await enterWorkspace({ token: 'demo', expiresAt: Date.now() + 1800000 });
    return;
  }
  try {
    await initRTDB();
    state.user = { email: 'owner@firemailai.web.app', displayName: 'Dashboard Owner' };
    const status = await getLockStatus();
    state.configured = status.configured;
    showGate();
  } catch (err) {
    state.configured = false;
    showGate();
    notice('gate-notice', 'Connected to Firebase RTDB. Set your master passcode to begin.', true);
  }
}
boot();

import { icon, hydrateIcons } from './icons.js';
import { sanitizeEmailHTML, emailPlainText } from './email-sanitizer.js';
import { demoRequest, connectDemo } from './demo.js';
import {
  initRTDB,
  getLockStatus,
  setupPasscode,
  verifyPasscode,
  changePasscode,
  getAccounts,
  getAccountPassword,
  saveAccount,
  removeAccount,
  getMessages,
  getThread,
  messageAction as rtdbMessageAction,
  saveDraftMessage,
  sendEmailMessage,
  getAudit,
  logAudit,
  triggerSyncRequest
} from './rtdb.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const demo = new URLSearchParams(location.search).get('demo') === '1';
const palette = ['#e8c9b2', '#c4dcae', '#d6ccdf', '#b8d3dd', '#e7dda6', '#cfddce'];
const folders = { INBOX: ['Inbox', 'All your conversations, in one place.'], STARRED: ['Starred', 'The conversations you want to keep close.'], SENT: ['Sent', 'A little record of what you have shared.'], DRAFT: ['Drafts', 'Good ideas, ready when you are.'], ALL: ['All mail', 'Your mail, across every folder except Spam and Trash.'], SPAM: ['Spam', 'Messages Gmail has kept out of your inbox.'], TRASH: ['Trash', 'Deleted mail stays here until Gmail removes it.'] };
const state = { user: null, identity: null, configured: true, vaultToken: '', expiresAt: 0, epoch: 0, controller: new AbortController(), accounts: [], messages: [], folder: 'INBOX', account: 'all', search: '', filter: 'all', cursor: null, listVersion: 0, readerVersion: 0, reader: null, activeId: null, compose: null, lastActivity: Date.now(), loading: false, oauthPending: false, settings: false };
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

  if (path === '/api/accounts' && method === 'GET') {
    const accounts = await getAccounts();
    return { accounts };
  }
  if (path === '/api/accounts' && method === 'PUT') {
    return saveAccount(body);
  }
  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && method === 'DELETE') {
    return removeAccount(accountMatch[1]);
  }
  const passwordMatch = path.match(/^\/api\/accounts\/([^/]+)\/password$/);
  if (passwordMatch) {
    const password = await getAccountPassword(passwordMatch[1]);
    return { password };
  }

  if (path.startsWith('/api/messages')) {
    const url = new URL('http://local' + path);
    const folder = url.searchParams.get('folder') || 'INBOX';
    const account = url.searchParams.get('account') || 'all';
    const q = url.searchParams.get('q') || '';
    return getMessages({ folder, account, q });
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

  throw new Error(`Route not supported: ${path}`);
}

function showGate(message = '') {
  $('workspace').hidden = true;
  $('gate').hidden = false;
  $('unlock-form').hidden = false;
  $('confirm-field').hidden = state.configured;
  $('confirm-passcode').required = !state.configured;
  $('passcode').autocomplete = state.configured ? 'current-password' : 'new-password';
  $('gate-title').textContent = state.configured ? 'Dashboard Locked' : 'Set Master Passcode';
  $('gate-description').textContent = state.configured
    ? 'Enter your master passcode to unlock Firemail AI and access all stored accounts.'
    : 'Create a master passcode (at least 4 characters). Stored in Firebase Realtime Database.';
  $('unlock-button').innerHTML = (state.configured ? 'Unlock dashboard ' : 'Set passcode & enter ') + icon('arrow-right');
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
}
function lockDashboard(message = '', invalidate = true) {
  const oldToken = state.vaultToken, oldUser = state.user;
  state.vaultToken = ''; state.expiresAt = 0; state.epoch++; state.controller.abort(); state.controller = new AbortController();
  clearPrivateUI(); showGate(message);
  if (invalidate && oldToken && oldUser && !demo) oldUser.getIdToken().then(token => fetch('/api/lock', { method: 'POST', cache: 'no-store', keepalive: true, headers: { Authorization: `Bearer ${token}`, 'X-Vault-Session': oldToken, 'Content-Type': 'application/json' }, body: '{}' })).catch(() => {});
}
async function enterWorkspace(session) {
  state.vaultToken = session.token; state.expiresAt = session.expiresAt; state.lastActivity = Date.now(); state.configured = true;
  $('passcode').value = ''; $('confirm-passcode').value = '';
  $('gate').hidden = true; $('workspace').hidden = false; $('demo-badge').hidden = !demo;
  $('profile-button').textContent = initials(state.user?.displayName || state.user?.email || 'Your Workspace');
  $('settings-area').hidden = true; $('mail-area').hidden = false; state.settings = false;
  try { await loadAccounts(); await loadMessages(); } catch (err) { report(err); }
}
async function loadAccounts() { const result = await api('/api/accounts'); if (!canUseWorkspace()) return; state.accounts = result.accounts; if (state.account !== 'all' && !state.accounts.some(a => a.id === state.account)) state.account = 'all'; renderAccounts(); }
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
async function loadMessages(append = false) {
  if (!canUseWorkspace()) return;
  const version = ++state.listVersion; state.loading = true; updateHeadings(); $('refresh-button').disabled = true; $('load-more').disabled = true;
  if (!append) { state.messages = []; state.cursor = null; $('message-list').innerHTML = skeletonRows(); $('inbox-errors').hidden = true; closeReader(); }
  const search = [state.search, state.filter === 'unread' ? 'is:unread' : ''].filter(Boolean).join(' ');
  try {
    const data = await api(`/api/messages?${query({ folder: state.folder, account: state.account, q: search, cursor: append ? state.cursor : null })}`);
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
async function showSettings() { state.settings = true; closeReader(); $('mail-area').hidden = true; $('settings-area').hidden = false; $('sidebar').classList.remove('open'); renderSettingsAccounts(); $('audit-list').textContent = 'Loading activity…'; try { const data = await api('/api/audit'); if (!state.settings || !canUseWorkspace()) return; const descriptions = { 'lock.created': 'Master passcode created', 'lock.changed': 'Master passcode changed', 'dashboard.unlocked': 'Dashboard unlocked', 'account.saved': 'Account details & password saved in RTDB', 'account.removed': 'Account removed', 'password.revealed': 'Saved password revealed', 'mail.sent': 'Message sent' }; $('audit-list').innerHTML = data.events.length ? data.events.slice(0, 20).map(e => `<div class="audit-row"><span>${esc(descriptions[e.action] || e.action)}${e.accountId ? ' · ' + esc(accountLabel(e.accountId)) : ''}</span><span>${esc(stamp(e.at, true))}</span></div>`).join('') : '<p class="audit-empty">Your workspace activity will appear here.</p>'; } catch (err) { report(err); } }
function renderSettingsAccounts() {
  $('settings-accounts').innerHTML = state.accounts.length ? state.accounts.map(a => `<div class="saved-account"><div class="sender-avatar" style="background:${color(a.email)}">${esc(initials(a.label || a.email))}</div><div class="saved-account-main"><strong>${esc(a.label || a.email.split('@')[0])}<span class="account-status connected">SAVED IN RTDB</span></strong><small>${esc(a.email)}</small></div><div class="saved-account-actions">${a.hasPassword ? `<button class="icon-button" data-reveal="${esc(a.id)}" aria-label="Reveal password for ${esc(a.email)}">${icon('eye')}</button>` : ''}<button class="icon-button" data-edit-account="${esc(a.id)}" aria-label="Edit ${esc(a.email)}">${icon('edit')}</button><button class="icon-button" data-remove-account="${esc(a.id)}" aria-label="Remove ${esc(a.email)}">${icon('trash')}</button></div></div>`).join('') : '<div class="empty-state"><div class="empty-icon">' + icon('mail') + '</div><h3>Your first Gmail account</h3><p>Save your Gmail address and password into Firebase RTDB.</p><button class="button primary" data-connect-first>Add Gmail account</button></div>';
}
function openAccount(aid = null) { const account = state.accounts.find(a => a.id === aid); $('account-form').reset(); $('saved-email').disabled = Boolean(account); $('saved-email').value = account?.email || ''; $('saved-label').value = account?.label || ''; $('saved-password').placeholder = account?.hasPassword ? 'Leave blank to keep the saved password' : 'Encrypted before it is saved'; $('clear-password-label').hidden = !account?.hasPassword; $('account-dialog-title').textContent = account ? 'Edit account details' : 'Save an account'; notice('account-notice'); $('account-dialog').showModal(); }
async function askConfirm(title, message, button = 'Continue') { $('confirm-title').textContent = title; $('confirm-text').textContent = message; $('confirm-ok').textContent = button; const dialog = $('confirm-dialog'); dialog.showModal(); return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true })); }
function clearRevealedPassword() { clearTimeout(revealTimer); $('revealed-password').value = ''; $('revealed-password').type = 'password'; $('password-email').textContent = ''; $('show-saved-password').textContent = 'Show'; }
async function revealPassword(aid) { try { const data = await api(`/api/accounts/${aid}/password`, { method: 'POST', body: {} }); if (!canUseWorkspace()) return; clearRevealedPassword(); $('password-email').textContent = state.accounts.find(a => a.id === aid)?.email || ''; $('revealed-password').value = data.password; $('password-dialog').showModal(); revealTimer = setTimeout(() => { $('password-dialog').close(); clearRevealedPassword(); }, 30000); } catch (err) { report(err); } }

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
  const aid = message?.accountId || (state.account !== 'all' && accounts.some(a => a.id === state.account) ? state.account : accounts[0].id);
  const context = state.compose = { accountId: aid, draftId, mode, attachments: [], revision: 0, savedRevision: 0, sendKey: crypto.randomUUID(), busy: false };
  $('compose-from').innerHTML = accounts.map(a => `<option value="${esc(a.id)}">${esc(a.label || a.email)} — ${esc(a.email)}</option>`).join(''); $('compose-from').value = aid;
  $('compose-from').disabled = Boolean(draftId) || ['reply', 'reply-all'].includes(mode);
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
$('toggle-passcode').addEventListener('click', () => {
  $('passcode').type = $('passcode').type === 'password' ? 'text' : 'password';
  $('toggle-passcode').setAttribute('aria-label', $('passcode').type === 'password' ? 'Show passcode' : 'Hide passcode');
});
function signOut() {
  lockDashboard('Dashboard locked.');
}
$('signout').addEventListener('click', () => {
  $('profile-dialog').close();
  signOut();
});
for (const id of ['lock-button', 'settings-lock']) $(id).addEventListener('click', () => lockDashboard());
$('profile-button').addEventListener('click', () => { $('profile-email').textContent = state.user?.email || 'Demo workspace · no real Gmail connected'; $('profile-dialog').showModal(); });
$('menu-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
document.addEventListener('click', event => { if ($('sidebar').classList.contains('open') && !event.target.closest('#sidebar, #menu-toggle')) $('sidebar').classList.remove('open'); });
for (const id of ['connect-sidebar', 'connect-main']) $(id).addEventListener('click', () => beginConnect());
$('compose-button').addEventListener('click', () => { openCompose(); $('sidebar').classList.remove('open'); });
$('sidebar').addEventListener('click', async event => {
  const folder = event.target.closest('[data-folder]'); if (folder) { state.folder = folder.dataset.folder; state.search = ''; $('search').value = ''; state.settings = false; $('settings-area').hidden = true; $('mail-area').hidden = false; $('sidebar').classList.remove('open'); await loadMessages(); }
  const account = event.target.closest('[data-account]'); if (account) { state.account = account.dataset.account; renderAccounts(); state.settings = false; $('settings-area').hidden = true; $('mail-area').hidden = false; $('sidebar').classList.remove('open'); await loadMessages(); }
});
$('search-form').addEventListener('submit', event => { event.preventDefault(); state.search = $('search').value.trim(); loadMessages(); });
document.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => { state.filter = el.dataset.filter; loadMessages(); }));
$('account-filter').addEventListener('change', () => { state.account = $('account-filter').value; renderAccounts(); loadMessages(); });
$('refresh-button').addEventListener('click', async () => {
  try {
    toast('Refreshing mail from RTDB...');
    await triggerSyncRequest();
    await loadAccounts();
    await loadMessages();
  } catch (err) {
    report(err);
  }
});
$('load-more').addEventListener('click', () => loadMessages(true));
$('message-list').addEventListener('click', async event => { const open = event.target.closest('[data-open]'); if (open) openThread(state.messages[Number(open.dataset.open)]); const star = event.target.closest('[data-star]'); if (star) { star.disabled = true; const m = state.messages[Number(star.dataset.star)]; try { await messageAction(m, m.starred ? 'unstar' : 'star'); } catch (err) { report(err); star.disabled = false; } } if (event.target.closest('[data-connect-first]')) beginConnect(); if (event.target.closest('[data-retry]')) loadMessages(); });
$('inbox-errors').addEventListener('click', event => { const button = event.target.closest('[data-reconnect]'); if (button) beginConnect(button.dataset.reconnect); });
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
$('account-form').addEventListener('submit', async event => { event.preventDefault(); notice('account-notice'); if ($('clear-password').checked && $('saved-password').value) { notice('account-notice', 'Choose either a new password or remove the saved one.'); return; } const button = event.submitter; button.disabled = true; try { await api('/api/accounts', { method: 'PUT', body: { email: $('saved-email').value.trim(), label: $('saved-label').value.trim(), password: $('saved-password').value || undefined, clearPassword: $('clear-password').checked } }); $('saved-password').value = ''; $('account-dialog').close(); await loadAccounts(); toast(demo ? 'Sample account saved in memory. Demo only.' : 'Account details saved securely.'); } catch (err) { report(err, 'account-notice'); } finally { button.disabled = false; } });
$('change-lock').addEventListener('click', () => { $('change-lock-form').reset(); notice('change-lock-notice'); $('change-lock-dialog').showModal(); });
$('change-lock-form').addEventListener('submit', async event => { event.preventDefault(); if ($('new-passcode').value !== $('repeat-passcode').value) { notice('change-lock-notice', 'The new passcodes do not match.'); return; } const button = event.submitter; button.disabled = true; try { const session = await api('/api/lock/change', { method: 'POST', body: { currentPasscode: $('current-passcode').value, passcode: $('new-passcode').value } }); state.vaultToken = session.token; state.expiresAt = session.expiresAt; $('change-lock-dialog').close(); $('change-lock-form').reset(); toast(demo ? 'Passcode change previewed. Demo unlock remains demo1234.' : 'Passcode updated. Other sessions are now locked.'); } catch (err) { report(err, 'change-lock-notice'); } finally { button.disabled = false; } });
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
$('account-dialog').addEventListener('close', () => { $('saved-password').value = ''; });
$('change-lock-dialog').addEventListener('close', () => $('change-lock-form').reset());
$('password-dialog').addEventListener('close', clearRevealedPassword);
$('show-saved-password').addEventListener('click', () => { $('revealed-password').type = $('revealed-password').type === 'password' ? 'text' : 'password'; $('show-saved-password').textContent = $('revealed-password').type === 'password' ? 'Show' : 'Hide'; });
$('copy-saved-password').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('revealed-password').value); toast('Password copied.'); } catch { toast('Clipboard access was denied. Use Show to copy it manually.', true); } });
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close('cancel')); $('confirm-ok').addEventListener('click', () => $('confirm-dialog').close('confirm'));
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
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.data?.type !== 'mailroom:oauth' || !state.oauthPending) return;
  state.oauthPending = false;
  if (!event.data.ok) { toast('The Gmail connection did not complete. Check SETUP.md or try connecting again.', true); return; }
  if (canUseWorkspace()) { try { await loadAccounts(); if (state.settings) await showSettings(); else await loadMessages(); toast('Gmail inbox connected.'); } catch (err) { report(err); } }
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

// Synthetic mail only. Demo mode never calls Gmail, Firebase Auth or the API.
const at = Date.now();
export const demoAccounts = [
  { id: 'demo_personal', email: 'personal@mailroom.example', label: 'Personal', connected: true, status: 'active', hasPassword: true, createdAt: at },
  { id: 'demo_studio', email: 'studio@mailroom.example', label: 'Studio', connected: true, status: 'active', hasPassword: false, createdAt: at },
  { id: 'demo_projects', email: 'projects@mailroom.example', label: 'Projects', connected: true, status: 'active', hasPassword: false, createdAt: at }
];
const seeds = [
  ['demo_studio', 'Ava Miller <ava@sender.example>', 'Website refresh — ready for your review', 'The updated pages are ready. A few small details made a big difference.', true, true, 18, 'Hi there,\n\nThe updated pages are ready for your review. I have cleaned up the mobile navigation, improved the loading states, and added the new contact section.\n\nCould you take a look at the hero section and let me know which headline you prefer?\n\nI have attached a short project brief with the remaining tasks.\n\nThanks,\nAva'],
  ['demo_personal', 'Noah Clarke <noah@sender.example>', 'Coffee sometime this week?', 'Found a new place around the corner. Thursday afternoon could work?', true, false, 43, 'Hey,\n\nI found a new coffee spot around the corner. Are you free Thursday afternoon?\n\nNo agenda, just a catch-up.\n\nNoah'],
  ['demo_projects', 'Team Orchard <team@sender.example>', 'Your weekly project notes', 'Three updates, two next steps, and one very good piece of news.', true, false, 88, 'Hello!\n\nThis week we shipped the form improvements, finished the account settings, and reviewed the mobile experience.\n\nNext up: connect the production database and complete the final accessibility pass.\n\nHave a good week,\nThe Orchard team'],
  ['demo_studio', 'Lena Park <lena@sender.example>', 'A few ideas for the next chapter', 'I have put together some references. Nothing complicated, just a clearer direction.', false, true, 160, 'Hi,\n\nA few ideas for the next chapter:\n\n• Keep the interface quieter.\n• Give the important actions more space.\n• Make the account labels easy to scan.\n\nLet me know what feels right.\n\nLena'],
  ['demo_personal', 'Book Club <hello@sender.example>', 'Something good to read this weekend', 'Our latest pick is here. A short read for a slow Sunday morning.', false, false, 260, 'Hello readers,\n\nOur latest reading list is ready: a thoughtful essay, a small travel story, and a practical guide to keeping a notebook.\n\nMake a cup of tea, find a quiet corner, and enjoy.'],
  ['demo_projects', 'Sam Rivera <sam@sender.example>', 'Quick check on the dashboard', 'Everything is looking good. I left a couple of notes about the compose window.', false, false, 460, 'Hi,\n\nEverything is looking good. Please keep the From account visible when replying, and make sure saved drafts appear in the Drafts folder.\n\nThe attachment buttons should also work comfortably on mobile.\n\nCheers,\nSam'],
  ['demo_personal', 'Hina <hina@sender.example>', 'کل کی میٹنگ کے بارے میں', 'السلام علیکم، کل کی میٹنگ کا وقت دوپہر تین بجے ہے۔', true, false, 900, 'السلام علیکم،\n\nکل کی میٹنگ کا وقت دوپہر تین بجے ہے۔ براہ کرم اپنی دستیابی کی تصدیق کر دیں۔\n\nشکریہ'],
  ['demo_studio', 'Oliver James <oliver@sender.example>', 'The final files are all set', 'Thanks for the thoughtful feedback. I have included the latest revisions.', false, false, 1450, 'Hi,\n\nThanks for the thoughtful feedback. The final files are all set, including the responsive layouts and the revised copy.\n\nReally enjoyed working on this together.\n\nBest,\nOliver']
];
const records = seeds.map((s, i) => ({ id: `demo_message_${i}`, threadId: `demo_thread_${i}`, accountId: s[0], accountEmail: demoAccounts.find(a => a.id === s[0]).email, from: s[1], to: demoAccounts.find(a => a.id === s[0]).email, cc: '', replyTo: '', subject: s[2], snippet: s[3], unread: s[4], starred: s[5], date: at - s[6] * 60000, text: s[7], html: '', labels: ['INBOX', ...(s[4] ? ['UNREAD'] : []), ...(s[5] ? ['STARRED'] : [])], attachments: [], messageId: `<demo_${i}@sender.example>`, references: '' }));
records[0].attachments = [{ name: 'project-brief.txt', type: 'text/plain', size: 84, id: 'demo_attachment', data: btoa('Project brief\n\nReview the homepage. Confirm the headline. Approve the mobile navigation.') }];
records[4].html = '<div style="padding:20px;background-color:#f5f7ee;border-radius:12px"><p style="font-size:11px;color:#87977e">THE WEEKEND NOTE</p><h2>Something good to read.</h2><p>Our latest reading list is ready: a thoughtful essay, a small travel story, and a practical guide to keeping a notebook.</p><p>Make a cup of tea, find a quiet corner, and enjoy.</p><a href="https://example.com">Explore the reading list</a></div>';
const drafts = new Map();
const passwords = new Map([['demo_personal', 'Demo-only-password']]);
const audit = [{ id: 'demo_event', action: 'gmail.connected', accountId: 'demo_studio', at: at - 300000 }];
export async function demoRequest(path, { method = 'GET', body = {} } = {}) {
  const url = new URL(path, 'https://mailroom.example'); const route = url.pathname;
  if (route === '/api/session') return { uid: 'demo', email: 'you@mailroom.example', configured: true };
  if (route === '/api/lock') return { locked: true };
  if (route === '/api/lock/unlock' || route === '/api/lock/setup' || route === '/api/lock/change') {
    if (route.endsWith('unlock') && body.passcode !== 'demo1234') throw Object.assign(new Error('For the demo, use demo1234.'), { code: 'PASSCODE_INVALID' });
    return { token: 'demo', expiresAt: Date.now() + 1800000 };
  }
  if (route === '/api/accounts' && method === 'GET') return { accounts: structuredClone(demoAccounts) };
  if (route === '/api/accounts' && method === 'PUT') {
    let account = demoAccounts.find(a => a.email === body.email);
    if (!account) { account = { id: `demo_${crypto.randomUUID().replaceAll('-', '')}`, email: body.email, connected: false, status: 'saved', createdAt: Date.now() }; demoAccounts.push(account); }
    account.label = body.label;
    if (body.password) passwords.set(account.id, body.password);
    if (body.clearPassword) passwords.delete(account.id);
    account.hasPassword = passwords.has(account.id);
    return { account: structuredClone(account) };
  }
  if (route === '/api/audit') return { events: audit.slice().reverse() };
  if (route === '/api/stats') return { unread: records.filter(m => m.labels.includes('INBOX') && m.unread).length };
  if (route === '/api/messages') {
    const folder = url.searchParams.get('folder') || 'INBOX'; const account = url.searchParams.get('account') || 'all';
    let q = (url.searchParams.get('q') || '').toLowerCase(); const unread = q.includes('is:unread'); q = q.replace('is:unread', '').trim();
    const result = records.filter(m => demoAccounts.some(a => a.id === m.accountId && a.connected) && (account === 'all' || m.accountId === account) && (folder === 'ALL' ? !m.labels.includes('SPAM') && !m.labels.includes('TRASH') : m.labels.includes(folder)) && (!unread || m.unread) && (!q || [m.from, m.to, m.subject, m.text].some(s => s.toLowerCase().includes(q.replace(/^from:/, '')))));
    return { messages: structuredClone(result.sort((a, b) => b.date - a.date)), nextCursor: null, errors: [] };
  }
  const accountMatch = /^\/api\/accounts\/([\w-]+)(?:\/(.*))?$/.exec(route);
  if (!accountMatch) throw new Error('Unknown demo action.');
  const [, aid, rest] = accountMatch;
  const account = demoAccounts.find(a => a.id === aid);
  if (!rest && method === 'DELETE') { demoAccounts.splice(demoAccounts.indexOf(account), 1); for (let i = records.length - 1; i >= 0; i--) if (records[i].accountId === aid) records.splice(i, 1); return { removed: true }; }
  if (rest === 'password') return { password: passwords.get(aid) || '' };
  if (rest === 'disconnect') { account.connected = false; account.status = 'saved'; return { disconnected: true }; }
  if (rest?.startsWith('threads/')) return { id: rest.slice(8), messages: structuredClone(records.filter(m => m.threadId === rest.slice(8))) };
  if (/^messages\/.+\/attachments\//.test(rest || '')) { const [, mid, , fileId] = rest.split('/'); const item = records.find(m => m.id === mid); const file = item?.attachments.find(a => a.id === fileId); if (!file?.data) throw new Error('The sample attachment is not available.'); return { data: file.data, name: file.name, type: file.type }; }
  if (/^messages\/.+\/action$/.test(rest || '')) {
    const item = records.find(m => m.id === rest.split('/')[1]); const action = body.action;
    const add = label => { if (!item.labels.includes(label)) item.labels.push(label); };
    const remove = label => { item.labels = item.labels.filter(l => l !== label); };
    if (action === 'read') remove('UNREAD'); if (action === 'unread') add('UNREAD'); if (action === 'star') add('STARRED'); if (action === 'unstar') remove('STARRED');
    if (action === 'archive') remove('INBOX'); if (action === 'trash') { remove('INBOX'); add('TRASH'); } if (action === 'restore') { remove('TRASH'); add('INBOX'); }
    if (action === 'spam') { remove('INBOX'); add('SPAM'); } if (action === 'notspam') { remove('SPAM'); add('INBOX'); }
    item.unread = item.labels.includes('UNREAD'); item.starred = item.labels.includes('STARRED'); return { updated: true };
  }
  if (rest === 'drafts' && method === 'POST') {
    const did = body.draftId || `demo_draft_${crypto.randomUUID()}`; const mid = drafts.get(did)?.id || `demo_draftmail_${crypto.randomUUID()}`;
    const old = records.findIndex(m => m.id === mid);
    const item = { id: mid, draftId: did, threadId: body.threadId || mid, accountId: aid, accountEmail: account.email, from: account.email, to: body.to || '', cc: body.cc || '', bcc: body.bcc || '', subject: body.subject || '(No subject)', text: body.text || '', html: '', snippet: (body.text || '').slice(0, 100), attachments: (body.attachments || []).map((a, i) => ({ ...a, id: `demo_draftfile_${i}`, size: atob(a.data).length })), date: Date.now(), labels: ['DRAFT'], starred: false, unread: false };
    if (old >= 0) records[old] = item; else records.push(item);
    drafts.set(did, item); return { id: did, messageId: mid };
  }
  if (rest?.startsWith('drafts/') && method === 'GET') return { id: rest.slice(7), message: structuredClone(drafts.get(rest.slice(7))) };
  if (rest === 'send') {
    if (!body.to && !body.cc && !body.bcc) throw new Error('Add at least one recipient.');
    const item = { id: `demo_sent_${crypto.randomUUID()}`, threadId: body.threadId || `demo_thread_${crypto.randomUUID()}`, accountId: aid, accountEmail: account.email, from: account.email, to: body.to, cc: body.cc, subject: body.subject || '(No subject)', text: body.text, html: '', snippet: body.text.slice(0, 100), date: Date.now(), labels: ['SENT'], unread: false, starred: false, attachments: body.attachments || [] };
    if (body.draftId) { const old = drafts.get(body.draftId); const i = records.findIndex(m => m.id === old?.id); if (i >= 0) records.splice(i, 1); drafts.delete(body.draftId); }
    records.push(item); audit.push({ id: crypto.randomUUID(), action: 'mail.sent', accountId: aid, at: Date.now() }); return { sent: true, id: item.id };
  }
  throw new Error('This demo action is not available.');
}
export function connectDemo(aid) {
  const account = demoAccounts.find(a => a.id === aid);
  if (account) { account.connected = true; account.status = 'active'; }
}

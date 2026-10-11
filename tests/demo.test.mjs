import test from 'node:test';
import assert from 'node:assert/strict';
import { demoRequest, demoAccounts } from '../public/demo.js';

test('the sample workspace supports inbox, thread, attachment, draft and sent without network access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('The demo must never use the network.'); };
  try {
    const inbox = await demoRequest('/api/messages?folder=INBOX');
    assert.equal(inbox.messages.length, 8);
    const first = inbox.messages[0];
    const thread = await demoRequest(`/api/accounts/${first.accountId}/threads/${first.threadId}`);
    assert.match(thread.messages[0].text, /updated pages/);
    const attachment = await demoRequest(`/api/accounts/${first.accountId}/messages/${first.id}/attachments/demo_attachment`);
    assert.match(atob(attachment.data), /Project brief/);
    const draft = await demoRequest(`/api/accounts/${first.accountId}/drafts`, { method: 'POST', body: { to: 'recipient@example.com', subject: 'Sample draft', text: 'Draft body' } });
    assert.equal((await demoRequest('/api/messages?folder=DRAFT')).messages.length, 1);
    await demoRequest(`/api/accounts/${first.accountId}/send`, { method: 'POST', body: { to: 'recipient@example.com', subject: 'Sample draft', text: 'Draft body', draftId: draft.id } });
    assert.equal((await demoRequest('/api/messages?folder=SENT')).messages.length, 1);
    assert.equal((await demoRequest('/api/messages?folder=DRAFT')).messages.length, 0);
    await demoRequest(`/api/accounts/${demoAccounts[0].id}/disconnect`, { method: 'POST' });
    assert.equal((await demoRequest('/api/messages?folder=INBOX')).messages.some(m => m.accountId === demoAccounts[0].id), false);
  } finally { globalThis.fetch = originalFetch; }
});

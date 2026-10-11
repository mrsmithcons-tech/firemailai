import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMime, messageBody } from '../functions/lib/mime.mjs';

test('Unicode compose, CC/BCC, reply headers and attachments produce a valid MIME envelope', () => {
  const raw = Buffer.from(buildMime({ to: 'a@example.com', cc: 'b@example.com', bcc: 'c@example.com', subject: 'اسلام علیکم — a new message', text: 'Hello\nدوست', inReplyTo: '<parent@example.com>', references: '<root@example.com> <parent@example.com>', attachments: [{ name: 'ٹیسٹ.txt', type: 'text/plain', data: Buffer.from('attachment content').toString('base64') }] }, 'owner@example.com'), 'base64url').toString('utf8');
  assert.match(raw, /From: owner@example.com/); assert.match(raw, /Bcc: c@example.com/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/); assert.match(raw, /In-Reply-To: <parent@example.com>/);
  assert.match(raw, /Content-Type: multipart\/mixed/); assert.match(raw, /filename\*0\*=UTF-8''/);
  assert.match(raw, new RegExp(Buffer.from('attachment content').toString('base64')));
  assert.ok(raw.split('\r\n').every(line => Buffer.byteLength(line) < 998));
});
test('compose refuses header injection, malformed encodings and oversized attachments', () => {
  const common = { to: 'a@example.com', text: 'Hi' };
  assert.throws(() => buildMime({ ...common, subject: 'Hello\r\nBcc: bad@example.com' }, 'owner@example.com'));
  assert.throws(() => buildMime({ ...common, attachments: [{ name: 'x\r\nContent-Type: text/html', data: '' }] }, 'owner@example.com'));
  assert.throws(() => buildMime({ ...common, attachments: [{ name: 'x.txt', data: '<script>' }] }, 'owner@example.com'));
  assert.throws(() => buildMime({ ...common, attachments: [{ name: 'x.bin', data: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }] }, 'owner@example.com'));
  assert.throws(() => buildMime({ ...common, inReplyTo: '<id>\r\nBcc: bad@example.com' }, 'owner@example.com'));
});
test('an unfinished draft may be saved without recipients', () => {
  assert.doesNotThrow(() => buildMime({ subject: '', text: 'An idea' }, 'owner@example.com', { draft: true }));
  assert.throws(() => buildMime({ text: 'An idea' }, 'owner@example.com'));
});
test('nested Gmail payloads preserve reply headers, draft BCC and attachment references', () => {
  const message = { id: 'm1', threadId: 't1', internalDate: '1700000000000', labelIds: ['UNREAD'], payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Test' }, { name: 'Bcc', value: 'hidden@example.com' }, { name: 'In-Reply-To', value: '<parent@example.com>' }], parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello').toString('base64url') } }, { mimeType: 'text/html', body: { data: Buffer.from('<b>Hello</b>').toString('base64url') } }] }, { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'attachment1', size: 500 } }] } };
  const result = messageBody(message, 'account1', 'owner@example.com');
  assert.equal(result.text.trim(), 'Hello'); assert.equal(result.html.trim(), '<b>Hello</b>');
  assert.equal(result.bcc, 'hidden@example.com'); assert.equal(result.inReplyTo, '<parent@example.com>');
  assert.equal(result.attachments[0].id, 'attachment1'); assert.equal(result.unread, true);
});

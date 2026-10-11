import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, createLock, verifyLock, emailAddress, header, safeId, publicAccount, AppError } from '../functions/lib/security.mjs';
import { safeEmailURL, safeStyleValue } from '../public/email-sanitizer.js';

const key = Buffer.alloc(32, 7).toString('base64');
test('vault ciphertext is randomized and bound to the owner, account and secret type', () => {
  const a = seal('private-value', key, 'owner:account:password');
  const b = seal('private-value', key, 'owner:account:password');
  assert.notDeepEqual(a, b);
  assert.equal(JSON.stringify(a).includes('private-value'), false);
  assert.equal(unseal(a, key, 'owner:account:password'), 'private-value');
  assert.throws(() => unseal(a, key, 'other-owner:account:password'));
  assert.throws(() => unseal(a, key, 'owner:account:refresh'));
  assert.throws(() => unseal({ ...a, tag: Buffer.alloc(16).toString('base64') }, key, 'owner:account:password'));
});
test('the dashboard lock never stores the passcode and rejects a different one', async () => {
  const lock = await createLock('secure-demo-passcode');
  assert.equal(JSON.stringify(lock).includes('secure-demo-passcode'), false);
  assert.equal(await verifyLock('secure-demo-passcode', lock), true);
  assert.equal(await verifyLock('incorrect', lock), false);
  assert.equal(await verifyLock({}, lock), false);
  await assert.rejects(createLock('123'), AppError);
});
test('mail headers and record paths reject injection and path traversal', () => {
  assert.equal(emailAddress(' HELLO@example.com '), 'hello@example.com');
  for (const value of ['a@example.com\r\nBcc: bad@example.com', 'User <a@example.com>', 'a@example.com /']) assert.throws(() => emailAddress(value));
  assert.throws(() => header('Subject\r\nBcc: bad@example.com'));
  for (const value of ['../../other-user', 'account/id', 'account.json', '']) assert.throws(() => safeId(value));
});
test('account listings cannot leak saved passwords or refresh tokens', () => {
  const result = publicAccount('abc', { email: 'hello@example.com', label: 'Private', password: { ciphertext: 'secret-password' }, refreshToken: { ciphertext: 'secret-token' }, status: 'active', createdAt: 123 });
  assert.equal(result.hasPassword, true); assert.equal(result.connected, true);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  assert.equal('password' in result, false); assert.equal('refreshToken' in result, false);
});
test('email rendering rejects script, file, relative, SVG and covert CSS network URLs', () => {
  for (const url of ['javascript:alert(1)', 'java\nscript:alert(1)', '//example.com', '/api/accounts', 'file:///etc/passwd', 'data:text/html;base64,AA==', 'data:image/svg+xml;base64,AA==', 'https://user:pass@example.com']) assert.equal(safeEmailURL(url, { image: true, allowRemote: true }), null);
  assert.equal(safeEmailURL('https://example.com/pixel.png', { image: true }), null);
  assert.equal(safeEmailURL('https://example.com/pixel.png', { image: true, allowRemote: true }), 'https://example.com/pixel.png');
  assert.equal(safeEmailURL('mailto:a@example.com'), 'mailto:a@example.com');
  assert.equal(safeEmailURL('data:image/png;base64,AA==', { image: true }), 'data:image/png;base64,AA==');
  assert.equal(safeStyleValue('background-color', '#f8f9f3'), true);
  assert.equal(safeStyleValue('background', 'url(https://tracker.example)'), false);
  assert.equal(safeStyleValue('color', 'expression(alert(1))'), false);
  assert.equal(safeStyleValue('font-family', '\\75rl(https://tracker.example)'), false);
});

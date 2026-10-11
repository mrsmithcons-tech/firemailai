import { randomBytes, createHash, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const SESSION_MS = 30 * 60 * 1000;
export const MAX_ATTACHMENTS = 6 * 1024 * 1024;
export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function ensure(value, status, code, message) {
  if (!value) throw new AppError(status, code, message);
}
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const accountId = email => digest(email.toLowerCase()).slice(0, 32);
export function keyBytes(encoded) {
  const key = Buffer.from(encoded || '', 'base64');
  ensure(key.length === 32, 500, 'KEY_CONFIGURATION', 'The server encryption key is not configured correctly.');
  return key;
}
export function seal(value, encodedKey, context) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(encodedKey), nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function unseal(record, encodedKey, context) {
  ensure(record?.v === 1, 500, 'VAULT_FORMAT', 'The saved secret format is unsupported.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(encodedKey), Buffer.from(record.nonce, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
export function passcode(value) {
  ensure(typeof value === 'string' && value.length >= 8 && value.length <= 128, 400, 'PASSCODE_LENGTH', 'Use a dashboard passcode of 8 to 128 characters.');
  return value;
}
export async function createLock(value, now = Date.now()) {
  passcode(value);
  const salt = randomToken(16);
  const hash = await derive(value, salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt, hash: hash.toString('base64'), algorithm: 'scrypt-N16384-r8-p1', version: randomToken(12), updatedAt: now };
}
export async function verifyLock(value, lock) {
  if (typeof value !== 'string' || value.length > 128 || !lock?.salt || !lock?.hash) return false;
  const actual = await derive(value, lock.salt, 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(lock.hash, 'base64');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function emailAddress(value) {
  ensure(typeof value === 'string', 400, 'EMAIL_INVALID', 'Enter a valid email address.');
  const clean = value.trim().toLowerCase();
  ensure(clean.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(clean), 400, 'EMAIL_INVALID', 'Use email addresses without display names.');
  return clean;
}
export function recipients(value, required = false) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,;\n]/);
  const addresses = [...new Set(parts.map(v => String(v).trim()).filter(Boolean).map(emailAddress))];
  ensure(!required || addresses.length, 400, 'RECIPIENT_REQUIRED', 'Add at least one recipient.');
  ensure(addresses.length <= 20, 400, 'RECIPIENT_LIMIT', 'Use at most 20 recipients per field.');
  return addresses;
}
export function header(value, max = 300) {
  ensure(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 400, 'HEADER_INVALID', 'A mail header contains invalid characters.');
  return value;
}
export function safeId(value, max = 200) {
  ensure(typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9_-]+$/.test(value), 400, 'ID_INVALID', 'Invalid record identifier.');
  return value;
}
export function messageIdHeader(value) {
  if (!value) return '';
  ensure(typeof value === 'string' && value.length <= 998 && /^<[^<>\s\x00-\x1f\x7f]+>$/.test(value), 400, 'MESSAGE_ID_INVALID', 'Invalid reply message identifier.');
  return value;
}
export function publicAccount(id, record) {
  return { id, email: record.email, label: record.label || '', connected: Boolean(record.refreshToken), status: record.status || 'saved', hasPassword: Boolean(record.password), connectedAt: record.connectedAt || null, createdAt: record.createdAt };
}
export async function limitedMap(items, limit, fn) {
  const output = new Array(items.length); let offset = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (offset < items.length) { const i = offset++; output[i] = await fn(items[i], i); }
  }));
  return output;
}

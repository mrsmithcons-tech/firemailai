import { randomToken, ensure, header, emailAddress, recipients, messageIdHeader, MAX_ATTACHMENTS } from './security.mjs';

const wrap = value => value.match(/.{1,76}/g)?.join('\r\n') || '';
function encodedHeader(value) {
  // RFC 2047 encoded words remain below 75 characters, including for long Urdu subjects.
  const chunks = []; let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
}
export function buildMime(input, from, { draft = false } = {}) {
  const to = recipients(input.to), cc = recipients(input.cc), bcc = recipients(input.bcc);
  ensure((draft || to.length + cc.length + bcc.length > 0) && to.length + cc.length + bcc.length <= 30, 400, 'RECIPIENT_LIMIT', 'Use between 1 and 30 recipients in total.');
  const subject = header(String(input.subject || ''));
  const text = String(input.text || '');
  ensure(text.length <= 200000, 400, 'BODY_TOO_LARGE', 'The message body is too long.');
  const attachments = input.attachments || [];
  ensure(Array.isArray(attachments) && attachments.length <= 10, 400, 'ATTACHMENT_LIMIT', 'Use at most 10 attachments.');
  let total = 0;
  const files = attachments.map(file => {
    const name = header(String(file.name || 'attachment'), 180);
    const data = String(file.data || '');
    ensure(data.length <= Math.ceil(MAX_ATTACHMENTS / 3) * 4 + 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data), 400, 'ATTACHMENT_INVALID', 'Invalid attachment encoding.');
    total += Buffer.from(data, 'base64').length;
    ensure(total <= MAX_ATTACHMENTS, 413, 'ATTACHMENT_TOO_LARGE', 'Attachments must total 6 MB or less.');
    const type = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.type || '') ? file.type : 'application/octet-stream';
    return { name, data, type };
  });
  const boundary = `mailroom_${randomToken(18)}`;
  const headers = [`From: ${emailAddress(from)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomToken(24)}@mailroom.local>`, 'MIME-Version: 1.0'];
  if (to.length) headers.push(`To: ${to.join(',\r\n ')}`);
  if (cc.length) headers.push(`Cc: ${cc.join(',\r\n ')}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(',\r\n ')}`);
  headers.push(`Subject: ${subject ? encodedHeader(subject) : ''}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${messageIdHeader(input.inReplyTo)}`);
  if (input.references) {
    const ids = String(input.references).split(/\s+/).filter(Boolean).slice(-20).map(messageIdHeader);
    headers.push(`References: ${ids.join('\r\n ')}`);
  }
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(text, 'utf8').toString('base64'))].join('\r\n');
  let body;
  if (!files.length) { headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'); body = wrap(Buffer.from(text, 'utf8').toString('base64')); }
  else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [textPart, ...files.map(file => {
      const unicode = encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      const segments = unicode.match(/.{1,60}/g) || ['attachment'];
      const disposition = segments.map((s, i) => ` filename*${i}*=${i === 0 ? "UTF-8''" : ''}${s}${i < segments.length - 1 ? ';' : ''}`);
      // Avoid duplicate filename parameters: clients may select the ASCII fallback
      // ahead of the RFC 2231 value and silently lose the original Unicode name.
      return [`Content-Type: ${file.type}`, 'Content-Disposition: attachment;', ...disposition, 'Content-Transfer-Encoding: base64', '', wrap(file.data)].join('\r\n');
    })];
    body = parts.map(p => `--${boundary}\r\n${p}`).join('\r\n') + `\r\n--${boundary}--`;
  }
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n', 'utf8').toString('base64url');
}
export function messageSummary(message, aid, email) {
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  return { id: message.id, threadId: message.threadId, accountId: aid, accountEmail: email, from: headers.from || '', to: headers.to || '', subject: headers.subject || '(No subject)', snippet: message.snippet || '', date: Number(message.internalDate) || Date.parse(headers.date) || 0, labels: message.labelIds || [], unread: (message.labelIds || []).includes('UNREAD'), starred: (message.labelIds || []).includes('STARRED') };
}
export function messageBody(message, aid, email) {
  const result = { ...messageSummary(message, aid, email), text: '', html: '', attachments: [] };
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  Object.assign(result, { cc: headers.cc || '', bcc: headers.bcc || '', replyTo: headers['reply-to'] || '', messageId: headers['message-id'] || '', inReplyTo: headers['in-reply-to'] || '', references: headers.references || '' });
  function walk(part) {
    const partHeaders = Object.fromEntries((part.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const body = part.body || {};
    if (part.filename || body.attachmentId && !['text/plain', 'text/html'].includes(part.mimeType)) {
      result.attachments.push({ name: part.filename || 'inline-image', type: part.mimeType, size: body.size || 0, id: body.attachmentId || null, partId: part.partId || '', contentId: partHeaders['content-id'] || '', inlineData: body.data && body.size <= 262144 ? body.data : null });
    } else if (['text/plain', 'text/html'].includes(part.mimeType)) {
      if (body.data) {
        const bytes = Buffer.from(body.data, 'base64url');
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(partHeaders['content-type'] || '')?.[1] || 'utf-8';
        let decoded;
        try { decoded = new TextDecoder(charset).decode(bytes); } catch { decoded = bytes.toString('utf8'); }
        result[part.mimeType === 'text/html' ? 'html' : 'text'] += decoded + '\n';
      } else if (body.attachmentId) {
        result.attachments.push({ name: part.mimeType === 'text/html' ? 'message.html' : 'message.txt', type: part.mimeType, size: body.size || 0, id: body.attachmentId, partId: part.partId || '', bodyPart: true });
      }
    }
    for (const child of part.parts || []) walk(child);
  }
  walk(message.payload || {});
  return result;
}

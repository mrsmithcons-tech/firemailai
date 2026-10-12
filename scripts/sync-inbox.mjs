import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const DB_URL = 'https://firemailai-default-rtdb.firebaseio.com';

function rtdbUrl(path) {
  const clean = path.replace(/^\/+/, '');
  return `${DB_URL}/${clean}.json`;
}

async function rtdbRequest(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== null && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(rtdbUrl(path), options);
  if (!res.ok) throw new Error(`RTDB Error: ${res.statusText} (${res.status})`);
  return res.json();
}

function cleanMsgId(rawId) {
  return String(rawId || '')
    .replace(/[<>#$[\]/.]/g, '_')
    .slice(0, 80);
}

async function syncOAuthAccount(account) {
  const email = account.email;
  console.log(`\n⏳ Connecting to Gmail REST API (OAuth) for ${email}...`);

  let accessToken = account.accessToken;
  if (account.tokenExpiresAt && account.tokenExpiresAt < Date.now() + 60000 && account.refreshToken) {
    try {
      const config = await rtdbRequest('mailroom/config/oauth') || {};
      const clientId = config.clientId || process.env.GOOGLE_CLIENT_ID || '';
      const clientSecret = config.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';

      const refreshParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token'
      });

      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshParams
      });

      if (refreshRes.ok) {
        const refreshed = await refreshRes.json();
        accessToken = refreshed.access_token;
        account.accessToken = accessToken;
        account.tokenExpiresAt = Date.now() + (Number(refreshed.expires_in) || 3600) * 1000;
        await rtdbRequest(`mailroom/accounts/${account.id}`, 'PATCH', {
          accessToken,
          tokenExpiresAt: account.tokenExpiresAt
        });
        console.log(` Refreshed OAuth token for ${email}`);
      }
    } catch (err) {
      console.warn(`Could not refresh OAuth token for ${email}:`, err.message);
    }
  }

  if (!accessToken) {
    console.log(`[SKIP] Account ${email} has no valid OAuth access token.`);
    return 0;
  }

  let syncedCount = 0;
  try {
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=in:inbox', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!listRes.ok) {
      const errData = await listRes.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${listRes.status}`);
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];
    console.log(`📬 Found ${messages.length} messages via Gmail REST API.`);

    for (const item of messages) {
      try {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!msgRes.ok) continue;
        const msgData = await msgRes.json();

        const headers = msgData.payload?.headers || [];
        const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const msgId = cleanMsgId(msgData.id);
        const subject = getHeader('Subject') || '(No subject)';
        const from = getHeader('From') || 'Unknown';
        const to = getHeader('To') || email;
        const cc = getHeader('Cc') || '';
        const bcc = getHeader('Bcc') || '';
        const dateHeader = getHeader('Date');
        const timestamp = dateHeader ? new Date(dateHeader).getTime() : (Number(msgData.internalDate) || Date.now());

        const labelIds = msgData.labelIds || [];
        const isUnread = labelIds.includes('UNREAD');
        const isStarred = labelIds.includes('STARRED');

        let bodyHtml = '';
        let bodyText = '';
        const attachments = [];

        function extractParts(part) {
          if (!part) return;
          const mimeType = part.mimeType || '';
          if (mimeType === 'text/plain' && part.body?.data) {
            bodyText = Buffer.from(part.body.data, 'base64url').toString('utf8');
          } else if (mimeType === 'text/html' && part.body?.data) {
            bodyHtml = Buffer.from(part.body.data, 'base64url').toString('utf8');
          } else if (part.filename && part.body) {
            attachments.push({
              name: part.filename,
              type: mimeType || 'application/octet-stream',
              size: part.body.size || 0,
              data: part.body.data || ''
            });
          }
          if (part.parts) {
            for (const child of part.parts) extractParts(child);
          }
        }

        extractParts(msgData.payload);

        const summaryPayload = {
          id: msgId,
          threadId: msgData.threadId || msgId,
          accountId: account.id,
          accountEmail: email,
          from,
          to,
          cc,
          bcc,
          subject,
          snippet: (msgData.snippet || bodyText || '').slice(0, 160),
          date: timestamp,
          unread: isUnread,
          starred: isStarred,
          folder: 'INBOX',
          labels: isStarred ? ['INBOX', 'STARRED'] : ['INBOX'],
          hasAttachments: attachments.length > 0,
          attachmentsCount: attachments.length
        };

        const bodyPayload = {
          id: msgId,
          text: bodyText || msgData.snippet || '',
          html: bodyHtml || (bodyText ? `<div style="font-family:sans-serif;line-height:1.6"><p>${bodyText.replace(/\n/g, '<br>')}</p></div>` : ''),
          attachments: attachments.slice(0, 5)
        };

        await rtdbRequest(`mailroom/messages/${msgId}`, 'PUT', summaryPayload);
        await rtdbRequest(`mailroom/bodies/${msgId}`, 'PUT', bodyPayload);
        syncedCount++;
      } catch (err) {
        console.warn(`  ⚠️ Could not parse message ${item.id}:`, err.message);
      }
    }

    console.log(` Successfully synchronized ${syncedCount} OAuth messages for ${email}.`);

    const auditId = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await rtdbRequest(`mailroom/audit/${auditId}`, 'PUT', {
      id: auditId,
      action: 'sync.completed',
      accountId: account.id,
      at: Date.now()
    });

  } catch (err) {
    console.error(`❌ Gmail REST API Error for ${email}:`, err.message);
  }

  return syncedCount;
}

export async function syncAccount(account) {
  if (account.authType === 'oauth' || (account.accessToken && !account.appPassword)) {
    return syncOAuthAccount(account);
  }

  const email = account.email;
  const rawPass = account.appPassword || account.password || '';
  const password = rawPass.replace(/\s+/g, ''); // strip spaces from Google App Password (e.g. abcd efgh -> abcdefgh)

  if (!password) {
    console.log(`[SKIP] Account ${email} has no saved App Password.`);
    return 0;
  }

  console.log(`\n⏳ Connecting to Gmail IMAP for ${email}...`);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      pass: password
    },
    logger: false
  });

  let syncedCount = 0;

  try {
    await client.connect();
    console.log(` Connected to Gmail for ${email}`);

    // Sync INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      const total = mailbox.exists || 0;
      console.log(`📬 INBOX has ${total} total messages.`);

      if (total > 0) {
        // Fetch latest up to 25 messages
        const fetchRange = `${Math.max(1, total - 24)}:*`;
        console.log(`📥 Fetching messages in range ${fetchRange}...`);

        for await (const message of client.fetch(fetchRange, {
          envelope: true,
          flags: true,
          source: true,
          uid: true
        })) {
          try {
            const parsed = await simpleParser(message.source);
            const msgId = cleanMsgId(parsed.messageId || `msg_${message.uid}_${message.envelope?.date?.getTime() || Date.now()}`);
            const isUnread = !message.flags.has('\\Seen');
            const isStarred = message.flags.has('\\Flagged');

            const attachments = (parsed.attachments || []).slice(0, 5).map(att => ({
              name: att.filename || 'attachment',
              type: att.contentType || 'application/octet-stream',
              size: att.size || att.content?.length || 0,
              data: att.content ? att.content.toString('base64') : ''
            }));

            // 1. Lightweight summary for instant inbox loading
            const summaryPayload = {
              id: msgId,
              threadId: msgId,
              accountId: account.id,
              accountEmail: email,
              from: parsed.from?.text || parsed.from?.value?.[0]?.address || 'Unknown',
              to: parsed.to?.text || email,
              cc: parsed.cc?.text || '',
              bcc: parsed.bcc?.text || '',
              subject: parsed.subject || '(No subject)',
              snippet: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Message',
              date: parsed.date ? parsed.date.getTime() : Date.now(),
              unread: isUnread,
              starred: isStarred,
              folder: 'INBOX',
              labels: isStarred ? ['INBOX', 'STARRED'] : ['INBOX'],
              hasAttachments: attachments.length > 0,
              attachmentsCount: attachments.length
            };

            // 2. Heavy body & attachments stored separately for on-demand reading
            const bodyPayload = {
              id: msgId,
              text: parsed.text || '',
              html: parsed.html || (parsed.text ? `<div style="font-family:sans-serif;line-height:1.6"><p>${parsed.text.replace(/\n/g, '<br>')}</p></div>` : ''),
              attachments
            };

            await rtdbRequest(`mailroom/messages/${msgId}`, 'PUT', summaryPayload);
            await rtdbRequest(`mailroom/bodies/${msgId}`, 'PUT', bodyPayload);
            syncedCount++;
          } catch (err) {
            console.warn(`  ⚠️ Could not parse message UID ${message.uid}:`, err.message);
          }
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    console.log(` Successfully synchronized ${syncedCount} messages for ${email}.`);

    // Log audit event
    const auditId = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await rtdbRequest(`mailroom/audit/${auditId}`, 'PUT', {
      id: auditId,
      action: 'sync.completed',
      accountId: account.id,
      at: Date.now()
    });

  } catch (err) {
    if (err.authenticationFailed) {
      console.error(`❌ Authentication failed for ${email}!`);
      console.error(`👉 Make sure you are using a 16-character Google App Password (not your normal Google account password).`);
      console.error(`👉 Generate one at: https://myaccount.google.com/apppasswords`);
    } else {
      console.error(`❌ IMAP Sync Error for ${email}:`, err.message);
    }
  }

  return syncedCount;
}

export async function syncAll() {
  console.log(`\n========================================`);
  console.log(`🔄 Firemail AI IMAP Sync Starting: ${new Date().toLocaleTimeString()}`);
  console.log(`========================================`);

  const accountsData = await rtdbRequest('mailroom/accounts');
  if (!accountsData || Object.keys(accountsData).length === 0) {
    console.log('No accounts found in RTDB to sync.');
    return;
  }

  const accounts = Object.values(accountsData);
  let totalSynced = 0;

  for (const account of accounts) {
    const count = await syncAccount(account);
    totalSynced += count;
  }

  console.log(`\n Total messages updated in RTDB: ${totalSynced}`);
  console.log(`========================================\n`);
}

async function main() {
  const isWatch = process.argv.includes('--watch');

  let lastSyncTime = Date.now();
  await syncAll();

  if (isWatch) {
    console.log(`👀 Running in continuous watch mode (syncing every 60s or on dashboard Refresh click)...`);
    
    // Check every 5 seconds for on-demand trigger from web dashboard
    setInterval(async () => {
      try {
        const trigger = await rtdbRequest('mailroom/syncTrigger');
        if (trigger?.requestedAt && trigger.requestedAt > lastSyncTime) {
          lastSyncTime = Date.now();
          console.log(`⚡ On-demand sync triggered from dashboard!`);
          await syncAll();
        }
      } catch {}
    }, 5000);

    // Regular interval sync every 30 seconds (half minute)
    setInterval(async () => {
      try {
        lastSyncTime = Date.now();
        await syncAll();
      } catch (err) {
        console.error('Watch loop error:', err.message);
      }
    }, 30000);

    // Lightweight HTTP server for Render / cloud health checks
    const port = process.env.PORT || 10000;
    const http = await import('http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'firemail-sync', interval: '30s', time: new Date().toISOString() }));
    }).listen(port, () => {
      console.log(`🌐 Health check server listening on port ${port}`);
    });
  }
}

if (process.argv[1].endsWith('sync-inbox.mjs')) {
  main().catch(console.error);
}

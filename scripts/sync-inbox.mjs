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

export async function syncAccount(account) {
  const email = account.email;
  const rawPass = account.password || '';
  const password = rawPass.replace(/\s+/g, ''); // strip spaces from Google App Password (e.g. abcd efgh -> abcdefgh)

  if (!password) {
    console.log(`[SKIP] Account ${email} has no saved password or App Password.`);
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

            const payload = {
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
              text: parsed.text || '',
              html: parsed.html || (parsed.text ? `<div style="font-family:sans-serif;line-height:1.6"><p>${parsed.text.replace(/\n/g, '<br>')}</p></div>` : ''),
              date: parsed.date ? parsed.date.getTime() : Date.now(),
              unread: isUnread,
              starred: isStarred,
              folder: 'INBOX',
              labels: isStarred ? ['INBOX', 'STARRED'] : ['INBOX'],
              attachments
            };

            await rtdbRequest(`mailroom/messages/${msgId}`, 'PUT', payload);
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

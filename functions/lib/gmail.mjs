import { AppError, ensure, unseal, safeId } from './security.mjs';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function createGmail({ db, config, fetcher = fetch, now = Date.now }) {
  const cache = new Map();
  async function jsonFetch(url, options) {
    let response;
    try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw new AppError(502, 'GOOGLE_NETWORK', 'Google did not respond. Try again shortly.'); }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    return { response, data };
  }
  async function token(uid, aid, record, force = false) {
    ensure(record.refreshToken, 409, 'NOT_CONNECTED', 'Connect this account to Gmail first.');
    const cacheId = `${uid}:${aid}:${record.connectedAt}`;
    const old = cache.get(cacheId);
    if (!force && old?.expiresAt > now() + 60000) return old.token;
    if (!force && old?.pending) return old.pending;
    const pending = (async () => {
      const refresh = unseal(record.refreshToken, config.vaultKey, `${uid}:${aid}:refresh`);
      const { response, data } = await jsonFetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
      });
      if (!response.ok) {
        if (data.error === 'invalid_grant') {
          await db.ref(`private/users/${uid}/accounts/${aid}/status`).set('reconnect');
          throw new AppError(409, 'RECONNECT_REQUIRED', 'Google access has expired or was revoked. Reconnect this account.');
        }
        throw new AppError(502, 'GOOGLE_TOKEN', 'Google could not renew access. Check the OAuth configuration or try again.');
      }
      ensure(data.access_token, 502, 'GOOGLE_TOKEN', 'Google returned no access token.');
      if (cache.size > 200) cache.clear();
      cache.set(cacheId, { token: data.access_token, expiresAt: now() + Number(data.expires_in || 3600) * 1000 });
      return data.access_token;
    })();
    cache.set(cacheId, { pending });
    try { return await pending; } catch (err) { cache.delete(cacheId); throw err; }
  }
  return {
    async call(uid, aid, record, path, { method = 'GET', body, query } = {}) {
      const url = new URL(BASE + path);
      for (const [k, value] of Object.entries(query || {})) {
        if (Array.isArray(value)) for (const item of value) url.searchParams.append(k, item);
        else if (value !== undefined && value !== null && value !== '') url.searchParams.set(k, String(value));
      }
      let accessToken = await token(uid, aid, record);
      let result = await jsonFetch(url, { method, headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      // Only retry reads; do not silently retry a compose/send after an uncertain delivery.
      if (result.response.status === 401 && method === 'GET') {
        accessToken = await token(uid, aid, record, true);
        result = await jsonFetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` } });
      }
      if (!result.response.ok) {
        const status = result.response.status;
        if (status === 401) throw new AppError(409, 'RECONNECT_REQUIRED', 'Google access is no longer valid. Reconnect this account.');
        if (status === 404) throw new AppError(404, 'MAIL_NOT_FOUND', 'The mail item no longer exists. Refresh the folder.');
        if (status === 429 || (result.data.error?.errors || []).some(e => /[rR]ateLimit|quotaExceeded/.test(e.reason))) throw new AppError(429, 'GOOGLE_RATE_LIMIT', 'Gmail is busy. Wait a moment, then refresh.');
        if (status === 403) throw new AppError(403, 'GMAIL_PERMISSION', 'Gmail access was denied. Enable the Gmail API and grant mail permission.');
        if (status === 400) throw new AppError(400, 'GMAIL_REQUEST', 'Gmail rejected the request. Check the recipients, search, or draft.');
        throw new AppError(502, 'GOOGLE_API', 'Gmail could not complete this request.');
      }
      return result.data;
    },
    async exchange(code) {
      const { response, data } = await jsonFetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${config.origin}/api/oauth/callback`, grant_type: 'authorization_code' })
      });
      ensure(response.ok && data.access_token, 400, 'OAUTH_EXCHANGE', 'Google authorization could not be completed. Start again.');
      const scopes = String(data.scope || '').split(/\s+/);
      ensure(scopes.includes(GMAIL_SCOPE), 403, 'OAUTH_SCOPE', 'Grant the requested Gmail permission to connect an inbox.');
      const profile = await jsonFetch(BASE + '/profile', { headers: { Authorization: `Bearer ${data.access_token}` } });
      ensure(profile.response.ok && profile.data.emailAddress, 400, 'OAUTH_PROFILE', 'Could not identify the authorized Gmail account.');
      return { ...data, email: profile.data.emailAddress };
    }
  };
}

/**
 * Shared Clio token management — NOT a function endpoint.
 *
 * Stores { access_token, refresh_token, expires_at } in Netlify Blobs.
 * getClioToken() always returns a valid access token, refreshing automatically
 * when it's within 10 minutes of expiry. Clio issues a new refresh token on
 * every refresh (rolling tokens), so we always store the latest pair.
 *
 * Setup: one-time OAuth flow through the SAR Agent app. After that, permanent.
 */

const https = require('https');
const { store: getStore } = require('./_blobs');

const BLOB_KEY    = 'tokens';
const CLIENT_ID   = 'aXxkdw7wIv9G52ok0tms9qctBeSNatloEmH5zlaJ';
const CLIENT_SECRET = 'GR3EawXKI747wymzVbNDyHU3JIUORJY2Z47XgtCW';
const BUFFER_MS   = 10 * 60 * 1000; // refresh 10 min before expiry

async function getClioToken() {
  let stored = null;
  try {
    const store = getStore('clio-auth');
    stored = await store.get(BLOB_KEY, { type: 'json' });
  } catch (e) {
    // Blobs unavailable — fall back to env var (bootstrapping)
    return process.env.CLIO_TOKEN || null;
  }

  if (!stored) return process.env.CLIO_TOKEN || null;

  const needsRefresh = !stored.expires_at || Date.now() >= stored.expires_at - BUFFER_MS;

  if (!needsRefresh) return stored.access_token;

  if (!stored.refresh_token) {
    console.warn('Clio token expired and no refresh token stored. Re-auth required.');
    return stored.access_token || process.env.CLIO_TOKEN || null;
  }

  try {
    const fresh = await callRefresh(stored.refresh_token);
    await storeClioTokens(fresh.access_token, fresh.refresh_token, fresh.expires_in);
    console.log('Clio token auto-refreshed successfully.');
    return fresh.access_token;
  } catch (e) {
    console.error('Clio token refresh failed:', e.message);
    // Return the stale token — better than nothing for the current request
    return stored.access_token || process.env.CLIO_TOKEN || null;
  }
}

async function storeClioTokens(access_token, refresh_token, expires_in) {
  const store = getStore('clio-auth');
  await store.set(BLOB_KEY, JSON.stringify({
    access_token,
    refresh_token,
    expires_at: Date.now() + ((expires_in || 86400) * 1000),
    stored_at:  new Date().toISOString(),
  }));
}

function callRefresh(refresh_token) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'app.clio.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(params)) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed);
          else reject(new Error(parsed.error_description || parsed.error || 'Unknown error'));
        } catch (e) { reject(new Error('Clio response parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(params);
    req.end();
  });
}

module.exports = { getClioToken, storeClioTokens };

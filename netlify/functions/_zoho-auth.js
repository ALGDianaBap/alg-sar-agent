/**
 * Zoho OAuth token management — NOT a function endpoint.
 *
 * Same pattern as _clio-auth.js. Stores { access_token, refresh_token,
 * expires_at } in Netlify Blobs ('zoho-auth' store). Zoho access tokens
 * expire after 1 hour; refresh tokens are permanent when used regularly.
 *
 * One-time setup: admin clicks "Connect Zoho" in the app, authorizes,
 * tokens stored. Every webhook call thereafter uses getZohoToken() which
 * auto-refreshes silently.
 */

const https = require('https');
const { store: getStore } = require('./_blobs');

const BLOB_KEY   = 'tokens';
const TOKEN_URL  = 'https://accounts.zoho.com/oauth/v2/token';
const BUFFER_MS  = 5 * 60 * 1000; // refresh 5 min before expiry

async function getZohoToken() {
  let stored = null;
  try {
    stored = await getStore('zoho-auth').get(BLOB_KEY, { type: 'json' });
  } catch (e) {
    return process.env.ZOHO_ACCESS_TOKEN || null;
  }

  if (!stored) return process.env.ZOHO_ACCESS_TOKEN || null;

  const needsRefresh = !stored.expires_at || Date.now() >= stored.expires_at - BUFFER_MS;
  if (!needsRefresh) return stored.access_token;

  if (!stored.refresh_token) {
    console.warn('Zoho token expired, no refresh token — re-auth required.');
    return stored.access_token || null;
  }

  try {
    const fresh = await callRefresh(stored.refresh_token);
    await storeZohoTokens(fresh.access_token, stored.refresh_token, fresh.expires_in);
    return fresh.access_token;
  } catch (e) {
    console.error('Zoho token refresh failed:', e.message);
    return stored.access_token || null;
  }
}

async function storeZohoTokens(access_token, refresh_token, expires_in) {
  await getStore('zoho-auth').set(BLOB_KEY, JSON.stringify({
    access_token,
    refresh_token,
    expires_at: Date.now() + ((expires_in || 3600) * 1000),
    stored_at:  new Date().toISOString(),
  }));
}

function callRefresh(refresh_token) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'accounts.zoho.com',
      path:     '/oauth/v2/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(params)) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.access_token) resolve(p);
          else reject(new Error(p.error || JSON.stringify(p)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(params);
    req.end();
  });
}

module.exports = { getZohoToken, storeZohoTokens };

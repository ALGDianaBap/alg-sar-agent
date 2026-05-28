/**
 * Zoho OAuth setup — one-time admin flow.
 *
 * GET  ?action=url  → returns the Zoho authorization URL for the admin to visit
 * POST { code }     → exchanges code for tokens, stores in Blobs, returns { ok }
 * GET  ?action=status → returns whether Zoho tokens are stored
 */

const https = require('https');
const { storeZohoTokens, getZohoToken } = require('./_zoho-auth');

const REDIRECT_URI = 'https://alg-sar-agent.netlify.app/zoho-callback';
// Scope: read form entries and download files
const SCOPE = 'ZohoForms.forms.ALL';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const action = (event.queryStringParameters || {}).action;

  // ── GET ?action=url — return OAuth authorization URL ──────────────────────
  if (event.httpMethod === 'GET' && action === 'url') {
    const clientId = process.env.ZOHO_CLIENT_ID;
    if (!clientId) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ZOHO_CLIENT_ID not set' }) };

    const url = 'https://accounts.zoho.com/oauth/v2/auth?' + new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      scope:         SCOPE,
      redirect_uri:  REDIRECT_URI,
      access_type:   'offline',
      prompt:        'consent',
    }).toString();

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) };
  }

  // ── GET ?action=status — check if tokens are stored ───────────────────────
  if (event.httpMethod === 'GET' && action === 'status') {
    try {
      const token = await getZohoToken();
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ connected: !!token }) };
    } catch (e) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ connected: false }) };
    }
  }

  // ── POST { code } — exchange code for tokens ──────────────────────────────
  if (event.httpMethod === 'POST') {
    let code;
    try { code = JSON.parse(event.body).code; }
    catch (e) { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }
    if (!code) return { statusCode: 400, headers: cors, body: 'Missing code' };

    const clientId     = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    if (!clientId || !clientSecret) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Zoho env vars not set' }) };

    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
    }).toString();

    return new Promise((resolve) => {
      const options = {
        hostname: 'accounts.zoho.com',
        path:     '/oauth/v2/token',
        method:   'POST',
        headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(params)) },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', async () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) {
              await storeZohoTokens(parsed.access_token, parsed.refresh_token, parsed.expires_in);
              resolve({ statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) });
            } else {
              resolve({ statusCode: 400, headers: cors, body: JSON.stringify({ error: parsed.error || 'Token exchange failed', detail: data }) });
            }
          } catch (e) {
            resolve({ statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) });
          }
        });
      });
      req.on('error', (e) => resolve({ statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) }));
      req.write(params);
      req.end();
    });
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};

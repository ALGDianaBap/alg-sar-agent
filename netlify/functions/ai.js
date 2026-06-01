const https = require('https');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  const body = event.body || '{}';

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body))
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) });
    });

    req.write(body);
    req.end();
  });
};

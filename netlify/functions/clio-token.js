const https = require('https');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  let code;
  try { code = JSON.parse(event.body).code; }
  catch (e) { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }

  if (!code) return { statusCode: 400, headers: cors, body: 'Missing code' };

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: 'aXxkdw7wIv9G52ok0tms9qctBeSNatloEmH5zlaJ',
    client_secret: 'GR3EawXKI747wymzVbNDyHU3JIUORJY2Z47XgtCW',
    redirect_uri: 'https://alg-sar-agent.netlify.app/callback'
  }).toString();

  return new Promise((resolve) => {
    const options = {
      hostname: 'app.clio.com',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
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

    req.write(params);
    req.end();
  });
};

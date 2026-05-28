const https = require('https');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Clio-Method',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth) return { statusCode: 401, headers: cors, body: 'Unauthorized' };

  const qs = event.queryStringParameters || {};
  const path = qs.path;
  if (!path) return { statusCode: 400, headers: cors, body: 'Missing path parameter' };

  // Build Clio path — append .json unless it's a download or already has an extension
  const isDownload = path.includes('/download') || path.includes('/put_url');
  const apiPath = isDownload ? path : path + '.json';

  // Forward all query params except 'path'
  const fwd = Object.entries(qs)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const clioPath = `/api/v4/${apiPath}${fwd ? '?' + fwd : ''}`;

  const isPost = event.httpMethod === 'POST' ||
    (event.headers['x-clio-method'] || '').toUpperCase() === 'POST';

  const reqHeaders = {
    'Authorization': auth,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (isPost && event.body) {
    reqHeaders['Content-Length'] = String(Buffer.byteLength(event.body));
  }

  const options = {
    hostname: 'app.clio.com',
    path: clioPath,
    method: isPost ? 'POST' : 'GET',
    headers: reqHeaders
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        const isBinary = isDownload || ct.includes('octet-stream') || ct.includes('application/pdf');

        if (isBinary) {
          resolve({
            statusCode: res.statusCode,
            headers: { ...cors, 'Content-Type': ct || 'application/octet-stream' },
            body: buf.toString('base64'),
            isBase64Encoded: true
          });
        } else {
          resolve({
            statusCode: res.statusCode,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: buf.toString('utf8')
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) });
    });

    if (isPost && event.body) req.write(event.body);
    req.end();
  });
};

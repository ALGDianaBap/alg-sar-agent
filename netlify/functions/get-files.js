// Returns metadata for files stored during native form submission.
// GET /.netlify/functions/get-files?id={sarId}
//
// Deliberately does NOT include the base64 `data` — a large scanned RISC
// (routinely 5-8MB) would blow past Netlify's ~6MB function response limit
// the same way it blows past the request limit on the way in. Extraction
// reads the bytes directly server-side via extract-risc.js instead, so the
// client never needs the raw bytes at all.

const { store: getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const id = (event.queryStringParameters || {}).id;
  if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id' }) };

  try {
    const files = await getStore('form-files').get(id, { type: 'json' });
    if (!files) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Not found' }) };
    const meta = files.map(f => ({ name: f.name, type: f.type, size: Math.round((f.data || '').length * 0.75) }));
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(meta) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

// Returns base64 files stored during native form submission.
// GET /.netlify/functions/get-files?id={sarId}

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
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(files) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

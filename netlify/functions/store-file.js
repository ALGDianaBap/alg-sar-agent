/**
 * Appends a single file to a SAR's stored file list in Blobs.
 * Called once per file after form-submit returns a SAR id.
 * POST body: { id, file: { name, type, data (base64) } }
 */

const { store: _getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { id, file } = JSON.parse(event.body);
    if (!id || !file) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id or file' }) };

    const store    = _getStore('form-files');
    const existing = await store.get(id, { type: 'json' }).catch(() => []);
    const list     = Array.isArray(existing) ? existing : [];
    list.push(file);
    await store.set(id, JSON.stringify(list));

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, stored: true, count: list.length }) };
  } catch (e) {
    console.error('store-file error:', e.message);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

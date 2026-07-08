/**
 * Appends a single file to a SAR's stored file list in Blobs.
 * Called once per file after form-submit returns a SAR id.
 *
 * Two body shapes:
 *   { id, file: { name, type, data } }                          — single-shot, small files.
 *   { id, chunk: { name, type, index, total, data } }           — one piece of a large file,
 *     sent in sequence. Each chunk is its own small HTTP request (well under Netlify's
 *     ~6MB function request limit) — real scanned RISC contracts routinely exceed that
 *     limit as a single upload, so large files must be split client-side before calling this.
 *     Once the last chunk (index === total-1) arrives, the pieces are concatenated in
 *     order and stored as one file, same as the single-shot path.
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
    const { id, file, chunk } = JSON.parse(event.body);
    if (!id || (!file && !chunk)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id or file/chunk' }) };

    const store = _getStore('form-files');

    if (chunk) {
      const chunkStore = _getStore('form-file-chunks');
      const chunkKey = `${id}::${chunk.name}`;
      const existingParts = await chunkStore.get(chunkKey, { type: 'json' }).catch(() => null);
      const parts = existingParts && existingParts.total === chunk.total ? existingParts.parts : {};
      parts[chunk.index] = chunk.data;

      const receivedCount = Object.keys(parts).length;
      if (receivedCount < chunk.total) {
        await chunkStore.set(chunkKey, JSON.stringify({ total: chunk.total, parts }));
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, received: receivedCount, total: chunk.total }) };
      }

      // Last chunk — reassemble in order and store as a normal file entry.
      const fullData = Array.from({ length: chunk.total }, (_, i) => parts[i]).join('');
      await chunkStore.delete(chunkKey).catch(() => {});

      const existing = await store.get(id, { type: 'json' }).catch(() => []);
      const list = Array.isArray(existing) ? existing : [];
      list.push({ name: chunk.name, type: chunk.type, data: fullData });
      await store.set(id, JSON.stringify(list));
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, stored: true, count: list.length }) };
    }

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

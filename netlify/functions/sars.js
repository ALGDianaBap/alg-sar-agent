/**
 * Shared SAR records CRUD — Netlify Blobs as the source of truth.
 * All clients read/write here so every user sees the same dashboard.
 *
 * GET              → list all SARs, newest first
 * POST             → create SAR
 * PATCH  ?id=      → merge-update fields on a SAR
 * DELETE ?id=      → delete SAR
 */
const { getStore } = require('@netlify/blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  let store;
  try { store = getStore('sar-records'); }
  catch (e) { return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Blobs unavailable: ' + e.message }) }; }

  const id = (event.queryStringParameters || {}).id;

  // ── GET: list all SARs ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const { blobs } = await store.list();
      const items = await Promise.all(
        blobs.map(async ({ key }) => {
          const data = await store.get(key, { type: 'json' });
          return data ? { ...data, id: key } : null;
        })
      );
      const sorted = items
        .filter(Boolean)
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(sorted) };
    } catch (e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── POST: create SAR ───────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let sarData;
    try { sarData = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }
    const sarId = String(sarData.id || Date.now());
    const record = { ...sarData, id: sarId };
    await store.set(sarId, JSON.stringify(record));
    return { statusCode: 201, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(record) };
  }

  // ── PATCH: update SAR fields ───────────────────────────────────────────────
  if (event.httpMethod === 'PATCH') {
    if (!id) return { statusCode: 400, headers: cors, body: 'Missing id' };
    const existing = await store.get(id, { type: 'json' });
    if (!existing) return { statusCode: 404, headers: cors, body: 'SAR not found' };
    let updates;
    try { updates = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }
    const updated = { ...existing, ...updates, id };
    await store.set(id, JSON.stringify(updated));
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(updated) };
  }

  // ── DELETE: remove SAR ─────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (!id) return { statusCode: 400, headers: cors, body: 'Missing id' };
    await store.delete(id);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};

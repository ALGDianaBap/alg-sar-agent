/**
 * SAR template library — store EN/ES .docx templates in Netlify Blobs.
 *
 * GET  (no params)             → list all stored templates (name, date, size)
 * GET  ?lang=en&type=cash_keep → return { base64, filename, uploaded } for one template
 * POST { lang, type, base64, filename } → upload / replace a template
 * DELETE ?lang=en&type=cash_keep → delete a template
 *
 * Template keys: en_cash_keep · en_rescission · es_cash_keep · es_rescission
 *
 * Placeholder syntax for Word documents: {buyer_name}, {dealer_name}, etc.
 * Full list: today_date, buyer_name, dealer_name, vehicle, vehicle_year,
 *   vehicle_make, vehicle_model, vin, purchase_date, settlement_amount,
 *   settlement_amount_words, down_payment, down_payment_words, miles_driven,
 *   apr, work_desc, dealer_giving, refund_notes, third_party
 *
 * AI-drafted case-specific paragraphs (see callAIDraftAgreement in index.html):
 *   dispute_recital      — the "Buyer claims... Dealer claims..." sentence(s)
 *                           for Recital A.2. Fixed WHEREAS framing surrounds it
 *                           in the template.
 *   section_b_paragraph  — the payment/consideration paragraph for Section B.
 *                           The fixed RISC-affirmation sentence (cash_keep) or
 *                           vehicle-return + RISC-rescission sentences
 *                           (rescission) must be typed directly into the
 *                           template right after this tag — they are NOT
 *                           part of this field, so attorney edits to that
 *                           boilerplate always take effect without a code change.
 */

const { store: getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

const VALID_LANGS  = ['en', 'es'];
const VALID_TYPES  = ['cash_keep', 'rescission'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  let store;
  try { store = getStore('sar-templates'); }
  catch (e) { return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Blobs unavailable: ' + e.message }) }; }

  const qs = event.queryStringParameters || {};

  // ── GET list all ────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !qs.lang) {
    const list = [];
    for (const lang of VALID_LANGS) {
      for (const type of VALID_TYPES) {
        const meta = await store.get(`${lang}_${type}_meta`, { type: 'json' }).catch(() => null);
        if (meta) list.push({ lang, type, ...meta });
      }
    }
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
  }

  // ── GET single template ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && qs.lang) {
    const { lang, type } = qs;
    if (!VALID_LANGS.includes(lang) || !VALID_TYPES.includes(type)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid lang or type' }) };
    }
    const key = `${lang}_${type}`;
    const [base64, meta] = await Promise.all([
      store.get(key).catch(() => null),
      store.get(`${key}_meta`, { type: 'json' }).catch(() => null),
    ]);
    if (!base64) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Template not found' }) };
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, filename: meta?.filename, uploaded: meta?.uploaded, size: meta?.size }),
    };
  }

  // ── POST upload template ────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { lang, type, base64, filename } = payload;
    if (!VALID_LANGS.includes(lang) || !VALID_TYPES.includes(type)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid lang or type' }) };
    }
    if (!base64) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing base64' }) };

    const key = `${lang}_${type}`;
    const sizeBytes = Math.round(base64.length * 0.75);
    await Promise.all([
      store.set(key, base64),
      store.set(`${key}_meta`, JSON.stringify({
        filename: filename || `${lang}_${type}.docx`,
        uploaded: new Date().toISOString(),
        size: sizeBytes,
      })),
    ]);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  // ── DELETE template ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const { lang, type } = qs;
    if (!VALID_LANGS.includes(lang) || !VALID_TYPES.includes(type)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid lang or type' }) };
    }
    const key = `${lang}_${type}`;
    await Promise.all([
      store.delete(key).catch(() => {}),
      store.delete(`${key}_meta`).catch(() => {}),
    ]);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
};

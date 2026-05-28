const { buildDocument, Packer } = require('./_docx-builder');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { fields, dealType } = JSON.parse(event.body || '{}');
    if (!fields) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing fields' }) };

    const doc = buildDocument(fields, dealType || 'cash_keep');
    const base64 = await Packer.toBase64String(doc);

    const buyerSlug  = (fields.buyer_name  || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const dealerSlug = (fields.dealer_name || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const filename   = `SAR_${buyerSlug}_${dealerSlug}.docx`;

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, base64, filename, size: Math.round(base64.length * 0.75) })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

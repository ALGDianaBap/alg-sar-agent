/**
 * RISC field extraction — the single source of truth for the extraction prompt.
 *
 * Two call modes, same response shape:
 *   { base64 }           — small file, sent inline (still bound by Netlify's
 *                           ~6MB function request limit, fine for files under
 *                           a few MB).
 *   { id, fileName }      — file already stored via store-file.js. The file's
 *                           bytes are read here, server-side, straight out of
 *                           Blobs and handed to Anthropic directly — they
 *                           never cross the client↔function boundary, so this
 *                           mode has no practical size limit (real scanned
 *                           RISC contracts are routinely 5-8MB, well over the
 *                           6MB limit that broke the old client-side-only path).
 */
const https = require('https');
const { store: getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You extract data from vehicle purchase contracts for a California auto law firm.
Identify the document by its CONTENT and STRUCTURE, not its filename or label.
A California Retail Installment Sales Contract (RISC / LAW 553-CA) has ALL of these: a buyer name+address section, a dealer/seller-creditor section, a vehicle description with VIN and odometer, a price breakdown (cash price, down payment, amount financed), an APR disclosure, and signature blocks.
If this document contains those elements — even if unlabeled, scanned poorly, or has a generic filename — treat it as a RISC and extract the fields.
Only return {"not_risc":true} if the document clearly cannot contain these fields (e.g. it is only a Buyer's Guide, insurance certificate, GAP addendum with no purchase price, or DMV form with no buyer purchase info).

CRITICAL — DO NOT CONFUSE BUYER AND SELLER:
- buyer_name = the individual CONSUMER/CUSTOMER. On a RISC this is the person labeled "Buyer" (and "Co-Buyer" if present), usually at the TOP of the form. This is a PERSON'S name, almost never a company. This is our client.
- dealer_name = the BUSINESS labeled "Seller", "Seller-Creditor", "Creditor", or "Dealer". This is a company name (often ends with INC, LLC, MOTORS, AUTO, AUTO SALES, etc.).
- NEVER put the dealership/seller/creditor business name in buyer_name. NEVER put the consumer's name in dealer_name.
- buyer_address = the Buyer's home address (NOT the dealership address).
- If a name looks like a business (INC/LLC/MOTORS/AUTO SALES), it is the dealer, not the buyer.

Return ONLY valid JSON no markdown:
{"buyer_name":"ALL CAPS full name of the consumer/Buyer","buyer_address":"buyer's full home address","dealer_name":"ALL CAPS seller/creditor business name","vehicle_year":"4 digits","vehicle_make":"","vehicle_model":"","vehicle_new_used":"New or Used","vin":"17-char VIN","odometer":"numeric","purchase_date":"MM/DD/YYYY from signature page","settlement_amount":"leave blank","settlement_amount_words":"","down_payment":"numeric only no $ or commas","total_sale_price":"","monthly_payment":"","apr":"","miles_driven":"same as odometer","notes":"any flags","missing_fields":[]}`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    let base64 = payload.base64;
    if (!base64 && payload.id && payload.fileName) {
      const files = await getStore('form-files').get(String(payload.id), { type: 'json' }).catch(() => null);
      const file = Array.isArray(files) ? files.find(f => f.name === payload.fileName) : null;
      if (!file) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Stored file not found: ' + payload.fileName }) };
      base64 = file.data;
    }
    if (!base64) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing base64 or {id, fileName}' }) };

    const anthropicBody = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Is this a RISC? If yes extract all fields and return the JSON. If no return {"not_risc":true}.' }
        ]
      }]
    });

    const anthropicRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25',
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(anthropicBody),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(anthropicBody);
      req.end();
    });

    if (anthropicRes.status < 200 || anthropicRes.status >= 300) {
      return { statusCode: anthropicRes.status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'AI service error: ' + anthropicRes.body.slice(0, 300) }) };
    }
    const d = JSON.parse(anthropicRes.body);
    if (d.type === 'error' || d.error) {
      const errObj = d.error || {};
      return { statusCode: 502, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: typeof errObj === 'string' ? errObj : (errObj.message || 'AI extraction failed') }) };
    }
    const text = (d.content || []).find(b => b.type === 'text')?.text || '';
    if (!text) return { statusCode: 502, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No response from AI — the PDF may be image-only or unreadable' }) };

    const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1) return { statusCode: 502, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'AI did not return JSON: ' + cleaned.slice(0, 150) }) };

    const fields = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) };
  } catch (e) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

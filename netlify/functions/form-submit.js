/**
 * Native SAR intake form processor.
 *
 * Receives JSON from submit.html with all form fields + base64 PDF files.
 * Runs the full pipeline without any third-party API dependencies:
 *   1. Identify the RISC among uploaded files (Claude content-based check)
 *   2. Extract vehicle/deal data from the RISC
 *   3. Generate pre-filled .docx draft
 *   4. Assign next CM (round-robin)
 *   5. Auto-search Clio for dealer matter
 *   6. Store SAR in Netlify Blobs (shared dashboard)
 *   7. Slack notification to #settlement-agreements
 */

const https = require('https');
const { store: getStore } = require('./_blobs');
const { buildDocument, Packer } = require('./_docx-builder');
const { getClioToken } = require('./_clio-auth');

const SLACK_CHANNEL = 'C09QF0PRLJ2';
const CMS = [
  { name: 'Pedro',     slackId: 'U09QP4Z4KUG' },
  { name: 'Samir',     slackId: 'U09PDBV7287' },
  { name: 'Daniel M',  slackId: 'U09Q7NJ7C5P' },
  { name: 'Gabriel J', slackId: 'U09QP4ZKY0G' },
  { name: 'Linda',     slackId: 'U09PYC93DNY' },
  { name: 'Viena',     slackId: 'U09Q7NGHA0H' },
];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    return await processSubmission(event);
  } catch (e) {
    console.error('form-submit unhandled error:', e.message, e.stack);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message || 'Internal error' }) };
  }
};

async function processSubmission(event) {

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { firstName, lastName, phone, email, dealership,
          workDesc, dealerGiving, hasHappened, refundNotes,
          language = 'en', files = [] } = body;

  if (!firstName || !lastName || !dealership || !workDesc) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const buyer  = `${firstName} ${lastName}`.toUpperCase();
  const dealer = dealership.toUpperCase();
  const isRescission = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);
  const dealType = isRescission ? 'rescission' : 'cash_keep';

  // ── 1 & 2. IDENTIFY RISC AND EXTRACT FIELDS ──────────────────────────────
  let fields = {
    buyer_name: buyer, dealer_name: dealer,
    vehicle_year: '', vehicle_make: '', vehicle_model: '',
    vin: '', odometer: '', purchase_date: '',
    settlement_amount: '', settlement_amount_words: '',
    down_payment: '', total_sale_price: '', monthly_payment: '',
    apr: '', miles_driven: '', notes: '', missing_fields: []
  };

  // Sort uploaded files by RISC likelihood (filename hint), try each one
  const sortedFiles = [...files].sort((a, b) => riscScore(b.name) - riscScore(a.name));

  for (const file of sortedFiles) {
    if (!file.data) continue;
    try {
      const extracted = await extractRISC(file.data);
      if (extracted && !extracted.not_risc) {
        fields = {
          ...extracted,
          buyer_name:  extracted.buyer_name  || buyer,
          dealer_name: extracted.dealer_name || dealer,
        };
        console.log('RISC extracted from', file.name, '— VIN:', fields.vin);
        break;
      }
    } catch (e) {
      console.warn('Extract failed for', file.name, ':', e.message);
    }
  }

  const finalBuyer  = fields.buyer_name  || buyer;
  const finalDealer = fields.dealer_name || dealer;
  const vehicle = [fields.vehicle_year, fields.vehicle_make, fields.vehicle_model].filter(Boolean).join(' ');

  // ── 3. GENERATE .docx DRAFT ───────────────────────────────────────────────
  const zohoContext = { workDesc, dealerGiving, refundNotes, hasHappened,
                        whoWork: '', thirdParty: '', priorRepairs: '' };
  let draftBase64 = null, draftFilename = null;
  try {
    const doc = buildDocument(fields, dealType, zohoContext);
    draftBase64   = await Packer.toBase64String(doc);
    const bs = finalBuyer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const ds = finalDealer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    draftFilename = `SAR_${bs}_${ds}.docx`;
    console.log('Draft generated:', draftFilename);
  } catch (e) {
    console.warn('Draft generation failed:', e.message);
  }

  // ── 4. ASSIGN CM (round-robin) ────────────────────────────────────────────
  let cm = CMS[0];
  try {
    const s = getStore('sar-meta');
    const rr = await s.get('rr-index', { type: 'json' }).catch(() => null);
    const idx = ((rr?.idx) ?? 0) % CMS.length;
    cm = CMS[idx];
    await s.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length }));
  } catch (e) { console.error('RR error:', e.message); }

  // ── 5. SEARCH CLIO ────────────────────────────────────────────────────────
  let matter = null;
  try {
    const token = await getClioToken();
    if (token) matter = await searchClioMatter(finalDealer, token);
  } catch (e) { console.warn('Clio search failed:', e.message); }

  // ── 6. STORE SAR ──────────────────────────────────────────────────────────
  const id = Date.now().toString();
  const attachments = files.map(f => ({ name: f.name, source: 'native-form', extracted: false }));

  const sarData = {
    id, created: new Date().toISOString(),
    status: draftBase64 ? 'draft' : 'new',
    source: 'native-form', urgency: 'normal',
    buyer: finalBuyer, dealer: finalDealer,
    phone, email, language, dealType, vehicle,
    vin: fields.vin || '', amount: fields.settlement_amount || '',
    attachments, fields, matter,
    assignee: cm.name, assigneeSlackId: cm.slackId,
    attorney: null, attorneySlackId: null,
    draftBase64, draftFilename, zohoContext,
    notes: [workDesc, dealerGiving, refundNotes].filter(Boolean).join(' | '),
    reviewNotes: '', timeEntries: [],
  };

  try {
    await getStore('sar-records').set(id, JSON.stringify(sarData));
  } catch (e) { console.error('Blob store error:', e.message); }

  // ── 7. SLACK NOTIFICATION ─────────────────────────────────────────────────
  const dealLabel  = isRescission ? 'Rescission' : 'Cash & Keep';
  const langLabel  = language === 'es' ? 'Spanish' : 'English';
  const matterStr  = matter ? `#${matter.num} — ${matter.name}` : '_Not linked yet_';
  const draftLine  = draftBase64
    ? '✅ *Draft ready — open SAR Agent to review*'
    : '⚠️ *No RISC found in uploaded files — CM to review documents*';

  const contextLines = [workDesc, dealerGiving, refundNotes]
    .filter(Boolean).map(l => `> ${l.slice(0, 120)}`).join('\n');

  const slackText =
    `📋 *New SAR — <@${cm.slackId}> assigned*\n\n` +
    `*Buyer:* ${finalBuyer}\n` +
    `*Dealer:* ${finalDealer}\n` +
    `*Type:* ${dealLabel} · ${langLabel}\n` +
    (vehicle ? `*Vehicle:* ${vehicle}${fields.vin ? ' · VIN ' + fields.vin : ''}\n` : '') +
    (fields.settlement_amount ? `*Settlement:* $${fields.settlement_amount}\n` : '') +
    (fields.down_payment      ? `*Down payment:* $${fields.down_payment}\n`      : '') +
    `*Phone:* ${phone || '—'}\n` +
    `*Clio matter:* ${matterStr}\n` +
    (contextLines ? `\n*From form:*\n${contextLines}\n` : '') +
    `\n${draftLine}`;

  try { await postSlack(SLACK_CHANNEL, slackText); }
  catch (e) { console.error('Slack error:', e.message); }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, id, ref: id.slice(-6) }),
  };
}

// ── HELPERS ────────────────────────────────────────────────────────────────────

function riscScore(filename) {
  const n = (filename || '').toLowerCase();
  if (/risc|retail.?install|law.?553/.test(n)) return 4;
  if (/contract|installment/.test(n)) return 3;
  if (/agreement/.test(n)) return 2;
  if (/buyer.?guide|insurance|gap|sticker/.test(n)) return 0;
  return 1;
}

async function extractRISC(base64Pdf) {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: `You extract data from vehicle purchase contracts for a California auto law firm.
Identify the document by CONTENT and STRUCTURE, not filename.
A California RISC (LAW 553-CA) has: buyer name+address, dealer/seller-creditor section, vehicle description with VIN, price breakdown (cash price, down payment, amount financed), APR disclosure, and signature blocks.
If this document contains those elements, extract the fields.
Only return {"not_risc":true} if it clearly cannot contain those fields (e.g. Buyer's Guide only, insurance cert, GAP addendum, DMV form).
If it IS a RISC, return ONLY valid JSON no markdown: {"buyer_name":"ALL CAPS","buyer_address":"","dealer_name":"ALL CAPS","vehicle_year":"","vehicle_make":"","vehicle_model":"","vehicle_new_used":"New or Used","vin":"17-char VIN","odometer":"","purchase_date":"MM/DD/YYYY","settlement_amount":"leave blank","settlement_amount_words":"","down_payment":"numeric no $","total_sale_price":"","monthly_payment":"","apr":"","miles_driven":"","notes":"","missing_fields":[]}`,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
        { type: 'text', text: 'Is this a RISC? If yes extract all fields. If no return {"not_risc":true}.' }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI timeout')), 25000);
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(requestBody)),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.find(b => b.type === 'text')?.text || '';
          resolve(JSON.parse(text.replace(/```json\n?/g, '').replace(/```/g, '').trim()));
        } catch (e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(requestBody);
    req.end();
  });
}

function searchClioMatter(dealerName, token) {
  const path = `/api/v4/matters.json?query=${encodeURIComponent(dealerName)}&limit=8&fields=id,display_number,description,client,status,practice_area`;
  return new Promise((resolve) => {
    const options = {
      hostname: 'app.clio.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const { data: matters } = JSON.parse(data);
          if (!matters?.length) return resolve(null);
          const open = matters.filter(m => m.status === 'Open');
          const best = open.find(m => /general/i.test(m.practice_area?.name || '')) || open[0] || matters[0];
          resolve({ id: best.id, num: best.display_number || '', name: best.description || '', client: best.client?.name || '' });
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();
  const body = JSON.stringify({
    channel,
    text: text.replace(/[*_`>]/g, '').slice(0, 100),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    };
    const req = https.request(options, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

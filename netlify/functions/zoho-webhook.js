/**
 * Zoho Forms webhook — full SAR pipeline.
 *
 * On POST (Zoho submission):
 *   1. Parse form fields
 *   2. Download RISC PDF attachment (if URL is present in payload)
 *   3. Extract vehicle/deal data from RISC via Claude
 *   4. Generate pre-filled .docx draft
 *   5. Assign next CM (round-robin, counter in Blobs)
 *   6. Auto-search Clio for dealer matter (if CLIO_TOKEN env var is set)
 *   7. Store complete SAR record in Netlify Blobs
 *   8. Notify #settlement-agreements: @CM assigned, draft ready/pending
 *
 * GET  — frontend fetches the pending-SAR queue
 * DELETE ?id= — frontend marks a SAR as imported (removes from queue)
 */

const https  = require('https');
const http   = require('http');
const { getStore } = require('@netlify/blobs');
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
const ATTORNEYS = {
  cash_keep:  { name: 'Amir N', slackId: 'U09PQU2F737' },
  rescission: { name: 'Ali R',  slackId: 'U09PUC0EBLJ' },
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  // ── 1. PARSE ZOHO FIELDS ──────────────────────────────────────────────────
  let body = {};
  const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  try {
    body = ct.includes('application/json')
      ? JSON.parse(event.body || '{}')
      : Object.fromEntries(new URLSearchParams(event.body || ''));
  } catch (e) {
    return { statusCode: 400, headers: cors, body: 'Parse error: ' + e.message };
  }

  // Zoho field name helper — tries multiple casing/naming variants
  function pick(...keys) {
    for (const k of keys) {
      const v = body[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  // Confirmed Zoho field names (verified from debug dump 2026-05-28).
  // Zoho sends keys with spaces, not underscores.
  const buyerFirst = pick('Dealer Name', 'Dealer_Name', 'Name', 'First_Name');
  const buyerLast  = pick('Dealer Last Name', 'Dealer_Last_Name', 'Last_Name');
  const buyer = [buyerFirst, buyerLast].filter(Boolean).join(' ') || 'Unknown Buyer';

  const dealer = pick('Dealership Name', 'Dealership_Name', 'Dealership', 'Company')
    || 'Unknown Dealership';

  const phone    = pick('Phone', 'Phone_Number', 'Mobile');
  const email    = pick('Email', 'Email_Address');
  const langRaw  = pick('Language', 'Preferred_Language');
  const language = /spanish|español|es\b/i.test(langRaw) ? 'es' : 'en';

  const workDesc     = pick('What are you doing for the customer?', 'What_are_you_doing_for_the_customer');
  const dealerGiving = pick("What's the dealership giving in return?", 'Whats_the_dealership_giving_in_return');
  const refundNotes  = pick('If refund is partial or includes deductions', 'If_refund_is_partial_or_includes_deductions');
  const thirdParty   = pick('Third Party', 'Third_Party');
  const hasHappened  = pick('Has this already happened?', 'Has_this_already_happened');
  const whoWork      = pick('Who is doing the work?', 'Who_is_doing_the_work');
  const isRescission = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);
  const dealType     = isRescission ? 'rescission' : 'cash_keep';

  // ── 2. PDF ATTACHMENT ─────────────────────────────────────────────────────
  // Zoho sends the file field as a plain filename (not a URL), so server-side
  // RISC extraction is not possible. The CM uploads the RISC manually in the app.
  const pdfUrl = (() => {
    const raw = pick('Documents to Upload', 'Documents_to_Upload', 'Documents', 'Files', 'RISC');
    if (!raw) return null;
    const first = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(',')[0].trim();
    return /^https?:\/\//i.test(first) ? first : null; // only use if it's actually a URL
  })();

  const attachmentNames = (() => {
    const raw = pick('Documents to Upload', 'Documents_to_Upload', 'Documents', 'Files', 'RISC');
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    return arr.map(a => ({ name: (typeof a === 'object' ? a.name : String(a)).trim() })).filter(a => a.name);
  })();

  // ── 3. DOWNLOAD RISC PDF ──────────────────────────────────────────────────
  let riscBuffer = null;
  if (pdfUrl) {
    try {
      riscBuffer = await downloadWithTimeout(pdfUrl, 7000);
      console.log('RISC PDF downloaded:', riscBuffer.length, 'bytes from', pdfUrl);
    } catch (e) {
      console.warn('PDF download failed:', e.message);
    }
  }

  // ── 4. EXTRACT RISC FIELDS VIA CLAUDE ────────────────────────────────────
  let fields = {
    buyer_name:  buyer,
    dealer_name: dealer,
    vehicle_year: '', vehicle_make: '', vehicle_model: '',
    vin: '', purchase_date: '', settlement_amount: '', settlement_amount_words: '',
    down_payment: '', miles_driven: '', notes: '', missing_fields: []
  };

  if (riscBuffer && process.env.ANTHROPIC_API_KEY) {
    try {
      const extracted = await extractRISCFields(riscBuffer);
      // Merge: keep buyer/dealer from form if RISC has blanks
      fields = {
        ...extracted,
        buyer_name:  extracted.buyer_name  || buyer,
        dealer_name: extracted.dealer_name || dealer,
      };
      console.log('RISC extraction succeeded:', fields.vehicle_year, fields.vehicle_make, fields.vin);
    } catch (e) {
      console.warn('RISC extraction failed:', e.message);
      fields.notes = 'RISC extraction failed: ' + e.message;
    }
  } else if (!riscBuffer) {
    fields.notes = 'No RISC PDF found in webhook — fields require manual entry.';
    fields.missing_fields = ['vehicle_year','vehicle_make','vehicle_model','vin','purchase_date','down_payment','miles_driven'];
  }

  // ── 5. GENERATE .docx DRAFT ───────────────────────────────────────────────
  // Pass the full Zoho form context so the document reflects negotiation terms,
  // prior actions, repairs, refunds, and third-party obligations.
  const zohoContext = {
    workDesc,
    dealerGiving,
    refundNotes,
    hasHappened,
    whoWork,
    thirdParty,
    priorRepairs: '', // not a separate Zoho field — inferred from hasHappened + whoWork
  };

  let draftBase64 = null;
  let draftFilename = null;
  let draftSize = 0;
  try {
    const doc = buildDocument(fields, dealType, zohoContext);
    draftBase64 = await Packer.toBase64String(doc);
    const buyerSlug  = buyer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const dealerSlug = dealer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    draftFilename = `SAR_${buyerSlug}_${dealerSlug}.docx`;
    draftSize = Math.round(draftBase64.length * 0.75);
    console.log('Draft generated:', draftFilename, draftSize, 'bytes');
  } catch (e) {
    console.warn('Draft generation failed:', e.message);
  }

  // ── 6. ASSIGN CM (round-robin counter in Blobs) ───────────────────────────
  let cm = CMS[0];
  try {
    const store = getStore('sar-queue');
    const rr = await store.get('rr-index', { type: 'json' }).catch(() => null);
    const idx = ((rr?.idx) ?? 0) % CMS.length;
    cm = CMS[idx];
    await store.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length }));
  } catch (e) {
    console.error('RR error:', e.message);
  }

  // ── 7. AUTO-SEARCH CLIO ───────────────────────────────────────────────────
  // getClioToken() returns a valid token (auto-refreshing via refresh token).
  // If no token is stored yet, this is a no-op and matter stays null.
  let matter = null;
  try {
    const clioToken = await getClioToken();
    if (clioToken) {
      matter = await searchClioMatter(dealer, clioToken);
      if (matter) console.log('Clio matter found:', matter.num, matter.name);
    }
  } catch (e) {
    console.warn('Clio search failed:', e.message);
  }

  // ── 8. STORE COMPLETE SAR IN sar-records (shared dashboard store) ─────────
  const id = Date.now().toString();
  const vehicle = [fields.vehicle_year, fields.vehicle_make, fields.vehicle_model].filter(Boolean).join(' ');
  const sarData = {
    id,
    created:         new Date().toISOString(),
    status:          draftBase64 ? 'draft' : 'new',
    source:          'webhook',
    urgency:         'normal',
    buyer,
    dealer,
    phone,
    email,
    language,
    dealType,
    vehicle,
    vin:             fields.vin || '',
    amount:          fields.settlement_amount || '',
    attachments:     attachmentNames,
    fields,
    matter,
    assignee:        cm.name,
    assigneeSlackId: cm.slackId,
    // No attorney set here — CM selects attorney when submitting for review
    attorney:        null,
    attorneySlackId: null,
    draftBase64,
    draftFilename,
    zohoContext,
    notes: [workDesc, dealerGiving, refundNotes, thirdParty, fields.notes].filter(Boolean).join(' | '),
    reviewNotes:     '',
    timeEntries:     [],
    zohoData:        body,
  };

  try {
    const store = getStore('sar-records');
    await store.set(id, JSON.stringify(sarData));
  } catch (e) {
    console.error('Blob store error:', e.message);
  }

  // ── 9. SLACK NOTIFICATION ─────────────────────────────────────────────────
  const dealLabel  = isRescission ? 'Rescission' : 'Cash & Keep';
  const langLabel  = language === 'es' ? 'Spanish' : 'English';
  const draftReady = draftBase64 ? '✅ *Draft is ready for your review.*' : '⚠️ Draft pending — RISC PDF not received automatically.';
  const vehicleStr = vehicle || '—';
  const vinStr     = fields.vin ? ` (VIN: ${fields.vin})` : '';
  const matterStr  = matter ? `#${matter.num} — ${matter.name}` : '_Not linked — please link in SAR Agent_';

  const slackText =
    `📋 *New SAR — <@${cm.slackId}> assigned*\n\n` +
    `*Buyer:* ${buyer}\n` +
    `*Dealer:* ${dealer}\n` +
    `*Vehicle:* ${vehicleStr}${vinStr}\n` +
    `*Type:* ${dealLabel} · ${langLabel}\n` +
    (fields.settlement_amount ? `*Settlement:* $${fields.settlement_amount}\n` : '') +
    (fields.down_payment      ? `*Down payment:* $${fields.down_payment}\n`      : '') +
    `*Matter:* ${matterStr}\n\n` +
    draftReady;

  try {
    await postSlack(SLACK_CHANNEL, slackText);
  } catch (e) {
    console.error('Slack error:', e.message);
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, id, assignedTo: cm.name, draftReady: !!draftBase64 })
  };
};

// ── HELPERS ────────────────────────────────────────────────────────────────────

function downloadWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Download timeout')), timeoutMs);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        downloadWithTimeout(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function extractRISCFields(pdfBuffer) {
  const base64Pdf = pdfBuffer.toString('base64');
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: 'You extract structured data from California RISC (Retail Installment Sales Contract) PDFs for an auto law firm. Return ONLY valid JSON, no markdown. The form is LAW 553-CA. Extract: {"buyer_name":"ALL CAPS full name","buyer_address":"full address","dealer_name":"ALL CAPS dealership name","dealer_address":"","vehicle_year":"4 digits","vehicle_make":"","vehicle_model":"","vehicle_new_used":"New or Used","vin":"17-char VIN","odometer":"numeric","purchase_date":"MM/DD/YYYY from signature page","settlement_amount":"leave blank","settlement_amount_words":"leave blank","down_payment":"numeric only no $ sign","total_sale_price":"","monthly_payment":"","apr":"","miles_driven":"same as odometer","notes":"any issues or flags","missing_fields":["list any fields not found"]}',
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
        { type: 'text', text: 'Extract all fields from this RISC contract. Return only the JSON object.' }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI timeout')), 20000);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(requestBody))
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.find(b => b.type === 'text')?.text || '';
          const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
          resolve(JSON.parse(cleaned));
        } catch (e) { reject(new Error('AI parse error: ' + e.message)); }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(requestBody);
    req.end();
  });
}

async function searchClioMatter(dealerName, token) {
  return new Promise((resolve) => {
    const path = `/api/v4/matters.json?query=${encodeURIComponent(dealerName)}&limit=8&fields=id,display_number,description,client,status,practice_area`;
    const options = {
      hostname: 'app.clio.com',
      path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const { data: matters } = JSON.parse(data);
          if (!matters?.length) return resolve(null);
          // Prefer: Open + General Matters; fall back to first open matter
          const open = matters.filter(m => m.status === 'Open');
          const general = open.find(m => /general/i.test(m.practice_area?.name || ''));
          const best = general || open[0] || matters[0];
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
    text: text.replace(/[*_`]/g, '').slice(0, 100),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }]
  });
  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }
    };
    const req = https.request(options, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

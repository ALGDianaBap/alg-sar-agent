/**
 * Zoho Forms webhook — full SAR pipeline.
 *
 * On POST (Zoho submission):
 *   1. Parse form fields (confirmed field names from debug 2026-05-28)
 *   2. Fetch RISC PDF via Zoho Forms API (using entry ID + Zoho OAuth token)
 *   3. Extract vehicle/deal data from RISC via Claude
 *   4. Generate pre-filled .docx draft
 *   5. Assign next CM (round-robin, counter in Blobs)
 *   6. Auto-search Clio for dealer matter
 *   7. Store complete SAR record in sar-records Blobs store
 *   8. Notify #settlement-agreements: @CM assigned, draft ready/pending
 */

const https  = require('https');
const http   = require('http');
const { store: getStore } = require('./_blobs');
const { buildDocument, Packer } = require('./_docx-builder');
const { getClioToken } = require('./_clio-auth');
const { getZohoToken } = require('./_zoho-auth');

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

  // ── 2. IDENTIFY ATTACHMENTS & ENTRY ID ───────────────────────────────────
  const rawAttach = pick('Documents to Upload', 'Documents_to_Upload', 'Documents', 'Files', 'RISC');
  const attachmentNames = (() => {
    if (!rawAttach) return [];
    const arr = Array.isArray(rawAttach) ? rawAttach : String(rawAttach).split(',');
    return arr.map(a => ({ name: (typeof a === 'object' ? a.name : String(a)).trim() })).filter(a => a.name);
  })();

  // Zoho sends entry ID alongside form fields — try every known key variant.
  const entryId  = pick('Entry_Id', 'entry_id', 'entryId', 'Entry Id', 'Submission_Id', 'Record_Id', 'ID');

  // Form name: extract just the slug from whatever was stored in ZOHO_FORM_NAME.
  // Users sometimes paste the full URL — pull the part after /form/.
  const rawFormName = process.env.ZOHO_FORM_NAME
    || pick('Form_Name', 'form_name', 'formName', 'Form Name');
  const formName = (() => {
    if (!rawFormName) return '';
    if (rawFormName.includes('/form/')) return rawFormName.split('/form/')[1].split('/')[0];
    if (rawFormName.includes('/')) return rawFormName.split('/').filter(Boolean).pop();
    return rawFormName;
  })();

  // ── 3. DOWNLOAD RISC PDF ──────────────────────────────────────────────────
  // Strategy:
  //   a) If Zoho included a direct URL in the webhook payload, use it.
  //   b) Otherwise call the Zoho Forms API (entries endpoint) which returns
  //      real download URLs for file fields — the webhook only sends filenames.
  let riscBuffer = null;
  const pipelineLog = []; // temporary: posted to Slack so we can debug

  // (a) Direct URL in webhook payload (rarely present but check first)
  const directUrl = (() => {
    if (!rawAttach) return null;
    const first = (Array.isArray(rawAttach) ? String(rawAttach[0]) : String(rawAttach)).split(',')[0].trim();
    return /^https?:\/\//i.test(first) ? first : null;
  })();

  if (directUrl) {
    try {
      riscBuffer = await downloadWithTimeout(directUrl, 8000);
      pipelineLog.push(`✓ PDF via direct URL (${riscBuffer.length} bytes)`);
    } catch (e) {
      pipelineLog.push('✗ Direct URL failed: ' + e.message);
    }
  }

  // (b) Zoho Forms API: fetch entry → get file URL → download
  if (!riscBuffer) {
    const zohoToken = await getZohoToken();
    if (!zohoToken) {
      pipelineLog.push('✗ No Zoho token — click Connect Zoho in the app');
    } else if (!formName) {
      pipelineLog.push('✗ ZOHO_FORM_NAME env var not set');
    } else {
      pipelineLog.push(`Zoho token ✓  formName="${formName}"  entryId="${entryId || 'not in payload'}"`);
      try {
        const { entry, debugLines } = await fetchZohoEntry(zohoToken, formName, entryId);
        // Always show API call results so we can diagnose failures
        debugLines.forEach(l => pipelineLog.push('  ' + l));

        if (!entry) {
          pipelineLog.push('✗ No usable entry returned from any URL format');
        } else {
          pipelineLog.push('✓ Entry fetched — fields: ' + Object.keys(entry).slice(0, 15).join(', '));
          const fileUrls = findFileUrlsInEntry(entry);
          if (!fileUrls.length) {
            pipelineLog.push('✗ No file URLs in entry — check Zoho webhook "Include file URLs" setting');
          } else {
            pipelineLog.push(`Found ${fileUrls.length} file URL(s): ${fileUrls.map(f => f.name).join(', ')}`);
            // Try each file in RISC-likelihood order; stop at first successful RISC extraction
            for (const { url, name } of fileUrls) {
              try {
                const buf = await downloadWithTimeout(url, 10000, { 'Authorization': `Zoho-oauthtoken ${zohoToken}` });
                pipelineLog.push(`✓ Downloaded ${name} (${buf.length} bytes)`);
                // Quick Claude check: is this a RISC?
                const testResult = await extractRISCFields(buf);
                if (testResult && !testResult.not_risc) {
                  riscBuffer = buf;
                  pipelineLog.push(`✓ RISC confirmed in ${name}`);
                  break;
                } else {
                  pipelineLog.push(`  ${name}: not a RISC — trying next`);
                }
              } catch (e) {
                pipelineLog.push(`✗ ${name}: ${e.message}`);
              }
            }
            if (!riscBuffer) pipelineLog.push('✗ None of the files were identified as a RISC contract');
          }
        }
      } catch (e) {
        pipelineLog.push('✗ Zoho API error: ' + e.message);
      }
    }
  }

  if (!riscBuffer) pipelineLog.push('⚠ No RISC PDF — draft uses form data + placeholders');

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
  // Use RISC-extracted names when available; fall back to form values.
  // This is also the fix for buyer showing as dealership — fields.buyer_name
  // comes from the PDF (ALL CAPS legal name), buyer comes from the form field.
  const finalBuyer  = fields.buyer_name  || buyer;
  const finalDealer = fields.dealer_name || dealer;

  const zohoContext = {
    workDesc, dealerGiving, refundNotes, hasHappened, whoWork, thirdParty,
    priorRepairs: '',
  };

  let draftBase64 = null;
  let draftFilename = null;
  let draftSize = 0;
  try {
    const doc = buildDocument(fields, dealType, zohoContext);
    draftBase64 = await Packer.toBase64String(doc);
    const buyerSlug  = finalBuyer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const dealerSlug = finalDealer.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    draftFilename = `SAR_${buyerSlug}_${dealerSlug}.docx`;
    draftSize = Math.round(draftBase64.length * 0.75);
    pipelineLog.push(`✓ Draft generated: ${draftFilename} (${draftSize} bytes)`);
  } catch (e) {
    pipelineLog.push('✗ Draft generation failed: ' + e.message);
    console.warn('Draft generation failed:', e.message);
  }

  // ── 6. ASSIGN CM (round-robin counter in Blobs) ───────────────────────────
  let cm = CMS[0];
  try {
    const store = getStore('sar-meta');
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
    buyer:           finalBuyer,   // RISC-extracted name takes priority over form
    dealer:          finalDealer,
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
  const draftReady = draftBase64 ? '✅ *Draft ready for review*' : '⚠️ *Draft pending* — RISC not auto-read, CM runs agent in app';
  const vehicleStr = vehicle || '—';
  const vinStr     = fields.vin ? ` · VIN: ${fields.vin}` : '';
  const matterStr  = matter ? `#${matter.num} — ${matter.name}` : '_Link in SAR Agent_';

  const slackText =
    `📋 *New SAR — <@${cm.slackId}> assigned*\n\n` +
    `*Buyer:* ${finalBuyer}\n` +
    `*Dealer:* ${finalDealer}\n` +
    `*Vehicle:* ${vehicleStr}${vinStr}\n` +
    `*Type:* ${dealLabel} · ${langLabel}\n` +
    (fields.settlement_amount ? `*Settlement:* $${fields.settlement_amount}\n` : '') +
    (fields.down_payment      ? `*Down payment:* $${fields.down_payment}\n`      : '') +
    `*Matter:* ${matterStr}\n\n` +
    draftReady;

  // Pipeline log posted as a second Slack message for debugging.
  // Remove the second postSlack call once PDF extraction is confirmed working.
  const debugLog = `🔧 *Pipeline:*\n${pipelineLog.map(l => `  ${l}`).join('\n')}`;

  try {
    await postSlack(SLACK_CHANNEL, slackText);
    await postSlack(SLACK_CHANNEL, debugLog);
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

function downloadWithTimeout(url, timeoutMs, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Download timeout')), timeoutMs);
    const client = url.startsWith('https') ? https : http;
    const options = { headers: extraHeaders };
    client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        downloadWithTimeout(res.headers.location, timeoutMs, extraHeaders).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Fetch a Zoho Forms entry, trying multiple URL formats.
// Returns { entry, debugLines } — debugLines go into the pipeline Slack log
// so we can see exactly what the API returns on every attempt.
async function fetchZohoEntry(token, formName, entryId) {
  const debugLines = [];

  // Build list of URL candidates — Zoho's API docs are inconsistent about
  // whether the org prefix or /form/ segment is required.
  const candidates = entryId ? [
    `/api/v1/${formName}/entry/${encodeURIComponent(entryId)}`,
    `/api/v1/${formName}/entries/${encodeURIComponent(entryId)}`,
  ] : [
    `/api/v1/${formName}/entries?page=1&per_page=1`,
    `/api/v1/${formName}/report/All_Entries?per_page=1`,
    `/api/v1/form/${formName}/entries?page=1&per_page=1`,
  ];

  for (const path of candidates) {
    const { status, body } = await zohoApiGet(token, path);
    const snippet = body.slice(0, 180).replace(/\s+/g, ' ');
    debugLines.push(`${path} → HTTP ${status}: ${snippet}`);

    if (status === 200) {
      try {
        const parsed = JSON.parse(body);
        const entry = entryId
          ? (parsed.data || (Array.isArray(parsed) ? parsed[0] : null))
          : (() => { const l = parsed.data || parsed.entries || []; return Array.isArray(l) ? l[0] : null; })();
        if (entry) return { entry, debugLines };
      } catch (e) {
        debugLines.push('Parse error: ' + e.message);
      }
    }
  }

  return { entry: null, debugLines };
}

function zohoApiGet(token, path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'forms.zoho.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Accept': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

// Score a filename by RISC likelihood (higher = more likely to be the RISC).
function riscScore(filename) {
  const n = (filename || '').toLowerCase();
  if (/risc|retail.?install|law.?553|553.ca/.test(n)) return 4;
  if (/contract|installment|sales.?contract/.test(n)) return 3;
  if (/agreement/.test(n)) return 2;
  if (/buyer.?guide|sticker|insurance|gap|warranty|odometer|disclosure/.test(n)) return 0;
  return 1;
}

// Walk all fields in an entry object and collect all file download URLs,
// sorted by RISC likelihood based on filename.
function findFileUrlsInEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const found = []; // [{ url, name }]

  for (const [key, value] of Object.entries(entry)) {
    if (!value) continue;
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      found.push({ url: value, name: key });
    } else if (typeof value === 'object' && !Array.isArray(value) && value.url) {
      found.push({ url: value.url, name: value.filename || value.name || key });
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && /^https?:\/\//i.test(item)) found.push({ url: item, name: key });
        else if (item && item.url) found.push({ url: item.url, name: item.filename || item.name || key });
      }
    }
  }

  // Sort highest RISC score first
  return found.sort((a, b) => riscScore(b.name) - riscScore(a.name));
}

// Legacy single-URL helper kept for callers that only need one URL
function findFileUrlInEntry(entry) {
  const urls = findFileUrlsInEntry(entry);
  return urls.length ? urls[0].url : null;
}

async function extractRISCFields(pdfBuffer) {
  const base64Pdf = pdfBuffer.toString('base64');
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: 'You extract data from California RISC contracts (LAW 553-CA) for an auto law firm. FIRST: check if this is a RISC (Retail Installment Sales Contract). If it is NOT a RISC (e.g. Buyer\'s Guide, insurance addendum, GAP waiver, odometer statement), return exactly: {"not_risc":true}. If it IS a RISC, return ONLY valid JSON no markdown: {"buyer_name":"ALL CAPS full name","buyer_address":"full address","dealer_name":"ALL CAPS dealership name","vehicle_year":"4 digits","vehicle_make":"","vehicle_model":"","vehicle_new_used":"New or Used","vin":"17-char VIN","odometer":"numeric","purchase_date":"MM/DD/YYYY from signature page","settlement_amount":"leave blank","settlement_amount_words":"leave blank","down_payment":"numeric only no $ sign","total_sale_price":"","monthly_payment":"","apr":"","miles_driven":"same as odometer","notes":"any flags","missing_fields":[]}',
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

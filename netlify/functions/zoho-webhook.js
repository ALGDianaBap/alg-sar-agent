const https = require('https');
const { getStore } = require('@netlify/blobs');

const SLACK_CHANNEL = 'C09QF0PRLJ2';

const CMS = [
  { name: 'Pedro',     slackId: 'U09QP4Z4KUG' },
  { name: 'Samir',     slackId: 'U09PDBV7287' },
  { name: 'Daniel M',  slackId: 'U09Q7NJ7C5P' },
  { name: 'Gabriel J', slackId: 'U09QP4ZKY0G' },
  { name: 'Linda',     slackId: 'U09PYC93DNY' },
  { name: 'Viena',     slackId: 'U09Q7NGHA0H' },
];

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // GET — frontend fetches pending SARs
  if (event.httpMethod === 'GET') {
    try {
      const store = getStore('sar-queue');
      const { blobs } = await store.list();
      const items = await Promise.all(
        blobs.filter(b => b.key !== 'rr-index').map(async ({ key }) => {
          const data = await store.get(key, { type: 'json' });
          return data ? { id: key, ...data } : null;
        })
      );
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(items.filter(Boolean))
      };
    } catch (e) {
      return { statusCode: 200, headers: cors, body: '[]' };
    }
  }

  // DELETE — frontend marks a SAR as imported
  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (id) {
      try {
        const store = getStore('sar-queue');
        await store.delete(id);
      } catch (e) {}
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  // ── PARSE BODY ────────────────────────────────────────────────────────────
  let body = {};
  const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  try {
    if (ct.includes('application/json')) {
      body = JSON.parse(event.body || '{}');
    } else {
      const params = new URLSearchParams(event.body || '');
      for (const [k, v] of params.entries()) body[k] = v;
    }
  } catch (e) {
    return { statusCode: 400, headers: cors, body: 'Parse error: ' + e.message };
  }

  // ── FIELD EXTRACTION ──────────────────────────────────────────────────────
  // Zoho Forms sends fields under the form field name (set in the form builder).
  // We try every reasonable variation. zohoData is stored raw so mapping can be
  // corrected later without data loss.

  function pick(...keys) {
    for (const k of keys) {
      const v = body[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  // Buyer name — Zoho's "Name" field type splits into First/Last.
  // The form labels it "Dealer Name (first name)" / "Dealer Last Name" which is
  // confusingly named but refers to the CLIENT.
  const buyerFirst = pick(
    'Dealer_Name', 'Name', 'Client_Name', 'First_Name', 'Client_First_Name',
    'Buyer_First_Name', 'Name_First', 'name'
  );
  const buyerLast = pick(
    'Dealer_Last_Name', 'Last_Name', 'Client_Last_Name',
    'Buyer_Last_Name', 'Name_Last', 'lastname'
  );
  const buyer = [buyerFirst, buyerLast].filter(Boolean).join(' ') ||
    pick('Full_Name', 'Client', 'Buyer', 'CustomerName') ||
    'Unknown Buyer';

  const dealer = pick(
    'Dealership_Name', 'Dealer_Name_Company', 'Dealership', 'Dealer',
    'DealershipName', 'dealership_name', 'dealership'
  ) || 'Unknown Dealership';

  const phone = pick('Phone', 'Client_Phone', 'Phone_Number', 'phone', 'Mobile');
  const email = pick('Email', 'Client_Email', 'Email_Address', 'email');

  const langRaw = pick('Language', 'language', 'Preferred_Language');
  const language = /spanish|español|es\b/i.test(langRaw) ? 'es' : 'en';

  const workDesc    = pick('What_are_you_doing_for_the_customer', 'Work_Description', 'Work', 'Description');
  const dealerGiving = pick('Whats_the_dealership_giving_in_return', 'Dealer_Giving', 'What_is_the_dealership_giving');
  const refundNotes  = pick('If_refund_is_partial_or_includes_deductions', 'Refund_Details', 'Deductions');
  const thirdParty   = pick('Third_Party', 'Third_party', 'thirdparty');
  const whoWork      = pick('Who_is_doing_the_work', 'Who_Doing_Work', 'Worker');
  const hasHappened  = pick('Has_this_already_happened', 'Already_Happened');

  const isRescission = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);

  const attachments = (() => {
    const docs = body['Documents_to_Upload'] || body['Documents'] || body['Files'] || body['Attachments'] || '';
    if (!docs) return [];
    if (Array.isArray(docs)) return docs.map(d => ({ name: typeof d === 'string' ? d : (d.name || JSON.stringify(d)) }));
    return String(docs).split(',').map(d => ({ name: d.trim() })).filter(d => d.name);
  })();

  // ── CM ASSIGNMENT (round-robin, counter stored in Blobs) ──────────────────
  let cm = CMS[0];
  try {
    const store = getStore('sar-queue');
    const rr = await store.get('rr-index', { type: 'json' }).catch(() => null);
    const idx = ((rr?.idx) ?? 0) % CMS.length;
    cm = CMS[idx];
    await store.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length }));
  } catch (e) {
    console.error('RR index error:', e.message);
  }

  const dealLabel = isRescission ? 'Rescission' : 'Cash & Keep';
  const langLabel  = language === 'es' ? 'Spanish' : 'English';

  const sarData = {
    created: new Date().toISOString(),
    status: 'new',
    source: 'webhook',
    urgency: 'normal',
    buyer,
    dealer,
    phone,
    email,
    language,
    dealType: isRescission ? 'rescission' : 'cash_keep',
    attachments,
    assignee: cm.name,
    assigneeSlackId: cm.slackId,
    notes: [workDesc, dealerGiving, refundNotes, thirdParty].filter(Boolean).join(' | '),
    zohoData: body   // raw — field names visible here for debugging
  };

  const id = Date.now().toString();

  // Store in Netlify Blobs
  try {
    const store = getStore('sar-queue');
    await store.set(id, JSON.stringify(sarData));
  } catch (e) {
    console.error('Blob storage error:', e.message);
  }

  // ── SLACK: FULL ASSIGNMENT NOTIFICATION ───────────────────────────────────
  const slackText =
    `🆕 *New SAR — Assigned to <@${cm.slackId}>*\n\n` +
    `*Buyer:* ${buyer}\n` +
    `*Dealer:* ${dealer}\n` +
    `*Type:* ${dealLabel} · ${langLabel}\n` +
    (phone ? `*Phone:* ${phone}\n` : '') +
    (workDesc ? `*Work:* ${workDesc}\n` : '') +
    (dealerGiving ? `*Dealer giving:* ${dealerGiving}\n` : '') +
    (attachments.length ? `*Attachments:* ${attachments.map(a => a.name).join(', ')}\n` : '') +
    `\nOpen the SAR Agent to process.`;

  // Temporary debug block — shows raw Zoho field keys so mapping can be verified.
  // Remove this block once field names are confirmed correct.
  const fieldDump = Object.keys(body).slice(0, 20).join(', ');
  const debugText = `🔍 *Debug — Zoho field keys received:*\n\`${fieldDump}\`\n_Remove this block from zoho-webhook.js once field names are confirmed._`;

  try {
    await postSlack(SLACK_CHANNEL, slackText);
    await postSlack(SLACK_CHANNEL, debugText);
  } catch (e) {
    console.error('Slack error:', e.message);
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, id, assignedTo: cm.name })
  };
};

// ── HELPERS ────────────────────────────────────────────────────────────────────

async function getNextCMIndex(store) {
  const rr = await store.get('rr-index', { type: 'json' }).catch(() => null);
  return (rr?.idx ?? 0) % CMS.length;
}

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();

  const body = JSON.stringify({
    channel,
    text: text.replace(/\*|_|`/g, '').slice(0, 100),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body))
      }
    };
    const req = https.request(options, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

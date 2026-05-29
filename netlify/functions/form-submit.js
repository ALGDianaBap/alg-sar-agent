/**
 * Native SAR intake — fast intake only (< 2s, no RISC extraction).
 * Only requires built-in Node 'https'. All optional dependencies loaded
 * inline with try/catch so a missing module never prevents the handler
 * from returning a proper JSON response.
 */

const https = require('https');

// Load @netlify/blobs gracefully — failure degrades to no-storage, not a crash
let blobsAvailable = false;
let _getStore;
try {
  const { getStore } = require('@netlify/blobs');
  _getStore = (name) => {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_TOKEN;
    return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
  };
  blobsAvailable = true;
} catch (e) {
  console.warn('form-submit: @netlify/blobs not available:', e.message);
}

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  // Everything inside one big try/catch — guaranteed JSON response
  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const {
      dealerNameFirst = '', dealerNameLast = '', dealershipName = '',
      phone = '', email = '', workDesc = '', language = 'en',
      hasHappened = '', whoWork = '', thirdParty = '',
      dealerGiving = '', refundNotes = '', files = [],
    } = body;

    if (!dealerNameFirst || !dealerNameLast || !dealershipName || !workDesc) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const buyer   = `${dealerNameFirst} ${dealerNameLast}`.toUpperCase();
    const dealer  = dealershipName.toUpperCase();
    const isResc  = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);
    const id      = Date.now().toString();

    // ── Assign CM ─────────────────────────────────────────────────────────
    let cm = CMS[0];
    if (blobsAvailable) {
      try {
        const s   = _getStore('sar-meta');
        const rr  = await s.get('rr-index', { type: 'json' }).catch(() => null);
        const idx = ((rr?.idx) ?? 0) % CMS.length;
        cm = CMS[idx];
        await s.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length }));
      } catch (e) { console.warn('RR index error:', e.message); }
    }

    const attachments = (files || []).map(f => ({ name: f.name, source: 'native-form', extracted: false }));

    // ── Store uploaded files ───────────────────────────────────────────────
    let hasStoredFiles = false;
    if (blobsAvailable && files.length > 0) {
      try {
        await _getStore('form-files').set(id, JSON.stringify(files));
        hasStoredFiles = true;
      } catch (e) { console.warn('File storage failed:', e.message); }
    }

    // ── Build SAR record ──────────────────────────────────────────────────
    const sarData = {
      id, created: new Date().toISOString(),
      status: 'new', source: 'native-form', urgency: 'normal',
      buyer, dealer, phone, email, language,
      dealType: isResc ? 'rescission' : 'cash_keep',
      vehicle: '', vin: '', amount: '',
      attachments, hasStoredFiles,
      fields: null, matter: null,
      assignee: cm.name, assigneeSlackId: cm.slackId,
      attorney: null, attorneySlackId: null,
      draftBase64: null, draftFilename: null,
      zohoContext: { workDesc, dealerGiving, refundNotes, hasHappened, whoWork, thirdParty, priorRepairs: '' },
      notes: [workDesc, dealerGiving, refundNotes, thirdParty].filter(Boolean).join(' | '),
      reviewNotes: '', timeEntries: [],
    };

    if (blobsAvailable) {
      try {
        await _getStore('sar-records').set(id, JSON.stringify(sarData));
      } catch (e) { console.warn('SAR record storage failed:', e.message); }
    }

    // ── Slack ─────────────────────────────────────────────────────────────
    const dealLabel = isResc ? 'Rescission' : 'Cash & Keep';
    const langLabel = language === 'es' ? 'Spanish' : 'English';
    const fileNames = attachments.map(a => a.name).join(', ') || '—';
    const ctxLines  = [workDesc, dealerGiving].filter(Boolean).map(l => `> ${l.slice(0, 100)}`).join('\n');

    const slackText =
      `📋 *New SAR — <@${cm.slackId}> assigned*\n\n` +
      `*Dealer Name:* ${buyer}\n*Dealership:* ${dealer}\n` +
      `*Type:* ${dealLabel} · ${langLabel}\n*Phone:* ${phone || '—'}\n` +
      (ctxLines ? `\n*From form:*\n${ctxLines}\n` : '') +
      `\n📎 ${fileNames}\n▶️ Open SAR Agent → Run Agent to extract and generate draft`;

    await postSlack(SLACK_CHANNEL, slackText).catch(e => console.warn('Slack:', e.message));

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id, ref: id.slice(-6) }),
    };

  } catch (e) {
    console.error('form-submit caught:', e.message, e.stack);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message || 'Server error' }),
    };
  }
};

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();
  const body = JSON.stringify({
    channel, text: text.replace(/[*_`>]/g, '').slice(0, 80),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    };
    const req = https.request(opts, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body); req.end();
  });
}

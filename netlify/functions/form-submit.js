/**
 * Native SAR intake form — fast intake only.
 *
 * Deliberately does NOT run RISC extraction or docx generation here.
 * Those operations take 15-20s and would timeout (Netlify free = 10s limit).
 *
 * What this does (all < 2 seconds):
 *   1. Parse and validate form fields
 *   2. Store uploaded PDFs in Blobs (form-files/{id}) for the agent to use
 *   3. Create SAR record in sar-records
 *   4. Assign next CM via round-robin
 *   5. Send Slack notification
 *   6. Return { ok, ref } immediately
 *
 * When the CM opens the SAR and clicks "Run Agent", the app fetches the
 * stored PDFs via /.netlify/functions/get-files?id={sarId} and runs
 * extraction in the browser — no server timeout constraint.
 */

const https = require('https');
const { store: getStore } = require('./_blobs');

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
    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const {
      dealerNameFirst, dealerNameLast, dealershipName,
      phone, email, workDesc, language = 'en',
      hasHappened = '', whoWork = '', thirdParty = '',
      dealerGiving = '', refundNotes = '',
      files = [],
    } = body;

    if (!dealerNameFirst || !dealerNameLast || !dealershipName || !workDesc) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const buyer  = `${dealerNameFirst} ${dealerNameLast}`.toUpperCase();
    const dealer = dealershipName.toUpperCase();
    const isRescission = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);
    const id = Date.now().toString();

    // ── Store uploaded files in Blobs for agent retrieval ─────────────────
    const attachments = [];
    if (files.length > 0) {
      try {
        const fileStore = getStore('form-files');
        await fileStore.set(id, JSON.stringify(files)); // files = [{name, type, data (base64)}]
        files.forEach(f => attachments.push({ name: f.name, source: 'native-form', extracted: false }));
      } catch (e) {
        console.error('File storage error:', e.message);
        files.forEach(f => attachments.push({ name: f.name, source: 'native-form', extracted: false }));
      }
    }

    // ── Assign CM ─────────────────────────────────────────────────────────
    let cm = CMS[0];
    try {
      const s = getStore('sar-meta');
      const rr = await s.get('rr-index', { type: 'json' }).catch(() => null);
      const idx = ((rr?.idx) ?? 0) % CMS.length;
      cm = CMS[idx];
      await s.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length }));
    } catch (e) { console.error('RR error:', e.message); }

    // ── Create SAR record ─────────────────────────────────────────────────
    const sarData = {
      id,
      created: new Date().toISOString(),
      status: 'new',
      source: 'native-form',
      urgency: 'normal',
      buyer, dealer,
      phone: phone || '', email: email || '',
      language, dealType: isRescission ? 'rescission' : 'cash_keep',
      vehicle: '', vin: '', amount: '',
      attachments,
      hasStoredFiles: files.length > 0, // flag so app knows to fetch files
      fields: null,
      matter: null,
      assignee: cm.name, assigneeSlackId: cm.slackId,
      attorney: null, attorneySlackId: null,
      draftBase64: null, draftFilename: null,
      zohoContext: { workDesc, dealerGiving, refundNotes, hasHappened, whoWork, thirdParty, priorRepairs: '' },
      notes: [workDesc, dealerGiving, refundNotes, thirdParty].filter(Boolean).join(' | '),
      reviewNotes: '', timeEntries: [],
    };

    try {
      await getStore('sar-records').set(id, JSON.stringify(sarData));
    } catch (e) { console.error('SAR store error:', e.message); }

    // ── Slack notification ────────────────────────────────────────────────
    const dealLabel = isRescission ? 'Rescission' : 'Cash & Keep';
    const langLabel = language === 'es' ? 'Spanish' : 'English';
    const fileNames = attachments.map(a => a.name).join(', ') || '—';
    const contextLines = [workDesc, dealerGiving].filter(Boolean).map(l => `> ${l.slice(0, 120)}`).join('\n');

    const slackText =
      `📋 *New SAR — <@${cm.slackId}> assigned*\n\n` +
      `*Dealer Name:* ${buyer}\n` +
      `*Dealership:* ${dealer}\n` +
      `*Type:* ${dealLabel} · ${langLabel}\n` +
      `*Phone:* ${phone || '—'}\n` +
      (contextLines ? `\n*From form:*\n${contextLines}\n` : '') +
      `\n📎 Files uploaded: ${fileNames}\n` +
      `▶️ *Open SAR Agent → Run Agent to extract RISC and generate draft*`;

    try { await postSlack(SLACK_CHANNEL, slackText); }
    catch (e) { console.error('Slack error:', e.message); }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id, ref: id.slice(-6) }),
    };

  } catch (e) {
    console.error('form-submit error:', e.message, e.stack);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();
  const body = JSON.stringify({
    channel, text: text.replace(/[*_`>]/g, '').slice(0, 100),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    };
    const req = https.request(opts, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body); req.end();
  });
}

/**
 * Native SAR intake — fast intake only.
 * Every async op has an explicit timeout so the function always responds
 * before Netlify's 10s limit, regardless of Blobs/Slack latency.
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

// Hard cap on any single async op — prevents silent hangs from causing 502
const cap = (promise, ms = 4000) =>
  Promise.race([promise, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))]);

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const {
      contactName = '',
      dealerNameFirst = '', dealerNameLast = '', dealershipName = '',
      phone = '', email = '', workDesc = '', language = 'en',
      hasHappened = '', whoWork = '', thirdParty = '',
      dealerGiving = '', refundNotes = '', fileNames = [],
    } = body;

    if (!contactName || !dealerNameFirst || !dealerNameLast || !dealershipName || !workDesc) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const buyer  = `${dealerNameFirst} ${dealerNameLast}`.toUpperCase();
    const dealer = dealershipName.toUpperCase();
    const isResc = /rescission|rescind|return.*vehicle|unwind/i.test(workDesc + dealerGiving);
    const id     = Date.now().toString();

    // ── CM round-robin (with timeout) ─────────────────────────────────────
    let cm = CMS[0];
    try {
      const s   = getStore('sar-meta');
      const rr  = await cap(s.get('rr-index', { type: 'json' }), 3000).catch(() => null);
      const idx = ((rr?.idx) ?? 0) % CMS.length;
      cm = CMS[idx];
      await cap(s.set('rr-index', JSON.stringify({ idx: (idx + 1) % CMS.length })), 3000).catch(() => {});
    } catch (e) { console.warn('RR:', e.message); }

    // ── SAR record (with timeout) ──────────────────────────────────────────
    const sarData = {
      id, created: new Date().toISOString(),
      status: 'new', source: 'native-form', urgency: 'normal',
      buyer, dealer, contactName, phone, email, language,
      dealType: isResc ? 'rescission' : 'cash_keep',
      vehicle: '', vin: '', amount: '',
      attachments: fileNames.map(n => ({ name: n, source: 'native-form', extracted: false })),
      hasStoredFiles: fileNames.length > 0,
      fields: null, matter: null,
      assignee: cm.name, assigneeSlackId: cm.slackId,
      attorney: null, attorneySlackId: null,
      draftBase64: null, draftFilename: null,
      zohoContext: { workDesc, dealerGiving, refundNotes, hasHappened, whoWork, thirdParty, priorRepairs: '' },
      notes: [workDesc, dealerGiving, refundNotes, thirdParty].filter(Boolean).join(' | '),
      reviewNotes: '', timeEntries: [],
    };

    await cap(getStore('sar-records').set(id, JSON.stringify(sarData)), 4000)
      .catch(e => console.warn('SAR store failed:', e.message));

    // ── Slack (with timeout) ───────────────────────────────────────────────
    const dealLabel = isResc ? 'Rescission' : 'Cash & Keep';
    const langLabel = language === 'es' ? 'Spanish' : 'English';
    const ctx = [workDesc, dealerGiving].filter(Boolean).map(l => `> ${l.slice(0, 100)}`).join('\n');
    const slackText =
      `📋 *New SAR Assignment*\n\nYou've been assigned a new Settlement Agreement Request.\n\n` +
      `*Dealer Name:* ${buyer}\n*Dealership:* ${dealer}\n` +
      `*Type:* ${dealLabel} · ${langLabel}\n*Phone:* ${phone || '—'}\n` +
      `*Submitted by:* ${contactName || '—'}\n` +
      (ctx ? `\n*From form:*\n${ctx}\n` : '') +
      (fileNames.length ? `\n📎 ${fileNames.join(', ')}\n` : '') +
      `▶️ Open SAR Agent → Run Agent to extract and generate draft`;

    // DM the assigned CM directly, AND always post to the public channel too
    // — the whole legal team needs visibility into every new SAR as it comes in.
    await cap(postSlack(cm.slackId, slackText), 4000)
      .catch(e => console.warn('Slack DM failed:', e.message));
    const publicText =
      `📋 *New SAR — assigned to ${cm.name}*\n\n` +
      `*Dealer Name:* ${buyer}\n*Dealership:* ${dealer}\n` +
      `*Type:* ${dealLabel} · ${langLabel}\n*Phone:* ${phone || '—'}\n` +
      `*Submitted by:* ${contactName || '—'}`;
    await cap(postSlack(SLACK_CHANNEL, publicText), 4000)
      .catch(e => console.warn('Slack public post failed:', e.message));

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id, ref: id.slice(-6) }),
    };

  } catch (e) {
    console.error('form-submit error:', e.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();
  const body = JSON.stringify({ channel, text: text.slice(0, 80), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body); req.end();
  });
}

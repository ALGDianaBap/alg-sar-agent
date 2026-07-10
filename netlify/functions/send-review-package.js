/**
 * Sends the reviewing attorney a single, self-contained Slack DM: the
 * draft .docx, a plain case-summary PDF, and every original document the
 * client/dealership uploaded — so the attorney never has to open the SAR
 * Agent app just to see what they're reviewing.
 *
 * Best-effort: each file uploads independently (one failure doesn't block
 * the others), and the message always lists every expected document with
 * a ✓/✗ so a failed attachment is visible, never silent. If every file
 * upload fails outright, a plain text message still goes out.
 */
const https = require('https');
const PDFDocument = require('pdfkit');
const { store: getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'SLACK_BOT_TOKEN not set' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { id } = payload;
  if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id' }) };

  try {
    const sar = await getStore('sar-records').get(String(id), { type: 'json' }).catch(() => null);
    if (!sar) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'SAR not found' }) };
    if (!sar.attorneySlackId) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: 'no attorney assigned' }) };
    }

    // files.completeUploadExternal needs a real conversation id, not a raw
    // user id — unlike chat.postMessage, which auto-opens a DM when given
    // one. Passing a bare user id here silently "succeeds" (no error, no
    // thrown exception) but the file never actually attaches anywhere,
    // which is exactly the failure mode this was built to fix.
    const dmChannel = await resolveDmChannel(token, sar.attorneySlackId);

    // Every file this case is supposed to have.
    const wanted = [];
    if (sar.draftBase64) {
      wanted.push({ name: sar.draftFilename || 'Draft.docx', buffer: Buffer.from(sar.draftBase64, 'base64') });
    }
    wanted.push({ name: 'Submission_Summary.pdf', buffer: await buildSummaryPdf(sar) });

    const stored = await getStore('form-files').get(String(id), { type: 'json' }).catch(() => null);
    if (Array.isArray(stored)) {
      for (const f of stored) {
        if (f && f.data) wanted.push({ name: f.name, buffer: Buffer.from(f.data, 'base64') });
      }
    }

    const results = await Promise.allSettled(wanted.map(f => uploadFileToSlack(token, f.name, f.buffer)));

    const uploaded = []; // { id, name }
    const checklist = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        uploaded.push({ id: r.value, name: wanted[i].name });
        checklist.push(`✓ ${wanted[i].name}`);
      } else {
        checklist.push(`✗ ${wanted[i].name} (failed to attach)`);
        console.warn('Upload failed for', wanted[i].name, r.reason && r.reason.message);
      }
    });

    const summaryText = buildSummaryText(sar, checklist);

    // Slack's files.completeUploadExternal only accepts a plain-text
    // initial_comment (no Block Kit buttons) — so the files go out with a
    // short caption, and the full summary + Approve button always follows
    // as its own message, regardless of whether any file upload succeeded.
    if (uploaded.length) {
      await completeUploadExternal(token, uploaded, dmChannel, 'Documents for your review below:');
    }
    await postMessageWithApprove(token, dmChannel, summaryText, sar.id);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, filesSent: uploaded.length, filesTotal: wanted.length }),
    };
  } catch (e) {
    console.error('send-review-package error:', e.message);
    // Last-resort fallback: try to at least get a plain text DM out.
    // chat.postMessage tolerates a raw user id as the channel (unlike the
    // file-sharing calls above), so this doesn't need dmChannel resolved.
    try {
      const sar = await getStore('sar-records').get(String(id), { type: 'json' }).catch(() => null);
      if (sar && sar.attorneySlackId) {
        await postMessageWithApprove(token, sar.attorneySlackId, buildSummaryText(sar, ['✗ Could not prepare documents — check the SAR Agent app']), sar.id);
      }
    } catch (e2) { console.error('send-review-package fallback also failed:', e2.message); }
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
  }
};

// ── SUMMARY PDF ────────────────────────────────────────────────────────────
function buildSummaryPdf(sar) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const zc = sar.zohoContext || {};
    const f = sar.fields || {};

    const section = (title) => { doc.moveDown(0.6); doc.fontSize(12).fillColor('#000').text(title, { underline: true }); doc.moveDown(0.2); };
    const row = (label, value) => { doc.fontSize(10).fillColor('#000').text(`${label}: `, { continued: true }).fillColor('#333').text(String(value || '—')); };

    doc.fontSize(16).fillColor('#000').text('Settlement Agreement Request — Case Summary');
    doc.fontSize(9).fillColor('#666').text(`Case #${String(sar.id || '').slice(-6)} · Created ${sar.created ? new Date(sar.created).toLocaleDateString() : '—'}`);

    section('Buyer & Dealer');
    row('Buyer', sar.buyer);
    row('Dealer', sar.dealer);
    row('Contact Name', sar.contactName);
    row('Phone', sar.phone);
    row('Email', sar.email);

    section('Deal');
    row('Type', sar.dealType === 'rescission' ? 'Rescission' : 'Cash & Keep');
    row('Language', sar.language === 'es' ? 'Spanish' : 'English');
    row('Vehicle', sar.vehicle);
    row('VIN', sar.vin);
    row('Settlement Amount', sar.amount ? `$${sar.amount}` : '');
    row('Down Payment', f.down_payment ? `$${f.down_payment}` : '');
    row('Purchase Date', f.purchase_date);

    section('Submission Details');
    row('What is being done for the customer', zc.workDesc);
    row("What the dealership is giving", zc.dealerGiving);
    row('Refund/deduction notes', zc.refundNotes);
    row('Has this already happened', zc.hasHappened);
    row('Who is doing the work', zc.whoWork);
    row('Third party', zc.thirdParty);

    if (sar.reviewNotes) {
      section('Notes from Case Manager');
      doc.fontSize(10).fillColor('#333').text(sar.reviewNotes);
    }

    doc.end();
  });
}

function buildSummaryText(sar, checklist) {
  const dealLabel = sar.dealType === 'rescission' ? 'Rescission' : 'Cash & Keep';
  const langLabel = sar.language === 'es' ? 'Spanish' : 'English';
  return `*SAR Ready for Review*\n\n*Buyer:* ${sar.buyer}\n*Dealer:* ${sar.dealer}\n*Vehicle:* ${sar.vehicle || '—'}${sar.vin ? ' (VIN: ' + sar.vin + ')' : ''}\n*Type:* ${dealLabel} · ${langLabel}\n${sar.amount ? '*Settlement:* $' + sar.amount + '\n' : ''}*CM:* ${sar.assignee || '—'}\n${sar.reviewNotes ? '*Notes from CM:* ' + sar.reviewNotes + '\n' : ''}\n*Documents:*\n${checklist.map(c => '• ' + c).join('\n')}`;
}

// ── SLACK HELPERS ────────────────────────────────────────────────────────────
function slackApi(token, path, body, mode) {
  return new Promise((resolve, reject) => {
    const isJson = mode === 'json';
    const payloadBuf = Buffer.from(isJson ? JSON.stringify(body) : body);
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/' + path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        'Content-Length': payloadBuf.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad Slack response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Slack API timeout: ' + path)));
    req.write(payloadBuf);
    req.end();
  });
}

function httpPostRaw(url, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': buffer.length },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Slack upload timeout')));
    req.write(buffer);
    req.end();
  });
}

async function resolveDmChannel(token, userId) {
  const resp = await slackApi(token, 'conversations.open', { users: userId }, 'json');
  if (!resp.ok) throw new Error('conversations.open failed: ' + (resp.error || 'unknown'));
  return resp.channel.id;
}

async function uploadFileToSlack(token, filename, buffer) {
  const params = new URLSearchParams({ filename, length: String(buffer.length) }).toString();
  const getUrlResp = await slackApi(token, 'files.getUploadURLExternal', params, 'form');
  if (!getUrlResp.ok) throw new Error('getUploadURLExternal failed: ' + (getUrlResp.error || 'unknown'));
  const { upload_url, file_id } = getUrlResp;
  const uploadResp = await httpPostRaw(upload_url, buffer, 'application/octet-stream');
  if (uploadResp.status < 200 || uploadResp.status >= 300) throw new Error('File upload PUT failed: HTTP ' + uploadResp.status);
  return file_id;
}

async function completeUploadExternal(token, uploaded, channelId, initialComment) {
  const resp = await slackApi(token, 'files.completeUploadExternal', {
    files: uploaded.map(u => ({ id: u.id, title: u.name })),
    channel_id: channelId,
    initial_comment: initialComment,
  }, 'json');
  if (!resp.ok) throw new Error('completeUploadExternal failed: ' + (resp.error || 'unknown'));
  return resp;
}

async function postMessageWithApprove(token, channel, text, sarId) {
  return slackApi(token, 'chat.postMessage', {
    channel,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve — No Corrections Needed', emoji: true },
          style: 'primary',
          action_id: 'approve_review',
          value: String(sarId),
        }],
      },
    ],
  }, 'json');
}

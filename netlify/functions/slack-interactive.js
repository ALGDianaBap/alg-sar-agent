/**
 * Combined Slack Interactivity + Events API endpoint — lets an attorney
 * approve or correct a case directly from Slack, without opening the SAR
 * Agent dashboard.
 *
 * Two request shapes land here (Diana points both Slack app settings at
 * this same URL):
 *   - Interactivity (button clicks): application/x-www-form-urlencoded
 *     body with a `payload` field containing JSON (`type: block_actions`).
 *   - Events API: raw JSON body. Includes the one-time `url_verification`
 *     handshake (must echo back {challenge}) and `message` events.
 *
 * Every request is verified against Slack's HMAC signature scheme before
 * any processing — see verifySlackSignature().
 */
const https = require('https');
const crypto = require('crypto');
const { store: getStore } = require('./_blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!signingSecret || !token) return { statusCode: 500, body: 'Slack env vars not set' };

  if (!verifySlackSignature(event, signingSecret)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      // Interactivity: a button click.
      const params = new URLSearchParams(event.body);
      const payload = JSON.parse(params.get('payload') || '{}');
      if (payload.type === 'block_actions') {
        await handleBlockAction(token, payload);
      }
      return { statusCode: 200, body: '' };
    }

    // Events API (raw JSON).
    const body = JSON.parse(event.body || '{}');

    if (body.type === 'url_verification') {
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: body.challenge };
    }

    if (body.type === 'event_callback' && body.event) {
      // Ack Slack immediately in spirit — this still runs synchronously,
      // but every step below is fast (Blobs + a couple of Slack calls),
      // and reprocessing a retry is safe (idempotency guards below).
      await handleMessageEvent(token, body.event);
    }

    return { statusCode: 200, body: '' };
  } catch (e) {
    console.error('slack-interactive error:', e.message);
    // Always 200 back to Slack — a 500 just triggers pointless retries of
    // an event we already logged as failed.
    return { statusCode: 200, body: '' };
  }
};

function verifySlackSignature(event, signingSecret) {
  const h = event.headers || {};
  const timestamp = h['x-slack-request-timestamp'] || h['X-Slack-Request-Timestamp'];
  const signature = h['x-slack-signature'] || h['X-Slack-Signature'];
  if (!timestamp || !signature) return false;
  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${event.body || ''}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) {
    return false; // length mismatch etc.
  }
}

// ── BUTTON CLICK: approve_review ──────────────────────────────────────────
async function handleBlockAction(token, payload) {
  const action = (payload.actions || [])[0];
  if (!action || action.action_id !== 'approve_review') return;

  const sarId = action.value;
  const store = getStore('sar-records');
  const sar = await store.get(sarId, { type: 'json' });
  if (!sar) return;

  // Only the assigned attorney can approve their own case.
  if (payload.user?.id !== sar.attorneySlackId) {
    if (payload.response_url) {
      await postToResponseUrl(payload.response_url, { text: "Only the assigned attorney can approve this case.", replace_original: false });
    }
    return;
  }

  // Idempotency — a Slack retry or double-click shouldn't reprocess.
  if (sar.status === 'approved' || sar.status === 'sent') {
    if (payload.response_url) {
      await postToResponseUrl(payload.response_url, { text: `Already marked ${sar.status === 'sent' ? 'sent' : 'reviewed'} — no action needed.`, replace_original: false });
    }
    return;
  }

  const updated = { ...sar, status: 'approved', id: sarId };
  await store.set(sarId, JSON.stringify(updated));

  const cm = updated.assigneeSlackId;
  if (cm) {
    await postMessage(token, cm, `✅ *Attorney Approved*\n\n*Case:* ${updated.buyer} vs. ${updated.dealer}\n*Attorney:* ${updated.attorney || '—'}\n\nApproved directly from Slack — no corrections needed. Ready to send.`);
  }

  if (payload.response_url) {
    await postToResponseUrl(payload.response_url, {
      replace_original: true,
      text: `✅ Approved by ${updated.attorney || 'attorney'} — ${updated.buyer} vs. ${updated.dealer}. CM notified.`,
    });
  }
}

// ── MESSAGE EVENT: attorney replies with a corrected file ─────────────────
async function handleMessageEvent(token, msgEvent) {
  // Ignore our own posts (including the original review DM) and anything
  // without an actual file attached.
  if (msgEvent.bot_id || msgEvent.subtype === 'bot_message') return;
  if (!Array.isArray(msgEvent.files) || !msgEvent.files.length) return;

  const senderSlackId = msgEvent.user;
  if (!senderSlackId) return;

  const store = getStore('sar-records');
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map(async ({ key }) => {
    const data = await store.get(key, { type: 'json' });
    return data ? { ...data, id: key } : null;
  }));
  const pending = all.filter(s => s && s.status === 'review' && s.attorneySlackId === senderSlackId);

  const replyChannel = msgEvent.channel;
  const replyThread = msgEvent.thread_ts || msgEvent.ts;

  if (!pending.length) {
    await postMessage(token, replyChannel, "I don't see a case currently pending your review — check the SAR Agent app.", replyThread);
    return;
  }

  if (pending.length > 1) {
    const names = pending.map(s => `${s.buyer} vs. ${s.dealer}`).join('\n• ');
    await postMessage(token, replyChannel, `You have more than one case pending review:\n• ${names}\n\nReply with the buyer's last name so I know which one this correction is for.`, replyThread);
    return;
  }

  const sar = pending[0];
  const file = msgEvent.files[0];

  let fileBuffer;
  try {
    fileBuffer = await downloadSlackFile(token, file.url_private_download || file.url_private);
  } catch (e) {
    await postMessage(token, replyChannel, `Got your file but couldn't download it from Slack (${e.message}) — please try attaching it again or use the SAR Agent app.`, replyThread);
    return;
  }

  const updated = {
    ...sar,
    approvedDraftBase64: fileBuffer.toString('base64'),
    approvedDraftFilename: file.name || 'Corrected_Draft.docx',
    status: 'approved',
    id: sar.id,
  };
  await store.set(sar.id, JSON.stringify(updated));

  if (updated.assigneeSlackId) {
    await postMessage(token, updated.assigneeSlackId, `✅ *Attorney Sent Corrections*\n\n*Case:* ${updated.buyer} vs. ${updated.dealer}\n*Attorney:* ${updated.attorney || '—'}\n\nA corrected draft was received via Slack and is ready to send.`);
  }

  await postMessage(token, replyChannel, `✅ Got it — marked ${updated.buyer} vs. ${updated.dealer} as reviewed. The CM has been notified.`, replyThread);
}

// ── SLACK HELPERS ────────────────────────────────────────────────────────────
function postToResponseUrl(responseUrl, body) {
  return new Promise((resolve) => {
    const u = new URL(responseUrl);
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.setTimeout(5000, () => req.destroy());
    req.write(payload);
    req.end();
  });
}

function postMessage(token, channel, text, threadTs) {
  return new Promise((resolve) => {
    const body = { channel, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
    if (threadTs) body.thread_ts = threadTs;
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', () => resolve());
    req.setTimeout(8000, () => req.destroy());
    req.write(payload);
    req.end();
  });
}

function downloadSlackFile(token, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadSlackFile(token, res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('download timeout')));
    req.end();
  });
}

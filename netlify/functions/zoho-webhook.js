const https = require('https');
const { getStore } = require('@netlify/blobs');

const SLACK_CHANNEL = 'C09QF0PRLJ2';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  // GET — frontend polling for pending SARs
  if (event.httpMethod === 'GET') {
    try {
      const store = getStore('sar-queue');
      const { blobs } = await store.list();
      const items = await Promise.all(
        blobs.map(async ({ key }) => {
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

  // POST — receive from Zoho Forms
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  let body = {};
  const ct = (event.headers['content-type'] || '').toLowerCase();
  try {
    if (ct.includes('application/json')) {
      body = JSON.parse(event.body || '{}');
    } else {
      // URL-encoded form data
      const params = new URLSearchParams(event.body || '');
      for (const [k, v] of params.entries()) body[k] = v;
    }
  } catch (e) {
    return { statusCode: 400, headers: cors, body: 'Parse error: ' + e.message };
  }

  // Map Zoho fields to SAR record
  // Zoho field names depend on the form config — handle common variations
  const buyer = [
    body['Name'], body['Client_Name'], body['Buyer_Name'],
    [body['First_Name'], body['Last_Name']].filter(Boolean).join(' '),
  ].find(v => v && v.trim()) || 'Unknown';

  const dealer = body['Dealership_Name'] || body['Dealer_Name'] || body['Dealership'] || 'Unknown Dealership';

  const language = (() => {
    const lang = (body['Language'] || body['language'] || '').toLowerCase();
    return lang.includes('spanish') || lang.includes('español') ? 'es' : 'en';
  })();

  // Detect deal type from Zoho answers
  const workDesc = body['What_are_you_doing_for_the_customer'] || body['Work_Description'] || '';
  const dealerGiving = body['Whats_the_dealership_giving_in_return'] || body['Dealer_Giving'] || '';
  const isRescission = /rescission|rescind|return|unwind/i.test(workDesc + dealerGiving);

  const attachments = (() => {
    const docs = body['Documents_to_Upload'] || body['Documents'] || '';
    if (!docs) return [];
    if (Array.isArray(docs)) return docs.map(d => ({ name: d }));
    return String(docs).split(',').map(d => ({ name: d.trim() })).filter(d => d.name);
  })();

  const sarData = {
    created: new Date().toISOString(),
    status: 'new',
    source: 'webhook',
    urgency: 'normal',
    buyer: buyer.trim(),
    dealer: dealer.trim(),
    phone: body['Phone'] || body['Client_Phone'] || '',
    email: body['Email'] || body['Client_Email'] || '',
    language,
    dealType: isRescission ? 'rescission' : 'cash_keep',
    attachments,
    notes: [
      body['What_are_you_doing_for_the_customer'],
      body['Whats_the_dealership_giving_in_return'],
      body['If_refund_is_partial_or_includes_deductions'],
      body['Third_Party'],
    ].filter(Boolean).join(' | '),
    zohoData: body
  };

  const id = Date.now().toString();

  // Store in Netlify Blobs
  try {
    const store = getStore('sar-queue');
    await store.set(id, JSON.stringify(sarData));
  } catch (e) {
    console.error('Blob storage error:', e.message);
  }

  // Notify Slack
  const dealLabel = isRescission ? 'Rescission' : 'Cash & Keep';
  const langLabel = language === 'es' ? 'Spanish' : 'English';
  const slackText = `🆕 *New SAR from Zoho*\n\n*Buyer:* ${sarData.buyer}\n*Dealer:* ${sarData.dealer}\n*Type:* ${dealLabel} · ${langLabel}\n${workDesc ? '*Work:* ' + workDesc + '\n' : ''}${attachments.length ? '*Attachments:* ' + attachments.map(a=>a.name).join(', ') + '\n' : ''}\nOpen the SAR Agent to assign and process.`;

  try {
    await postSlack(SLACK_CHANNEL, slackText);
  } catch (e) {
    console.error('Slack error:', e.message);
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, id })
  };
};

function postSlack(channel, text) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return Promise.resolve();

  const body = JSON.stringify({
    channel,
    text: 'New SAR from Zoho',
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
    const req = https.request(options, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

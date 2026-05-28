const https = require('https');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'SLACK_BOT_TOKEN not set' }) };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }

  const { channel, text, blocks } = payload;
  if (!channel) return { statusCode: 400, headers: cors, body: 'Missing channel' };

  // CRITICAL: Use blocks format so <@UXXXX> mentions render correctly.
  // Plain text field alone does NOT render @mentions in Slack.
  const slackPayload = JSON.stringify({
    channel,
    text: text || ' ',
    blocks: blocks || [{ type: 'section', text: { type: 'mrkdwn', text: text || ' ' } }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(slackPayload))
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) });
    });

    req.write(slackPayload);
    req.end();
  });
};

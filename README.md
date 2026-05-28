# ALG SAR Agent

Settlement Agreement Request automation tool for Auto Legal Group, LLP.

## Netlify Functions
- `clio-token.js` — Clio OAuth code → token exchange
- `clio-api.js` — Clio API proxy (GET + POST, handles CORS)
- `ai.js` — Anthropic API proxy
- `slack-notify.js` — Slack notifications with @mention support
- `generate-docx.js` — Pre-filled SAR .docx generation
- `zoho-webhook.js` — Zoho Forms webhook receiver

## Environment Variables (set in Netlify)
- `ANTHROPIC_API_KEY` — Anthropic API key
- `SLACK_BOT_TOKEN` — Slack bot token (xoxb-...)

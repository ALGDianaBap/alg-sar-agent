/**
 * Compares the original AI-generated draft against the attorney's
 * corrected version and returns a highlighted word-level diff, so a CM can
 * see exactly what changed without opening both Word files side by side.
 */
const PizZip = require('pizzip');
const Diff = require('diff');
const { store: getStore } = require('./_blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id' }) };

    const record = await getStore('sar-records').get(id, { type: 'json' });
    if (!record) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'SAR not found' }) };

    const original = record.draftBase64;
    const corrected = record.approvedDraftBase64;
    if (!original || !corrected) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ changed: false }) };
    }

    let originalText, correctedText;
    try {
      originalText = extractDocxText(original);
      correctedText = extractDocxText(corrected);
    } catch (e) {
      // Attorney's file may not be a valid .docx (e.g. a scanned PDF) — diffing
      // isn't possible, but that's not an error the CM needs to see as a failure.
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ changed: false, unreadable: true }) };
    }

    if (originalText.trim() === correctedText.trim()) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ changed: false }) };
    }

    const parts = Diff.diffWords(originalText, correctedText);
    const html = parts.map(part => {
      const text = esc(part.value);
      if (part.added) return `<ins style="background:#d4f4dd;color:#1a6b34;text-decoration:none;padding:1px 2px;border-radius:2px">${text}</ins>`;
      if (part.removed) return `<del style="background:#fde2e1;color:#9b2c2c;padding:1px 2px;border-radius:2px">${text}</del>`;
      return text;
    }).join('');

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ changed: true, html }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

// Reads word/document.xml out of the .docx zip container and returns plain
// text with paragraph breaks preserved — enough fidelity for a word-level diff.
function extractDocxText(base64) {
  const zip = new PizZip(Buffer.from(base64, 'base64'));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Not a valid .docx');
  const xml = file.asText();
  const paragraphs = xml.split(/<\/w:p>/).map(p => {
    const runs = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
    return runs.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }).filter(Boolean);
  return paragraphs.join('\n');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

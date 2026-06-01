const { buildDocument, Packer } = require('./_docx-builder');
const { store: getStore } = require('./_blobs');

// Loaded lazily — only available after npm install adds them to node_modules
let PizZip, Docxtemplater;
try {
  PizZip = require('pizzip');
  Docxtemplater = require('docxtemplater');
} catch(e) {
  // No template packages — falls back to programmatic generation
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { fields, dealType, language, zohoContext } = JSON.parse(event.body || '{}');
    if (!fields) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing fields' }) };

    const lang   = language === 'es' ? 'es' : 'en';
    const type   = dealType  === 'rescission' ? 'rescission' : 'cash_keep';
    const zc     = zohoContext || {};

    const buyerSlug  = (fields.buyer_name  || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const dealerSlug = (fields.dealer_name || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const filename = `SAR_${buyerSlug}_${dealerSlug}.docx`;

    let base64;
    let usedTemplate = false;

    // ── Try template-based generation ─────────────────────────────────────────
    if (PizZip && Docxtemplater) {
      try {
        const templateStore = getStore('sar-templates');
        const templateBase64 = await templateStore.get(`${lang}_${type}`).catch(() => null);

        if (templateBase64) {
          const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

          const data = {
            today_date:              today,
            buyer_name:              (fields.buyer_name  || '').toUpperCase(),
            dealer_name:             (fields.dealer_name || '').toUpperCase(),
            vehicle:                 [fields.vehicle_year, fields.vehicle_make, fields.vehicle_model].filter(Boolean).join(' '),
            vehicle_year:            fields.vehicle_year  || '',
            vehicle_make:            fields.vehicle_make  || '',
            vehicle_model:           fields.vehicle_model || '',
            vin:                     fields.vin           || '',
            purchase_date:           fields.purchase_date || '',
            settlement_amount:       fields.settlement_amount ? '$' + fields.settlement_amount : '',
            settlement_amount_words: (fields.settlement_amount_words || '').toUpperCase(),
            down_payment:            fields.down_payment ? '$' + fields.down_payment : '',
            down_payment_words:      (fields.down_payment_words || '').toUpperCase(),
            miles_driven:            fields.miles_driven || '',
            apr:                     fields.apr          || '',
            work_desc:               zc.workDesc     || '',
            dealer_giving:           zc.dealerGiving || '',
            refund_notes:            zc.refundNotes  || '',
            third_party:             zc.thirdParty   || '',
            has_happened:            zc.hasHappened  || '',
            who_work:                zc.whoWork      || '',
          };

          const content = Buffer.from(templateBase64, 'base64');
          const zip = new PizZip(content);
          const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => '',
          });
          doc.setData(data);
          doc.render();
          const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
          base64 = buf.toString('base64');
          usedTemplate = true;
        }
      } catch (e) {
        console.warn('Template generation failed, using programmatic fallback:', e.message);
      }
    }

    // ── Programmatic fallback ─────────────────────────────────────────────────
    if (!usedTemplate) {
      const doc = buildDocument(fields, dealType || 'cash_keep', zc);
      base64 = await Packer.toBase64String(doc);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, base64, filename, size: Math.round(base64.length * 0.75), usedTemplate })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

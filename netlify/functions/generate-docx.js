const {
  Document, Paragraph, TextRun, AlignmentType,
  Packer, convertInchesToTwip, UnderlineType
} = require('docx');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { fields, dealType, language } = JSON.parse(event.body || '{}');
    if (!fields) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing fields' }) };

    const doc = buildDocument(fields, dealType || 'cash_keep');
    const base64 = await Packer.toBase64String(doc);

    const buyerSlug = (fields.buyer_name || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const dealerSlug = (fields.dealer_name || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const filename = `SAR_${buyerSlug}_${dealerSlug}.docx`;
    const size = Math.round(base64.length * 0.75);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, base64, filename, size })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: e.message, stack: e.stack })
    };
  }
};

// ── DOCUMENT BUILDER ──────────────────────────────────────────────────────────

function buildDocument(f, dealType) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const buyer    = (f.buyer_name || '[BUYER NAME]').toUpperCase();
  const dealer   = (f.dealer_name || '[DEALER NAME]').toUpperCase();
  const vehicle  = [f.vehicle_year, f.vehicle_make, f.vehicle_model].filter(Boolean).join(' ') || '[VEHICLE]';
  const vin      = f.vin || '[VIN]';
  const purchDate = f.purchase_date || '[PURCHASE DATE]';
  const amt      = f.settlement_amount ? '$' + f.settlement_amount : '[AMOUNT]';
  const amtWords = (f.settlement_amount_words || '[AMOUNT IN WORDS]').toUpperCase();
  const down     = f.down_payment ? '$' + f.down_payment : '[DOWN PAYMENT]';
  const miles    = f.miles_driven || '[MILES]';
  const downWords = f.down_payment_words || down;

  const isRescission = dealType === 'rescission';

  const body = [
    // Title
    p('PRIVATE SETTLEMENT AGREEMENT AND GENERAL RELEASE', { bold: true, size: 28, center: true, spaceAfter: 240 }),
    p('', { spaceAfter: 120 }),

    // Intro
    p(`This Private Settlement Agreement and General Release ("Agreement") is entered into as of ${today}, by and between ${buyer} ("Client") and ${dealer} ("Dealer") (collectively, the "Parties").`, { justify: true, spaceAfter: 240 }),

    // RECITALS
    sectionHeader('RECITALS'),
    numbered(1, `On or about ${purchDate}, Client purchased a ${vehicle}, Vehicle Identification Number ${vin} ("Vehicle"), from Dealer.`),
    numbered(2, `In connection with said purchase, Client paid a down payment of ${down} and the balance was financed pursuant to a Retail Installment Sales Contract ("RISC").`),
    numbered(3, `Client has driven approximately ${miles} miles in the Vehicle since the date of purchase.`),
    ...(isRescission ? [
      numbered(4, 'Client has identified issues with the vehicle and/or the financing transaction, and seeks to rescind and unwind the transaction.'),
      numbered(5, 'Dealer agrees to accept the return of the Vehicle and cancel the associated financing obligations under the terms set forth herein.'),
      numbered(6, 'Client is represented by Auto Legal Group, LLP ("ALG") in connection with this matter.'),
      numbered(7, 'The Parties desire to fully and finally resolve all disputes between them on the terms set forth herein.'),
    ] : [
      numbered(4, 'Following the purchase, disputes arose between the Parties concerning the Vehicle and/or the terms of the transaction, giving rise to potential legal claims.'),
      numbered(5, 'Client is represented by Auto Legal Group, LLP ("ALG") in connection with this matter.'),
      numbered(6, 'The Parties desire to fully and finally resolve all disputes between them on the terms set forth herein, without admission of liability by either Party.'),
    ]),
    p('', { spaceAfter: 120 }),

    // NOW THEREFORE
    sectionHeader('TERMS AND CONDITIONS'),
    p('NOW, THEREFORE, in consideration of the mutual covenants and promises set forth herein, and other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:', { justify: true, spaceAfter: 200 }),

    // Deal-type specific terms
    ...(isRescission ? rescissionTerms(vehicle, miles, down, downWords, purchDate) : cashKeepTerms(amt, amtWords)),

    p('', { spaceAfter: 120 }),
    // Release
    sectionHeader('RELEASE OF ALL CLAIMS'),
    p('In consideration of the above, Client, on behalf of himself/herself, his/her heirs, executors, administrators, successors, and assigns, hereby fully and forever releases and discharges Dealer, its current and former officers, directors, shareholders, employees, agents, insurers, attorneys, predecessors, successors, parent companies, subsidiaries, and affiliates (collectively, "Released Parties") from any and all claims, demands, actions, causes of action, suits, debts, liabilities, losses, damages, costs, and expenses of every kind and nature, whether known or unknown, suspected or unsuspected, fixed or contingent, arising out of or in any way relating to the purchase, financing, and/or ownership of the Vehicle, or any other matter between Client and Dealer arising from or related to the transaction described herein.', { justify: true, spaceAfter: 200 }),

    // 1542 Waiver
    sectionHeader('CALIFORNIA CIVIL CODE §1542 WAIVER'),
    p('CLIENT HEREBY EXPRESSLY WAIVES ANY AND ALL RIGHTS UNDER CALIFORNIA CIVIL CODE §1542, WHICH PROVIDES:', { bold: true, justify: true, spaceAfter: 120 }),
    p('"A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party."', { italics: true, justify: true, spaceAfter: 120 }),
    p('Client fully understands that Client may have unknown claims and expressly accepts this risk. Client acknowledges that this waiver is a material inducement to Dealer\'s entry into this Agreement.', { justify: true, spaceAfter: 200 }),

    // Misc
    sectionHeader('MISCELLANEOUS PROVISIONS'),
    numberedBold(1, 'ENTIRE AGREEMENT.', 'This Agreement constitutes the entire agreement between the Parties with respect to the subject matter hereof and supersedes all prior negotiations, representations, warranties, and agreements, whether oral or written.'),
    numberedBold(2, 'GOVERNING LAW.', 'This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to conflict of law principles.'),
    numberedBold(3, 'CONFIDENTIALITY.', 'The Parties agree to keep the terms and existence of this Agreement strictly confidential and shall not disclose the terms to any third party without the prior written consent of the other Party, except as required by law, court order, or to their respective attorneys, accountants, or tax advisors who shall be bound by this confidentiality obligation.'),
    numberedBold(4, 'NO ADMISSION.', 'This Agreement is a compromise of disputed claims and shall not constitute, and shall not be construed as, an admission of liability or wrongdoing by either Party.'),
    numberedBold(5, 'COUNTERPARTS / ELECTRONIC SIGNATURES.', 'This Agreement may be executed in two or more counterparts, each of which shall be deemed an original and all of which together shall constitute one and the same instrument. Electronic and facsimile signatures shall be deemed original signatures for all purposes.'),
    numberedBold(6, 'SEVERABILITY.', 'If any provision of this Agreement is found to be invalid or unenforceable, such provision shall be severed from the Agreement and the remaining provisions shall continue in full force and effect.'),
    numberedBold(7, 'AUTHORITY.', 'Each Party represents and warrants that they have full right, power, and authority to enter into this Agreement and to perform all obligations hereunder.'),
    p('', { spaceAfter: 300 }),

    // Signatures
    sectionHeader('SIGNATURES'),
    p('IN WITNESS WHEREOF, the Parties have executed this Agreement as of the date first written above.', { justify: true, spaceAfter: 400 }),

    ...sigBlock('CLIENT:', buyer),
    p('', { spaceAfter: 200 }),
    ...sigBlock('DEALER:', dealer, 'Title: _______________'),
    p('', { spaceAfter: 200 }),
    ...sigBlock('AUTO LEGAL GROUP, LLP:', 'Authorized Representative'),
  ];

  return new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.25)
          }
        }
      },
      children: body
    }]
  });
}

function cashKeepTerms(amt, amtWords) {
  return [
    numberedBold(1, 'SETTLEMENT PAYMENT.', `Within ten (10) calendar days of full execution of this Agreement, Dealer shall pay to Client the sum of ${amt} (${amtWords} DOLLARS AND 00/100) ("Settlement Payment"). Payment shall be made payable to Client and Auto Legal Group, LLP, as directed in writing by ALG.`),
    numberedBold(2, 'VEHICLE RETENTION.', 'Client shall retain the Vehicle. The Vehicle is accepted "AS IS" as of the date of this Agreement, and Dealer makes no further representations, warranties, or guarantees regarding the Vehicle or its condition.'),
    numberedBold(3, 'COOPERATION.', 'The Parties shall cooperate and execute any further documents or instruments reasonably necessary or appropriate to carry out and effectuate the terms of this Agreement.'),
  ];
}

function rescissionTerms(vehicle, miles, down, downWords, purchDate) {
  return [
    numberedBold(1, 'RETURN OF VEHICLE.', `Within five (5) calendar days of full execution of this Agreement, Client shall return the Vehicle (${vehicle}) to Dealer in its current condition, reasonable wear and tear excepted. Client represents and warrants that the Vehicle has approximately ${miles} miles on the odometer at the time of return.`),
    numberedBold(2, 'CANCELLATION OF RETAIL INSTALLMENT SALES CONTRACT.', `Upon receipt of the Vehicle, Dealer shall immediately cancel and rescind the Retail Installment Sales Contract dated ${purchDate}, and all associated financing obligations. Dealer shall notify any and all lienholders, finance companies, or assignees of the RISC of the rescission within five (5) business days of Vehicle return, and shall provide Client with written confirmation thereof.`),
    numberedBold(3, 'REFUND OF DOWN PAYMENT.', `Within five (5) calendar days of Dealer\'s receipt of the returned Vehicle, Dealer shall refund to Client the full down payment in the amount of ${down} (${downWords}). Payment shall be made payable to Client and Auto Legal Group, LLP, as directed in writing by ALG.`),
    numberedBold(4, 'CANCELLATION OF FINANCING.', 'Dealer shall ensure that all financing associated with the Vehicle purchase is cancelled and that Client bears no further financial obligation related to the Vehicle or the RISC.'),
    numberedBold(5, 'CREDIT REPORTING.', 'Dealer shall ensure that no adverse or negative credit reporting arises from or is related to this transaction or the Vehicle purchase. Dealer shall take all necessary steps to remove, or cause to be removed, any adverse credit entries associated with this transaction within thirty (30) calendar days of execution of this Agreement, and shall provide Client with written confirmation that such steps have been taken.'),
    numberedBold(6, 'COOPERATION.', 'The Parties shall cooperate and execute any further documents or instruments reasonably necessary to carry out the rescission, including vehicle title transfer, lien releases, and DMV filings.'),
  ];
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : opts.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
    spacing: { after: opts.spaceAfter ?? 160, line: 336 },
    children: [new TextRun({
      text,
      bold: opts.bold || false,
      italics: opts.italics || false,
      underline: opts.underline ? { type: UnderlineType.SINGLE } : undefined,
      size: opts.size || 24,
      font: 'Times New Roman'
    })]
  });
}

function sectionHeader(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 280, after: 160, line: 336 },
    children: [new TextRun({
      text,
      bold: true,
      underline: { type: UnderlineType.SINGLE },
      size: 24,
      font: 'Times New Roman'
    })]
  });
}

function numbered(num, text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120, line: 336 },
    indent: { left: 360 },
    children: [new TextRun({ text: `${num}.\t${text}`, size: 24, font: 'Times New Roman' })]
  });
}

function numberedBold(num, boldPart, rest) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 160, line: 336 },
    children: [
      new TextRun({ text: `${num}.\t`, size: 24, font: 'Times New Roman' }),
      new TextRun({ text: boldPart + ' ', bold: true, size: 24, font: 'Times New Roman' }),
      new TextRun({ text: rest, size: 24, font: 'Times New Roman' })
    ]
  });
}

function sigBlock(party, name, extra) {
  const lines = [
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: party, bold: true, size: 24, font: 'Times New Roman' })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: '', size: 24, font: 'Times New Roman' })] }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: '_______________________________', size: 24, font: 'Times New Roman' })] }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: name, size: 24, font: 'Times New Roman' })] }),
  ];
  if (extra) {
    lines.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: extra, size: 24, font: 'Times New Roman' })] }));
  }
  lines.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'Date: _______________', size: 24, font: 'Times New Roman' })] }));
  return lines;
}


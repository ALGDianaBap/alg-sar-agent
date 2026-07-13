// Shared module — not a function endpoint (underscore prefix).
// Required by both generate-docx.js and zoho-webhook.js.

const {
  Document, Paragraph, TextRun, AlignmentType,
  Packer, convertInchesToTwip, UnderlineType
} = require('docx');

/**
 * buildDocument(fields, dealType, zohoContext)
 *
 * fields       — extracted from RISC PDF (vehicle, VIN, dates, amounts)
 * dealType     — 'cash_keep' | 'rescission'
 * zohoContext  — raw Zoho form data (work description, dealer giving, prior actions, etc.)
 */
function buildDocument(fields, dealType, zohoContext = {}) {
  const today     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const buyer     = (fields.buyer_name  || '[BUYER NAME]').toUpperCase();
  const dealer    = (fields.dealer_name || '[DEALER NAME]').toUpperCase();
  const vehicle   = [fields.vehicle_year, fields.vehicle_make, fields.vehicle_model].filter(Boolean).join(' ') || '[VEHICLE]';
  const vin       = fields.vin || '[VIN]';
  const purchDate = fields.purchase_date || '[PURCHASE DATE]';
  const amt       = fields.settlement_amount ? '$' + fields.settlement_amount : '[SETTLEMENT AMOUNT]';
  const amtWords  = (fields.settlement_amount_words || '[AMOUNT IN WORDS]').toUpperCase();
  const down      = fields.down_payment ? '$' + fields.down_payment : '[DOWN PAYMENT]';
  const downWords = fields.down_payment_words || down;
  const miles     = fields.miles_driven || '[MILES]';
  const apr       = fields.apr || '';
  const isRescission = dealType === 'rescission';

  // Pull Zoho context fields
  const workDesc      = zohoContext.workDesc      || '';   // What are you doing for the customer?
  const dealerGiving  = zohoContext.dealerGiving  || '';   // What's the dealership giving in return?
  const refundNotes   = zohoContext.refundNotes   || '';   // Partial refund / deductions detail
  const hasHappened   = zohoContext.hasHappened   || '';   // Has this already happened?
  const whoWork       = zohoContext.whoWork        || '';   // Who is doing the work?
  const thirdParty    = zohoContext.thirdParty    || '';   // Third party involvement
  const priorRepairs  = zohoContext.priorRepairs  || '';   // Any repairs already completed

  // Build dynamic recital paragraphs from Zoho context
  const priorActionRecitals = buildPriorActionRecitals(dealerGiving, refundNotes, hasHappened, priorRepairs, workDesc);

  const body = [
    p('PRIVATE SETTLEMENT AGREEMENT AND GENERAL RELEASE', { bold: true, size: 28, center: true, spaceAfter: 240 }),
    p('', { spaceAfter: 120 }),
    p(`This Private Settlement Agreement and General Release ("Agreement") is entered into as of ${today}, by and between ${buyer} ("Client") and ${dealer} ("Dealer") (collectively, the "Parties").`, { justify: true, spaceAfter: 240 }),

    sectionHeader('RECITALS'),
    numbered(1, `On or about ${purchDate}, Client purchased a ${vehicle}, Vehicle Identification Number ${vin} ("Vehicle"), from Dealer${apr ? ' with an Annual Percentage Rate of ' + apr + '%' : ''}.`),
    numbered(2, `In connection with said purchase, Client paid a down payment of ${down} and the balance was financed pursuant to a Retail Installment Sales Contract ("RISC").`),
    numbered(3, `Client has driven approximately ${miles} miles in the Vehicle since the date of purchase.`),

    // Dynamic recitals from Zoho form context
    ...priorActionRecitals,

    ...(isRescission ? [
      numbered(priorActionRecitals.length + 4, 'Client has identified issues with the vehicle and/or the financing transaction, and seeks to rescind and unwind the transaction.'),
      numbered(priorActionRecitals.length + 5, 'Dealer agrees to accept the return of the Vehicle and cancel the associated financing obligations under the terms set forth herein.'),
      numbered(priorActionRecitals.length + 6, 'Client is represented by Auto Legal Group, LLP ("ALG") in connection with this matter.'),
      numbered(priorActionRecitals.length + 7, 'The Parties desire to fully and finally resolve all disputes between them on the terms set forth herein.'),
    ] : [
      numbered(priorActionRecitals.length + 4, 'Following the purchase, disputes arose between the Parties concerning the Vehicle and/or the terms of the transaction, giving rise to potential legal claims.'),
      numbered(priorActionRecitals.length + 5, 'Client is represented by Auto Legal Group, LLP ("ALG") in connection with this matter.'),
      numbered(priorActionRecitals.length + 6, 'The Parties desire to fully and finally resolve all disputes between them on the terms set forth herein, without admission of liability by either Party.'),
    ]),

    p('', { spaceAfter: 120 }),
    sectionHeader('TERMS AND CONDITIONS'),
    p('NOW, THEREFORE, in consideration of the mutual covenants and promises set forth herein, and other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the Parties agree as follows:', { justify: true, spaceAfter: 200 }),

    ...(isRescission
      ? rescissionTerms(vehicle, miles, down, downWords, purchDate, dealerGiving, refundNotes, whoWork, thirdParty)
      : cashKeepTerms(amt, amtWords, dealerGiving, refundNotes, whoWork, thirdParty, priorRepairs)),

    p('', { spaceAfter: 120 }),
    sectionHeader('RELEASE OF ALL CLAIMS'),
    p('In consideration of the above, Client, on behalf of himself/herself, his/her heirs, executors, administrators, successors, and assigns, hereby fully and forever releases and discharges Dealer, its current and former officers, directors, shareholders, employees, agents, insurers, attorneys, predecessors, successors, parent companies, subsidiaries, and affiliates (collectively, "Released Parties") from any and all claims, demands, actions, causes of action, suits, debts, liabilities, losses, damages, costs, and expenses of every kind and nature, whether known or unknown, suspected or unsuspected, fixed or contingent, arising out of or in any way relating to the purchase, financing, and/or ownership of the Vehicle, or any other matter between Client and Dealer arising from or related to the transaction described herein.', { justify: true, spaceAfter: 200 }),

    sectionHeader('CALIFORNIA CIVIL CODE §1542 WAIVER'),
    p('CLIENT HEREBY EXPRESSLY WAIVES ANY AND ALL RIGHTS UNDER CALIFORNIA CIVIL CODE §1542, WHICH PROVIDES:', { bold: true, justify: true, spaceAfter: 120 }),
    p('"A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party."', { italics: true, justify: true, spaceAfter: 120 }),
    p("Client fully understands that Client may have unknown claims and expressly accepts this risk. Client acknowledges that this waiver is a material inducement to Dealer's entry into this Agreement.", { justify: true, spaceAfter: 200 }),

    sectionHeader('MISCELLANEOUS PROVISIONS'),
    numberedBold(1, 'ENTIRE AGREEMENT.', 'This Agreement constitutes the entire agreement between the Parties with respect to the subject matter hereof and supersedes all prior negotiations, representations, warranties, and agreements, whether oral or written.'),
    numberedBold(2, 'GOVERNING LAW.', 'This Agreement shall be governed by and construed in accordance with the laws of the State of California, without regard to conflict of law principles.'),
    numberedBold(3, 'CONFIDENTIALITY.', 'The Parties agree to keep the terms and existence of this Agreement strictly confidential and shall not disclose the terms to any third party without prior written consent, except as required by law or to their respective counsel, accountants, or tax advisors.'),
    numberedBold(4, 'NO ADMISSION.', 'This Agreement is a compromise of disputed claims and shall not constitute an admission of liability or wrongdoing by either Party.'),
    numberedBold(5, 'COUNTERPARTS / ELECTRONIC SIGNATURES.', 'This Agreement may be executed in counterparts, each of which shall be deemed an original. Electronic and facsimile signatures shall be deemed original for all purposes.'),
    numberedBold(6, 'SEVERABILITY.', 'If any provision of this Agreement is found invalid or unenforceable, the remaining provisions shall continue in full force and effect.'),
    numberedBold(7, 'AUTHORITY.', 'Each Party represents and warrants that they have full right, power, and authority to enter into this Agreement and perform all obligations hereunder.'),

    p('', { spaceAfter: 300 }),
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
      properties: { page: { margin: { top: convertInchesToTwip(1), right: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.25) } } },
      children: body
    }]
  });
}

// ── Dynamic recitals built from Zoho form data ────────────────────────────────

function buildPriorActionRecitals(dealerGiving, refundNotes, hasHappened, priorRepairs, workDesc) {
  const recitals = [];
  let n = 4; // starts after the first 3 standard recitals

  const alreadyHappened = /yes|already|done|completed|performed/i.test(hasHappened);

  // Prior repairs already completed
  if (priorRepairs && priorRepairs.trim()) {
    recitals.push(numbered(n++, `Prior to the execution of this Agreement, Dealer performed the following repair(s) to the Vehicle: ${priorRepairs.trim()}.`));
  } else if (alreadyHappened && /repair|fix|service/i.test(dealerGiving + workDesc)) {
    recitals.push(numbered(n++, 'Prior to the execution of this Agreement, Dealer performed certain repairs to the Vehicle at Dealer\'s expense.'));
  }

  // Prior partial payment or credit already given
  if (refundNotes && refundNotes.trim()) {
    recitals.push(numbered(n++, `In partial resolution of Client's concerns, Dealer has previously provided or agreed to provide the following: ${refundNotes.trim()}.`));
  } else if (alreadyHappened && /refund|payment|paid|credit|reimburs/i.test(dealerGiving + workDesc)) {
    recitals.push(numbered(n++, 'In partial resolution of Client\'s concerns, Dealer has previously made a payment or provided a credit to Client.'));
  }

  return recitals;
}

// Builds the THIRD-PARTY OBLIGATIONS clause text. `thirdParty` is either a
// payer description ("Dealer is paying for the repair" / "Customer is paying
// for the repair" / "Other: ...") from the current form's third-party
// sub-question, or (for older records) a bare vendor name. Either way, the
// vendor-not-dealer warranty note is always included per California practice
// and per the firm's explicit instruction on the intake form.
function thirdPartyClause(thirdParty) {
  const desc = thirdParty.trim();
  return `The Parties acknowledge that repairs to the Vehicle are being performed by a third-party vendor rather than by Dealer directly. ${desc}. Consistent with the third-party's role, the vendor — not Dealer — is responsible for the warranty on parts or labor performed in connection with such repairs.`;
}

// ── Deal-type specific terms ──────────────────────────────────────────────────

function cashKeepTerms(amt, amtWords, dealerGiving, refundNotes, whoWork, thirdParty, priorRepairs) {
  const terms = [];
  let n = 1;

  // Settlement payment
  terms.push(numberedBold(n++, 'SETTLEMENT PAYMENT.', `Within ten (10) calendar days of full execution of this Agreement, Dealer shall pay to Client the sum of ${amt} (${amtWords} DOLLARS AND 00/100) ("Settlement Payment"). Payment shall be made payable to Client and Auto Legal Group, LLP, as directed in writing by ALG.`));

  // Additional obligations from dealerGiving / Zoho form
  if (dealerGiving && !/cash|payment|money|refund/i.test(dealerGiving)) {
    // Non-cash obligation (e.g., repairs, warranty, service contract)
    terms.push(numberedBold(n++, 'ADDITIONAL DEALER OBLIGATIONS.', `In addition to the Settlement Payment, Dealer shall: ${dealerGiving.trim()}. All such obligations shall be completed within thirty (30) calendar days of full execution of this Agreement unless otherwise specified.`));
  }

  // Third party obligations
  if (thirdParty && thirdParty.trim()) {
    terms.push(numberedBold(n++, 'THIRD-PARTY OBLIGATIONS.', thirdPartyClause(thirdParty)));
  }

  // Prior repairs — confirm warranty / no additional cost
  if (priorRepairs && priorRepairs.trim()) {
    terms.push(numberedBold(n++, 'PRIOR REPAIRS — WARRANTY.', `Dealer warrants that the repairs previously performed on the Vehicle (as described in the Recitals) were completed in a workmanlike manner and at no additional cost to Client. Dealer shall, at its own expense, correct any deficiencies in said repairs within thirty (30) days of written notice from Client.`));
  }

  terms.push(numberedBold(n++, 'VEHICLE RETENTION.', 'Client shall retain the Vehicle. The Vehicle is accepted "AS IS" as of the date of this Agreement, and Dealer makes no further representations or warranties regarding the Vehicle, except as expressly set forth herein.'));
  terms.push(numberedBold(n++, 'COOPERATION.', 'The Parties shall cooperate and execute any further documents or instruments reasonably necessary to carry out the terms of this Agreement.'));

  return terms;
}

function rescissionTerms(vehicle, miles, down, downWords, purchDate, dealerGiving, refundNotes, whoWork, thirdParty) {
  const terms = [];
  let n = 1;

  terms.push(numberedBold(n++, 'RETURN OF VEHICLE.', `Within five (5) calendar days of full execution of this Agreement, Client shall return the Vehicle (${vehicle}) to Dealer in its current condition, reasonable wear and tear excepted. Client represents that the Vehicle has approximately ${miles} miles on the odometer at the time of return.`));
  terms.push(numberedBold(n++, 'CANCELLATION OF RETAIL INSTALLMENT SALES CONTRACT.', `Upon receipt of the Vehicle, Dealer shall immediately cancel and rescind the Retail Installment Sales Contract dated ${purchDate}, and all associated financing obligations. Dealer shall notify all lienholders and finance companies within five (5) business days of Vehicle return and provide Client written confirmation thereof.`));

  // Refund clause follows whichever "giving in return" option was actually
  // selected, so it never contradicts the form answer (e.g. a "Vehicle
  // return with no refund" selection must not be followed by a promised
  // full refund clause). Full/Partial refund take priority over a bare "no
  // refund" selection since dealers sometimes check both — see approved
  // samples 14/15, where "Vehicle return with no refund" was checked
  // alongside "Partial refund" and the actual amount governed the clause.
  const givingFullRefund = /full refund of down payment/i.test(dealerGiving);
  const givingPartialRefund = /partial refund/i.test(dealerGiving);
  const givingNoRefund = /no refund/i.test(dealerGiving) && !givingFullRefund && !givingPartialRefund;

  if (givingPartialRefund) {
    terms.push(numberedBold(n++, 'REFUND OF DOWN PAYMENT.', `Within five (5) calendar days of Dealer's receipt of the returned Vehicle, Dealer shall pay Client a partial return of the down payment as follows: ${(refundNotes && refundNotes.trim()) || '[AMOUNT TO BE SPECIFIED]'}. Payment shall be made payable to Client and Auto Legal Group, LLP, as directed in writing by ALG.`));
  } else if (givingNoRefund) {
    terms.push(numberedBold(n++, 'NO REFUND OF DOWN PAYMENT.', `The Parties agree that, in connection with the return of the Vehicle described herein, Client is not entitled to and shall not receive any refund of the down payment.`));
  } else {
    // Default (including "Full refund of down payment" and any rescission
    // inferred from workDesc alone) — the standard rescission remedy.
    terms.push(numberedBold(n++, 'REFUND OF DOWN PAYMENT.', `Within five (5) calendar days of Dealer's receipt of the returned Vehicle, Dealer shall refund to Client the full down payment of ${down} (${downWords}). Payment shall be made payable to Client and Auto Legal Group, LLP, as directed in writing by ALG.`));
  }

  // Additional amounts from Zoho form (only when not already covered above)
  if (!givingPartialRefund && refundNotes && refundNotes.trim()) {
    terms.push(numberedBold(n++, 'ADDITIONAL REFUND / CREDITS.', `In addition to the above, the following amounts or credits shall be provided to Client: ${refundNotes.trim()}. Such amounts shall be paid within five (5) calendar days of full execution of this Agreement.`));
  }

  // Additional dealer obligations
  if (dealerGiving && !/down payment|refund/i.test(dealerGiving)) {
    terms.push(numberedBold(n++, 'ADDITIONAL DEALER OBLIGATIONS.', `In connection with the rescission, Dealer additionally agrees to: ${dealerGiving.trim()}.`));
  }

  // Third party
  if (thirdParty && thirdParty.trim()) {
    terms.push(numberedBold(n++, 'THIRD-PARTY OBLIGATIONS.', thirdPartyClause(thirdParty)));
  }

  terms.push(numberedBold(n++, 'CANCELLATION OF FINANCING.', 'Dealer shall ensure that all financing associated with the Vehicle purchase is cancelled and that Client bears no further financial obligation related to the Vehicle or the RISC.'));
  terms.push(numberedBold(n++, 'CREDIT REPORTING.', 'Dealer shall ensure that no adverse or negative credit reporting arises from this transaction. Dealer shall remove any adverse credit entries within thirty (30) calendar days of execution of this Agreement and provide written confirmation to Client.'));
  terms.push(numberedBold(n++, 'COOPERATION.', 'The Parties shall cooperate and execute all further documents necessary to carry out the rescission, including vehicle title transfer, lien releases, and DMV filings.'));

  return terms;
}

// ── Paragraph helpers ─────────────────────────────────────────────────────────

function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : opts.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
    spacing: { after: opts.spaceAfter ?? 160, line: 336 },
    children: [new TextRun({ text, bold: opts.bold || false, italics: opts.italics || false, underline: opts.underline ? { type: UnderlineType.SINGLE } : undefined, size: opts.size || 24, font: 'Times New Roman' })]
  });
}

function sectionHeader(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 280, after: 160, line: 336 },
    children: [new TextRun({ text, bold: true, underline: { type: UnderlineType.SINGLE }, size: 24, font: 'Times New Roman' })]
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
  const rows = [
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: party, bold: true, size: 24, font: 'Times New Roman' })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: '', size: 24 })] }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: '_______________________________', size: 24, font: 'Times New Roman' })] }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: name, size: 24, font: 'Times New Roman' })] }),
  ];
  if (extra) rows.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: extra, size: 24, font: 'Times New Roman' })] }));
  rows.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: 'Date: _______________', size: 24, font: 'Times New Roman' })] }));
  return rows;
}

module.exports = { buildDocument, Packer };

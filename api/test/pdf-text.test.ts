import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bodyTextOf, extractPdfText, locateRecitals, locateSections, sliceRecitals } from '../src/pdf-text.ts';

/**
 * A decision's text, in the shape a real one comes out in.
 *
 * Built from Microsoft/LinkedIn, which is the document that makes the point: it numbers its
 * recitals `(350)` and carries a footnote numbered `350` bare at the start of its own line,
 * a few pages later. Both are in this fixture for that reason. `extractPdfText` is exercised
 * against the real PDFs by hand and by the corpus run — it needs a 4MB file and a network,
 * which is not what belongs in `npm run verify` — so what is pinned here is the anchoring,
 * which is where a wrong passage would come from.
 */
const DECISION = [
  'COMMISSION DECISION of 6 December 2016',
  '(349) First, the Commission notes that the parties overlap in professional social networks.',
  '(350) Second, to the extent that these foreclosure effects would lead to the degradation',
  'of rival services, the Commission considers that this would harm competition.',
  '(351) Third, the market investigation did not confirm these concerns.',
  '(352) Fourth, the Notifying Party submitted that entry remains possible.',
  '(353) Fifth, the Commission concludes on this point.',
  'VI. CONCLUSION',
  '350 Cisco\'s submission of 4 November 2016; Broadsoft\'s submission of 24 November 2016.',
  '351 See the minutes of the call with a competitor of 12 October 2016.',
].join('\n');

/**
 * Telling the decision's own text from the apparatus printed around it.
 *
 * Sizes as they are really measured on Microsoft/LinkedIn: recitals at 12, footnote text at
 * 10, footnote markers and page numbers at 8, headings at 18.
 */
describe('the decision’s text, and the apparatus around it', () => {
  const page = [
    { text: '(350) Second, to the extent that these foreclosure effects would lead to the', size: 12 },
    { text: 'marginalisation of an existing competitor which offers a greater degree of', size: 12 },
    { text: '326', size: 8 },
    { text: 'In Facebook/WhatsApp, the Commission found that multi-homing is facilitated.', size: 10 },
    { text: '76', size: 8 },
    { text: 'privacy protection to users than LinkedIn (or make the entry of any such', size: 12 },
    { text: '(iv) Conclusion', size: 18 },
  ];

  test('keeps the recital and drops the footnote printed under it', () => {
    // Without this, recital (350) — two lines long before the page's footnote block begins —
    // collected footnote 326, a paragraph about Facebook/WhatsApp, and showed it to the
    // reviewer as part of the recital they cited.
    const text = bodyTextOf(page);

    assert.match(text, /^\(350\) Second, to the extent/);
    assert.ok(!text.includes('Facebook/WhatsApp'), 'the footnote text is not the recital');
    assert.ok(!/^326$/m.test(text), 'nor is its marker');
    assert.ok(!/^76$/m.test(text), 'nor is the page number');
  });

  test('the recital continues across the page break', () => {
    assert.match(bodyTextOf(page), /greater degree of\nprivacy protection to users/);
  });

  test('headings are kept, being set larger rather than smaller', () => {
    assert.match(bodyTextOf(page), /\(iv\) Conclusion/);
  });

  test('a footnote that opens with a recital number is not an anchor', () => {
    // Both of these are real lines from Intel, and both are footnotes cross-referring to
    // recitals. `pdftotext` counts them as recital anchors; set against the body size they
    // never reach the matcher, so a citation to paragraph 495 cannot land on one.
    // Proportioned like a real decision, where the body outweighs the apparatus — Intel runs
    // 14,426 lines of recital against 3,951 of footnote. That ordering is what makes the
    // commonest size the body's, and the rule rests on it.
    const withCrossReferences = [
      { text: '(493) The Commission has established the following.', size: 12 },
      { text: '(494) The Commission concludes as follows.', size: 12 },
      { text: 'The conduct therefore constituted an abuse within the meaning of Article 102.', size: 12 },
      { text: 'That conclusion is not affected by the arguments raised by the parties.', size: 12 },
      { text: '(495)-(497), that is to say only concerns [...].', size: 10 },
      { text: '(239) ("Get [Dell Senior executive]/OOC clearly understand our meet-comp process', size: 10 },
    ];
    const text = bodyTextOf(withCrossReferences);

    assert.match(text, /^\(493\)/);
    assert.equal((text.match(/^\(\d+\)/gm) ?? []).length, 2, 'the two recitals, not the two footnotes');
    assert.ok(!text.includes('(495)-(497)'), 'a footnote cross-reference is not an anchor');
    assert.ok(!text.includes('Dell Senior executive'), 'nor is a recital quoted inside a footnote');
  });

  test('a decision that sets its footnotes in the body size is left alone', () => {
    const flat = [{ text: '(1) A recital.', size: 12 }, { text: '1 A footnote.', size: 12 }];
    assert.equal(bodyTextOf(flat).split('\n').length, 2, 'nothing is filtered rather than guessed at');
  });

  test('an empty document is empty, not a crash', () => {
    assert.equal(bodyTextOf([]), '');
  });
});

describe('the recital a Commission citation names', () => {
  test('slices the cited recital, not the footnote that shares its number', () => {
    // The failure this prevents is the whole reason the anchor is parenthesised: Microsoft /
    // LinkedIn really does carry paragraph (350) and footnote 350, and a bare-number match
    // puts a footnote on screen under a citation to a paragraph. Measured across eleven real
    // decisions, the bare shape appears 2,301 times in Intel alone and is never the recital.
    const passage = sliceRecitals(DECISION, [{ from: 350, to: 350 }]);

    assert.ok(passage, 'the recital is there to find');
    assert.match(passage, /^\(350\) Second, to the extent/);
    assert.ok(!passage.includes("Cisco's submission"), 'the footnote is not the passage');
  });

  test('a recital runs on to the next one, carrying its wrapped lines', () => {
    const passage = sliceRecitals(DECISION, [{ from: 350, to: 350 }]);

    assert.match(passage!, /degradation\nof rival services/, 'the continuation line belongs to it');
    assert.ok(!passage!.includes('(351)'), 'and it stops where the next recital begins');
  });

  test('a cited range is returned whole, not just its first recital', () => {
    // "paragraphs 350 to 352" is a citation to three recitals. Returning only the first gives
    // the lawyer the opening of an argument without the argument.
    const passage = sliceRecitals(DECISION, [{ from: 350, to: 352 }]);

    assert.match(passage!, /\(350\)/);
    assert.match(passage!, /\(351\)/);
    assert.match(passage!, /\(352\)/);
    assert.ok(!passage!.includes('(353)'), 'and stops after the last one asked for');
  });

  test('disjoint recitals are two passages with the gap marked', () => {
    const passage = sliceRecitals(DECISION, [{ from: 349, to: 349 }, { from: 352, to: 352 }]);

    assert.match(passage!, /\(349\)/);
    assert.match(passage!, /\(352\)/);
    assert.match(passage!, /…/, 'the gap between them is shown rather than implied away');
    assert.ok(!passage!.includes('(350)'), 'what was not cited is not shown');
  });

  test('a run the decision does not have is reported alongside the ones it does', () => {
    const located = locateRecitals(DECISION, [{ from: 349, to: 349 }, { from: 1324, to: 1324 }, { from: 352, to: 353 }]);

    assert.match(located.excerpt!, /^\(349\)/);
    assert.match(located.excerpt!, /\(353\) Fifth/);
    assert.deepEqual(located.unlocated, [{ from: 1324, to: 1324 }]);
  });

  test('a recital the decision does not have yields nothing', () => {
    // Not an error and not an empty string: `undefined` is what tells the resolver to say so
    // rather than present the opening of the document as the cited passage.
    assert.equal(sliceRecitals(DECISION, [{ from: 9999, to: 9999 }]), undefined);
  });

  test('a decision that numbers nothing yields nothing', () => {
    // One of the eleven decisions sampled has 7,564 characters of text and no numbered
    // recitals at all. There is no passage to find, and inventing one is the failure.
    const unnumbered = 'THE COMMISSION OF THE EUROPEAN COMMUNITIES,\nHaving regard to the Treaty,\nHAS ADOPTED THIS DECISION:';
    assert.equal(sliceRecitals(unnumbered, [{ from: 1, to: 1 }]), undefined);
  });

  test('numbering that restarts later does not cut a run short', () => {
    // A decision's annexes restart their numbering, so an anchor numbered above the run can
    // appear *before* it in the file. The end of a run is the first such anchor that also
    // comes after its start — position as well as number.
    const withAnnex = ['(500) An annex paragraph appearing earlier in the extracted text.',
      '(10) The recital actually cited.', '(11) The one after it.'].join('\n');
    const passage = sliceRecitals(withAnnex, [{ from: 10, to: 10 }]);

    assert.match(passage!, /^\(10\) The recital actually cited\./);
    assert.ok(!passage!.includes('(11)'));
  });

  test('a pathological citation is capped rather than returned whole', () => {
    const long = Array.from({ length: 400 }, (_, i) => `(${i + 1}) ${'text '.repeat(40)}`).join('\n');
    const passage = sliceRecitals(long, [{ from: 1, to: 399 }], { maxLength: 500 });

    assert.equal(passage!.length, 500);
  });
});

/**
 * A one-page PDF, assembled here so the offsets in its cross-reference table are right.
 *
 * Small enough to need no fixture file and no network, which is what lets `extractPdfText`
 * itself run under `npm run verify` — this is about loading pdfjs, not about a real decision.
 */
function onePagePdf(line: string): Uint8Array {
  const escaped = line.replace(/[\\()]/g, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('reading a PDF', () => {
  test('says nothing on the console, including while pdfjs loads', async () => {
    // pdfjs warns on import that `@napi-rs/canvas` is absent, before `verbosity: 0` applies.
    // `docs/DATA-FLOW.md` tells a reviewer the server logs its startup and nothing else, so
    // the first decision read must not print three lines about rendering.
    const printed: unknown[][] = [];
    const original = { warn: console.warn, log: console.log, info: console.info };
    console.warn = (...args: unknown[]) => { printed.push(args); };
    console.log = (...args: unknown[]) => { printed.push(args); };
    console.info = (...args: unknown[]) => { printed.push(args); };
    try {
      const extracted = await extractPdfText(onePagePdf('(350) Second, the Commission considers.'));

      assert.equal(extracted.pages, 1);
      assert.equal(extracted.text, '(350) Second, the Commission considers.');
    } finally {
      Object.assign(console, original);
    }
    assert.deepEqual(printed, []);
  });
});

/**
 * A decision cited by its numbered sections. Shaped on Norsk Hydro/Alumetal (M.10658), cited
 * by the Commission's 2026 draft merger guidelines as "section 9.1.3.3.7": the table of
 * contents lists the headings first with dot leaders, a long entry wraps with its leaders on
 * the next line, and the section itself runs from recital (299) to (321).
 */
describe('a decision’s numbered sections', () => {
  const DECISION = [
    '9.1.3.3. The Commission’s assessment.................................... 49',
    '9.1.3.3.7. The Parties are not close competitors regarding their respective low-carbon',
    'solid advanced AFA offerings ............................................. 60',
    '9.1.4. Alumetal as an important competitive force .......................... 62',
    '9.1.3.3. The Commission’s assessment',
    '(239) The analysis of closeness of competition.',
    '9.1.3.3.6. The Parties are geographically close to each other',
    '(290) Geographic closeness does not indicate close competition.',
    '9.1.3.3.7. The Parties are not close competitors regarding their respective low-carbon',
    'solid advanced AFA offerings',
    '(299) The Commission considers that the Parties have differentiated offerings, for',
    '1.5 million tonnes of reasons wrapped onto a line of their own.',
    '9.1.3.3.7.1. A subsection of it',
    '(321) Based on the above, the Parties are not close.',
    '9.1.3.3.8. Conclusion as regards closeness of competition',
    '(322) Based on the analysis of the evidence described in this Section.',
    '9.1.4. Alumetal as an important competitive force',
    '(330) Alumetal is an important competitive force.',
  ].join('\n');

  test('from its heading to the next heading after it, subsections and all', () => {
    const { excerpt, unlocated } = locateSections(DECISION, [{ from: '9.1.3.3.7' }]);
    assert.match(excerpt!, /^9\.1\.3\.3\.7\. The Parties are not close competitors/);
    assert.match(excerpt!, /\(299\)/);
    assert.match(excerpt!, /9\.1\.3\.3\.7\.1\. A subsection of it\n\(321\)/, 'its subsections are part of it');
    assert.match(excerpt!, /1\.5 million tonnes/, 'a wrapped line opening with a number does not end it');
    assert.ok(!excerpt!.includes('(322)'), 'and it stops at 9.1.3.3.8');
    assert.deepEqual(unlocated, []);
  });

  test('where the decision sets it out, not where its table of contents lists it', () => {
    const { excerpt } = locateSections(DECISION, [{ from: '9.1.3.3' }]);
    assert.match(excerpt!, /^9\.1\.3\.3\. The Commission’s assessment\n\(239\)/);
    assert.ok(!excerpt!.includes('....'), 'no dot leaders: not the contents entry');
    assert.ok(excerpt!.includes('(322)') && !excerpt!.includes('(330)'), 'a parent runs to the next heading outside it');
  });

  test('a range runs through its last section; a list is passages with the gap marked', () => {
    const range = locateSections(DECISION, [{ from: '9.1.3.3.6', to: '9.1.3.3.7' }]).excerpt!;
    assert.match(range, /^9\.1\.3\.3\.6\./);
    assert.ok(range.includes('(321)') && !range.includes('(322)'));
    const list = locateSections(DECISION, [{ from: '9.1.3.3.6' }, { from: '9.1.4' }]).excerpt!;
    assert.match(list, /\(290\)[^]*\n\n…\n\n9\.1\.4\. Alumetal/);
    assert.ok(!list.includes('(299)'));
  });

  test('a section the decision does not have is reported', () => {
    assert.deepEqual(locateSections(DECISION, [{ from: '9.1.3.3.7' }, { from: '12.4' }]).unlocated, ['12.4']);
    assert.deepEqual(locateSections(DECISION, [{ from: '12.4' }]), { unlocated: ['12.4'] });
  });

  test('a section longer than the cap is cut at a line, and says so', () => {
    const { excerpt } = locateSections(DECISION, [{ from: '9.1.3.3' }], { maxLength: 120 });
    assert.ok(excerpt!.endsWith('\n[…]'));
    assert.ok(excerpt!.length <= 125);
  });
});

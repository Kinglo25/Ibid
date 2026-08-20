import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { celexForCase, detectCitations, detectCitationsAcrossFootnotes, type CitationMatch } from '../src/index.ts';

const one = (text: string): CitationMatch => {
  const citations = detectCitations(text);
  assert.equal(citations.length, 1, `expected one citation in "${text}", got ${citations.map((c) => `"${c.value}"`).join(', ') || 'none'}`);
  return citations[0];
};

/**
 * The scope is English, with French kept: it predates this work and real client documents
 * are drafted in it (`samples/ibid-demo-docx/EU_Data_Retention_Memo.docx` is entirely
 * French). Support for German, Spanish, Italian and Dutch was built and then deliberately
 * removed — every extra keyword widens the surface on which a pinpoint can be matched
 * wrongly, and breadth that is not needed buys nothing while costing precision.
 *
 * These tests pin the boundary in both directions, so neither half drifts by accident.
 */
describe('citation formats — English and French, and only those', () => {
  test('reads a French citation end to end', () => {
    const citation = one('CJUE, 21 décembre 2016, Tele2 Sverige AB et Watson e.a., affaires jointes C-203/15 et C-698/15, ECLI:EU:C:2016:970, point 112.');
    assert.equal(citation.ecli, 'ECLI:EU:C:2016:970');
    assert.equal(citation.celex, '62015CJ0203');
    assert.deepEqual(citation.pinpoint, { paragraphs: [112] });
  });

  test('reads the French act and locator forms', () => {
    assert.equal(one('Règlement (UE) 2016/679, article 17.').celex, '32016R0679');
    assert.deepEqual(one('ECLI:EU:C:2014:238, points 57 à 65.').pinpoint, { paragraphs: [57, 58, 59, 60, 61, 62, 63, 64, 65] });
  });

  test('reads a French pre-1989 case number and joined-cases group', () => {
    assert.equal(one('Affaire 6/64, Costa contre ENEL.').caseNumber, 'C-6/64');
    assert.equal(one('Affaires jointes C-293/12 et C-594/12, ECLI:EU:C:2014:238.').caseNumber, 'C-293/12');
  });

  test('does not attempt the other official languages', () => {
    // Out of scope by decision, not by oversight. A German or Spanish citation still
    // resolves through its ECLI — that is language-independent — but its pinpoint word is
    // not recognised, so no paragraph is claimed rather than a wrong one.
    const german = one('EuGH, Urteil vom 13. Mai 2014, Rechtssache C-131/12, ECLI:EU:C:2014:317, Rn. 80.');
    assert.equal(german.ecli, 'ECLI:EU:C:2014:317', 'the ECLI is language-independent and still resolves');
    assert.equal(german.locator, undefined, 'but no paragraph is claimed from an unrecognised keyword');
    assert.deepEqual(detectCitations('Verordnung (EU) 2016/679, Artikel 17.'), []);
    assert.deepEqual(detectCitations('Reglamento (UE) 2016/679, apartado 17.'), []);
  });

  test('refuses bare "para", which is an ordinary word', () => {
    // A mandatory digit follows, but the scan reaches 160 characters past the citation, so
    // prose could silently produce a wrong paragraph. A missing pinpoint costs a click; a
    // wrong one is the failure this tool exists to prevent.
    assert.equal(one('ECLI:EU:C:2010:512, para 40.').locator, undefined);
    assert.deepEqual(one('ECLI:EU:C:2010:512, para. 40.').pinpoint, { paragraphs: [40] });
  });
});

/**
 * Pre-1989 case numbers carry no court prefix: Van Gend en Loos is "Case 26/62". They are
 * cited constantly and were entirely invisible, which also left the frequent-case table
 * inconsistent with detection — it holds those cases under their modern `C-` form while a
 * document writing them the real way matched nothing at all.
 */
describe('citation formats — pre-1989 case numbers', () => {
  test('reads a bare case number when the citation says it is a case', () => {
    const citation = one('Case 26/62 Van Gend en Loos [1963] ECR 1.');
    assert.equal(citation.caseNumber, 'C-26/62');
    assert.equal(citation.celex, '61962CJ0026');
  });

  test('normalises to the modern form the rest of the pipeline keys on', () => {
    assert.equal(one('Case 6/64 Costa v ENEL [1964] ECR 585.').caseNumber, 'C-6/64');
    assert.equal(one('Affaire 6/64, Costa contre ENEL.').caseNumber, 'C-6/64');
  });

  test('takes the pinpoint with it', () => {
    assert.deepEqual(one('Case 120/78 Rewe-Zentral (Cassis de Dijon), para. 14.').pinpoint, { paragraphs: [14] });
  });

  test('never guesses at a bare number pair without the keyword', () => {
    // A bare pair is hopelessly ambiguous — dates, ratios, page ranges — which is why the
    // explicit "Case"/"Affaire" is required rather than inferred.
    assert.deepEqual(detectCitations('The meeting on 26/62 of the schedule.'), []);
    assert.deepEqual(detectCitations('Revenue of 12/15 million in the 2019/2020 year.'), []);
  });

  test('refuses a bare number whose year postdates the General Court', () => {
    // The court letter is not inferred: it is a fact that the General Court did not exist
    // before 1989, so a case predating it can only be a Court of Justice case. After 1989
    // a number with no prefix is not a case number at all.
    assert.deepEqual(detectCitations('Case 26/12 is written wrongly.'), []);
  });

  test('does not double-report a bare number alongside a modern one', () => {
    const values = detectCitations('Case 26/62 and Case C-26/12 both appear.').map((citation) => citation.value);
    assert.deepEqual(values.sort(), ['C-26/12', 'C-26/62']);
  });
});

/**
 * Text that is shaped like a citation but is not one. Every entry here is drafting a
 * lawyer actually writes; a false positive puts a source panel behind a contract clause.
 */
describe('citation formats — text that must not be read as a citation', () => {
  for (const text of [
    'See Section 5, para. 3 of the shareholders agreement.',
    'Annex II, paragraph 4, sets out the methodology.',
    'Clause 7.2, point 4, of the SPA.',
    'Schedule 1, Article 3, of the lease.',
    'Mr Justice Smith, para. 40, dissenting.',
    'The 2019/2020 financial year saw revenue of 12/15 million.',
  ]) {
    test(`ignores: ${text}`, () => assert.deepEqual(detectCitations(text), []));
  }

  test('ignores a page range, which is not a paragraph pinpoint', () => {
    assert.equal(one('ECLI:EU:C:2010:512, pp. 12-14.').locator, undefined);
  });
});

describe('citation formats — the case name that identifiers sit next to', () => {
  test('reads a case name stated before its case number, with no ECLI following', () => {
    // "Name, Case T-125/03" is one of the commonest ways a judgment is cited, and the name
    // was lost outright: the scan stops at the case number, so the fragment in hand is the
    // bare word "Case". It also silently weakened the appeal-versus-first-instance guard —
    // a citation registering no name can never reach the name-based merge that guard exists
    // to protect, so the guard looked correct while never being exercised.
    assert.equal(one('Judgment of 17 September 2007, Akzo Nobel v Commission, Case T-125/03, para. 10.').caseName, 'Akzo Nobel v Commission');
    assert.equal(one('Google Spain SL v AEPD, Case C-131/12, para. 80.').caseName, 'Google Spain SL v AEPD');
  });

  test('reads a name stated before a joined-cases group', () => {
    assert.equal(one('Digital Rights Ireland, Joined Cases C-293/12 and C-594/12, para. 57.').caseName, 'Digital Rights Ireland');
  });

  test('keeps an appeal and the judgment under appeal apart', () => {
    // They share a case name exactly. One cited by case number only and the other by ECLI
    // only share no identifier at all, so the name would otherwise merge them into one
    // authority — and a short form would then resolve to whichever was registered first.
    // Both spellings carry the court, and the court differs.
    const [, , shortForm] = detectCitationsAcrossFootnotes([
      'Judgment of 17 September 2007, Akzo Nobel v Commission, Case T-125/03, para. 10.',
      'Judgment of 14 September 2010, Akzo Nobel v Commission, ECLI:EU:C:2010:512, para. 40.',
      'Akzo Nobel, para. 41.',
    ]);
    assert.equal(shortForm.length, 1);
    assert.equal(shortForm[0].status, 'unresolved_ambiguous');
    assert.equal(shortForm[0].celex, undefined);
    assert.deepEqual(shortForm[0].candidates?.map((candidate) => candidate.caseNumber ?? candidate.ecli).sort(),
      ['ECLI:EU:C:2010:512', 'T-125/03']);
  });

  test('still merges the same case stated two ways when the court agrees', () => {
    const [, , shortForm] = detectCitationsAcrossFootnotes([
      'Judgment of 14 September 2010, Akzo Nobel v Commission, Case C-550/07 P, para. 10.',
      'Judgment of 14 September 2010, Akzo Nobel v Commission, ECLI:EU:C:2010:512, para. 40.',
      'Akzo Nobel, para. 41.',
    ]);
    assert.equal(shortForm[0].status, 'resolved');
    assert.equal(shortForm[0].caseNumber, 'C-550/07 P');
    assert.equal(shortForm[0].ecli, 'ECLI:EU:C:2010:512');
  });
});

/**
 * A case number identifies the case; the CELEX sector identifies which document within it.
 * Deriving the judgment sector for everything is why opinions and orders used to be
 * link-only — the CELEX would have named a different document, so fetching was refused.
 */
describe('citation formats — the CELEX sector follows the document type', () => {
  test('derives a different sector for each kind of document in the same case', () => {
    assert.equal(celexForCase('C-550/07 P'), '62007CJ0550');
    assert.equal(celexForCase('C-550/07 P', { documentType: 'opinion' }), '62007CC0550');
    assert.equal(celexForCase('C-550/07 P', { documentType: 'order' }), '62007CO0550');
  });

  test('uses the General Court sectors for a T case', () => {
    assert.equal(celexForCase('T-286/09', { documentType: 'judgment' }), '62009TJ0286');
    assert.equal(celexForCase('T-286/09', { documentType: 'order' }), '62009TO0286');
  });

  test('refuses to guess a sector it has not confirmed', () => {
    // General Court Advocate General opinions barely exist and no sector for them has been
    // verified, so nothing is derived rather than something plausible-looking.
    assert.equal(celexForCase('T-286/09', { documentType: 'opinion' }), undefined);
  });

  test('an opinion cited by name takes the case number from the judgment cited in full', () => {
    const [, opinion] = detectCitationsAcrossFootnotes([
      'Judgment of 13 May 2014, Google Spain SL v AEPD, Case C-131/12, ECLI:EU:C:2014:317.',
      'Opinion of Advocate General Jääskinen of 25 June 2013 in Google Spain, ECLI:EU:C:2013:424, point 138.',
    ]);
    assert.equal(opinion[0].documentType, 'opinion');
    assert.equal(opinion[0].caseNumber, 'C-131/12', 'the number belongs to the case, not to one document in it');
    assert.equal(opinion[0].celex, '62012CC0131');
  });

  test('does not borrow a case number across courts', () => {
    // A General Court case cannot supply the number for a Court of Justice opinion, even
    // when the names match exactly — which for an appeal they always do.
    const [, opinion] = detectCitationsAcrossFootnotes([
      'Judgment of 17 September 2007, Akzo Nobel v Commission, Case T-125/03, para. 10.',
      'Opinion of Advocate General Kokott in Akzo Nobel v Commission, ECLI:EU:C:2010:229, point 60.',
    ]);
    assert.equal(opinion[0].caseNumber, undefined);
    assert.equal(opinion[0].celex, undefined);
  });
});

describe('citation formats — messy footnotes', () => {
  test('reads a citation broken across lines, as Word footnotes routinely are', () => {
    const citation = one('See\nAkzo Nobel Chemicals\nand Akcros Chemicals v Commission,\nECLI:EU:C:2010:512,\npara. 40.');
    assert.equal(citation.ecli, 'ECLI:EU:C:2010:512');
    assert.deepEqual(citation.pinpoint, { paragraphs: [40] });
  });

  test('reads the ECR-report form still used for older judgments', () => {
    const citation = one('Cf. Case C‑550/07 P Akzo Nobel [2010] ECR I-8301, para. 40.');
    assert.equal(citation.caseNumber, 'C-550/07 P');
    assert.deepEqual(citation.pinpoint, { paragraphs: [40] });
  });
});

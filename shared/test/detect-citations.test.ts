import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCitations, detectCitationsAcrossFootnotes, getCitationContexts, getCitationContextsForFootnotes, resolveTwoDigitYear, celexForCase } from '../src/index.ts';

const find = (text: string, value: string) =>
  detectCitations(text).find((citation) => citation.value === value);

describe('ECLI identifiers', () => {
  test('detects an ECLI and normalises it to upper case', () => {
    const [citation] = detectCitations('See ecli:eu:c:2014:317.');
    assert.equal(citation.value, 'ECLI:EU:C:2014:317');
    assert.equal(citation.ecli, 'ECLI:EU:C:2014:317');
    assert.equal(citation.source, 'curia');
    assert.equal(citation.label, 'CJEU judgment');
  });

  test('detects a General Court ECLI', () => {
    const [citation] = detectCitations('ECLI:EU:T:2019:222');
    assert.equal(citation.ecli, 'ECLI:EU:T:2019:222');
    assert.equal(citation.source, 'curia');
  });

  test('attaches a preceding case number and derives its CELEX', () => {
    const [citation] = detectCitations('Case C-131/12 Google Spain, ECLI:EU:C:2014:317');
    assert.equal(citation.caseNumber, 'C-131/12');
    assert.equal(citation.celex, '62012CJ0131');
  });

  test('reports the case number as stated, without inferring one that is absent', () => {
    const [citation] = detectCitations('Judgment in ECLI:EU:C:2014:317.');
    assert.equal(citation.caseNumber, undefined);
    assert.equal(citation.celex, undefined);
  });

  test('takes the first case number of a joined-cases group', () => {
    const text = 'Joined Cases C-293/12 and C-594/12 Digital Rights Ireland, ECLI:EU:C:2014:238';
    const [citation] = detectCitations(text);
    assert.equal(citation.caseNumber, 'C-293/12');
    assert.equal(citation.celex, '62012CJ0293');
  });
});

describe('CJEU case numbers', () => {
  test('derives CELEX for a Court of Justice case', () => {
    const citation = find('Case C-293/12 concerned data retention.', 'C-293/12');
    assert.equal(citation?.celex, '62012CJ0293');
    assert.equal(citation?.label, 'CJEU case number');
  });

  test('derives CELEX for a General Court case using the T sector', () => {
    const citation = find('Case T-79/12 is relevant.', 'T-79/12');
    assert.equal(citation?.celex, '62012TJ0079');
  });

  test('pads the case number to four digits and resolves the pre-2000 century', () => {
    // Costa v ENEL: the two-digit year "64" means 1964, not 2064.
    assert.equal(find('Case C-6/64 Costa v ENEL', 'C-6/64')?.celex, '61964CJ0006');
  });

  test('resolves other well-known pre-2000 cases to the 20th century', () => {
    assert.equal(find('Case C-26/62 Van Gend en Loos', 'C-26/62')?.celex, '61962CJ0026');
    assert.equal(find('Case C-120/78 Cassis de Dijon', 'C-120/78')?.celex, '61978CJ0120');
  });

  test('does not emit a duplicate entry for a case number stated next to its ECLI', () => {
    const citations = detectCitations('Case C-131/12, ECLI:EU:C:2014:317, at point 80.');
    assert.equal(citations.length, 1);
    assert.equal(citations[0].ecli, 'ECLI:EU:C:2014:317');
  });

  test('still detects a case number that stands far from any ECLI', () => {
    const text = `Case C-131/12 was decided in 2014. ${'Padding text. '.repeat(40)} ECLI:EU:C:2014:317`;
    const values = detectCitations(text).map((citation) => citation.value);
    assert.ok(values.includes('C-131/12'));
    assert.ok(values.includes('ECLI:EU:C:2014:317'));
  });

  test('does not suppress a genuinely different case number that merely sits near an unrelated ECLI', () => {
    // Found via a proactive citation-format sweep: a footnote citing two independent
    // authorities ("Akzo Nobel, ECLI:..., para. 40; and Case C-1/10, ...") used to
    // report only the ECLI — the standalone case-number loop used a plain textual-
    // proximity check ("is any ECLI within 160/250 characters"), so C-1/10 was wrongly
    // treated as a duplicate of the unrelated nearby Akzo Nobel ECLI and dropped.
    const text = 'See Akzo Nobel, ECLI:EU:C:2010:512, para. 40; and Case C-1/10, Second Authority, paras 25–27.';
    const citations = detectCitations(text);
    assert.equal(citations.length, 2);
    assert.equal(citations[0].ecli, 'ECLI:EU:C:2010:512');
    assert.equal(citations[1].caseNumber, 'C-1/10');
    assert.equal(citations[1].celex, '62010CJ0001');
  });

  test('still suppresses every case number in a joined-cases group, not just the first', () => {
    const text = 'Joined Cases C-293/12 and C-594/12 Digital Rights Ireland, ECLI:EU:C:2014:238';
    const citations = detectCitations(text);
    assert.equal(citations.length, 1, 'the second joined case number must not become its own citation');
  });
});

describe('resolveTwoDigitYear (century pivot)', () => {
  test('keeps a two-digit year in the current century when it is not in the future', () => {
    assert.equal(resolveTwoDigitYear('12', 2026), 2012);
    assert.equal(resolveTwoDigitYear('00', 2026), 2000);
  });

  test('rolls a two-digit year back a century exactly when it would otherwise be in the future', () => {
    assert.equal(resolveTwoDigitYear('26', 2026), 2026, 'the reference year itself must not roll back');
    assert.equal(resolveTwoDigitYear('27', 2026), 1927, 'one year ahead of the reference year rolls back');
    assert.equal(resolveTwoDigitYear('99', 2026), 1999);
  });

  test('re-derives correctly as the reference year advances', () => {
    // The same two-digit year means a different century depending on "now" — this is
    // the property that keeps the heuristic correct for decades without a fixed cutoff.
    assert.equal(resolveTwoDigitYear('50', 2026), 1950);
    assert.equal(resolveTwoDigitYear('50', 2060), 2050);
  });
});

describe('celexForCase (exported for direct testing)', () => {
  test('rejects a case number that does not match the C-NNN/YY shape', () => {
    assert.equal(celexForCase('not-a-case-number'), undefined);
  });

  test('refuses to derive a CELEX that would predate the Court', () => {
    // "C-1/27" cited as of reference year 2026 resolves to 1927 — before the Court
    // existed. Rather than emit a fabricated CELEX, this must fail closed.
    assert.equal(celexForCase('C-1/27', { referenceYear: 2026 }), undefined);
  });

  test('accepts a year exactly at the founding boundary', () => {
    assert.equal(celexForCase('C-1/52', { referenceYear: 2026 }), '61952CJ0001');
  });
});

describe('CURIA document-type detection', () => {
  test('defaults to judgment when no signal is present', () => {
    const citation = find('Case C-293/12 concerned data retention.', 'C-293/12');
    assert.equal(citation?.documentType, 'judgment');
    assert.equal(citation?.label, 'CJEU case number');
  });

  test('recognises an Advocate General opinion preceding the case number', () => {
    const citation = find('Opinion of Advocate General Kokott in Case C-293/12.', 'C-293/12');
    assert.equal(citation?.documentType, 'opinion');
    assert.equal(citation?.label, 'CJEU Advocate General opinion');
  });

  test('recognises an Advocate General opinion attached to an ECLI', () => {
    const [citation] = detectCitations('Opinion of Advocate General Kokott, ECLI:EU:C:2013:633.');
    assert.equal(citation.documentType, 'opinion');
    assert.equal(citation.label, 'CJEU Advocate General opinion');
  });

  test('recognises the French wording for an Advocate General opinion', () => {
    const citation = find("Conclusions de l'avocat général dans l'affaire C-293/12.", 'C-293/12');
    assert.equal(citation?.documentType, 'opinion');
  });

  test('recognises an order of the Court', () => {
    const citation = find('Order of the Court in Case C-293/12.', 'C-293/12');
    assert.equal(citation?.documentType, 'order');
    assert.equal(citation?.label, 'CJEU order');
  });

  test('recognises an order of the General Court', () => {
    const citation = find('Order of the General Court in Case T-79/12.', 'T-79/12');
    assert.equal(citation?.documentType, 'order');
  });

  test('recognises an order of the President, which is how interim measures are cited', () => {
    // Interim measures are ordered by the President and cited that way. Without the office
    // in the pattern this read as a judgment, the derived CELEX named `TJ` where the
    // document is `TO`, and an order CELLAR does hold came back as nothing but a link to
    // the case record — which is indistinguishable, to a reviewer, from a source that is
    // simply not available anywhere.
    const [citation] = detectCitations(
      'Order of the President of the General Court of 12 July 2024, Commission v WebGroup Czech Republic, T-139/24 R, EU:T:2024:475.',
    );
    assert.equal(citation.documentType, 'order');
    assert.equal(citation.celex, '62024TO0139');
  });

  test('recognises "Order in Case", a third convention in the same decision', () => {
    // Alongside "Order of the President of…" and "Order of [date]". Each convention missed
    // is a whole class of orders derived under the judgment sector, which is a well-formed
    // identifier for a document that is not the one cited.
    const [citation] = detectCitations('See Order in Case C-639/23 P(R), Commission v Amazon Services Europe, EU:C:2024:277, paragraph 162.');
    assert.equal(citation.documentType, 'order');
    assert.equal(citation.celex, '62023CO0639');
  });

  test('an ECLI takes the case number nearest it, not the first one in the footnote', () => {
    // A footnote citing two authorities in sequence puts the first one's case number inside
    // the second one's look-behind. Taking the first match derived the second citation's
    // CELEX from the first citation's case — wrong, but well-formed, so nothing failed.
    const citations = detectCitations(
      'Order of the Vice President of the Court of 27 March 2024 in Case C-639/23 P(R), Commission v Amazon, EU:C:2024:277, paragraph 155. '
      + 'See also Order of the President of the General Court of 2 July 2024 in Case T-138/24 R, Aylo Freesites v Commission, EU:T:2024:431, paragraph 113.',
    );
    const aylo = citations.find((citation) => citation.value.includes('2024:431'));
    assert.equal(aylo?.caseNumber, 'T-138/24 R');
    assert.equal(aylo?.celex, '62024TO0138');
  });

  test('a joined-cases group written without the words is still one authority', () => {
    // The modern style writes no "Joined Cases" at all, so the group is read off the text
    // between the numbers: separated by nothing but a connector, they are one judgment, and
    // the first of them names it.
    const [citation] = detectCitations('Judgment in Digital Rights Ireland (C-293/12 and C-594/12, EU:C:2014:238, paragraph 46).');
    assert.equal(citation.caseNumber, 'C-293/12');
  });

  test('an ECLI does not reach past the one cited before it for a case number', () => {
    // Found by the corpus harness: a footnote citing two authorities in sequence let the
    // second ECLI reach back over the first one's ECLI to the first one's case number, so a
    // 1982 judgment was derived under a 2013 case. CELLAR confirmed the identifier named a
    // different document; nothing about it looked wrong on screen.
    const citations = detectCitations(
      'Judgment of 12 June 2014, Ascendi (C-377/13, EU:C:2014:1754, paragraph 27). '
      + 'See also, to that effect, judgments of 23 March 1982, Nordsee (102/81, EU:C:1982:107).',
    );
    const nordsee = citations.find((citation) => citation.value.includes('1982:107'));
    assert.equal(nordsee?.caseNumber, undefined, 'no case number is better than another citation\'s');
    assert.equal(nordsee?.celex, undefined);
  });

  test('recognises "my Opinion in", the way an Advocate General cites their own', () => {
    // None of "my Opinion in", "his Opinion in" or a bare "Opinion in" names the office,
    // which is all the pattern used to look for — so an opinion cited that way derived the
    // judgment's CELEX, a well-formed identifier for the very document the citation was
    // distinguishing itself from.
    const [citation] = detectCitations('See, for the benefits of that shortcut, my Opinion in CB v Commission, C-67/13 P, EU:C:2014:1958, point 35.');
    assert.equal(citation.documentType, 'opinion');
    assert.equal(citation.celex, '62013CC0067');
  });

  test('a judgment and the opinion in the same case are typed by the words nearest each', () => {
    // One footnote routinely cites both. Trying opinion before judgment let the second
    // citation's wording relabel the first, which is the same silent-wrong-source failure
    // read from the other end.
    const citations = detectCitations(
      'See also, to that effect, judgment of 21 May 2015, CDC Hydrogen Peroxide (C-352/13, EU:C:2015:335, paragraphs 57 to 72), '
      + 'where the Court did not follow the point of view which Advocate General Jaaskinen expressed in his Opinion in CDC Hydrogen Peroxide (C-352/13, EU:C:2014:2443).',
    );
    assert.equal(citations.find((c) => c.value.includes('2015:335'))?.documentType, 'judgment');
    assert.equal(citations.find((c) => c.value.includes('2014:2443'))?.documentType, 'opinion');
  });

  test('recognises an order of the Vice-President', () => {
    const [citation] = detectCitations('Order of the Vice-President of the Court of 2 July 2024, Case C-511/24, ECLI:EU:C:2024:431.');
    assert.equal(citation.documentType, 'order');
  });

  test('an ECLI names the court, whatever letter the case number carries', () => {
    // From the decision under review: `C511/24, ECLI:EU:T:2024:431` — a Court of Justice
    // case number against a General Court ECLI. Deriving from the case number produced
    // `62024CJ0511`, a well-formed identifier for a different case entirely, so the mistake
    // could not fail loudly: it would retrieve another court's judgment and present it as
    // the source of this citation.
    const [citation] = detectCitations('Order of the President of the General Court of 2 July 2024, Aylo Freesites LTD v Commission, C511/24, ECLI:EU:T:2024:431.');
    assert.equal(citation.celex, '62024TO0511');
  });

  test('does not treat an unrelated use of "order" nearby as a signal', () => {
    const citation = find('In order to assess the claim, see Case C-293/12.', 'C-293/12');
    assert.equal(citation?.documentType, 'judgment');
  });

  test('does not pick up a signal that is far outside the scan window', () => {
    const text = `Order of the Court. ${'Padding text. '.repeat(30)} Case C-293/12 was later cited.`;
    const citation = find(text, 'C-293/12');
    assert.equal(citation?.documentType, 'judgment');
  });

  test('recognises "Order of [date]", the same dating convention "Judgment of [date]" uses', () => {
    // Found via a proactive citation-format sweep: only "Order of the Court" was
    // recognised, not this at-least-as-common dating convention — an order cited
    // this way was silently mislabelled as a judgment.
    const [citation] = detectCitations('Order of 17 November 2009, Akzo Nobel v Commission, ECLI:EU:C:2009:712, para. 15.');
    assert.equal(citation.documentType, 'order');
    assert.equal(citation.label, 'CJEU order');
  });
});

describe('EU legislation', () => {
  test('maps a directive to the L sector', () => {
    const citation = find('Directive 2002/58/CE, Article 15', 'Directive 2002/58/CE');
    assert.equal(citation?.celex, '32002L0058');
    assert.equal(citation?.label, 'EU directive');
    assert.equal(citation?.source, 'eur-lex');
  });

  test('maps a regulation to the R sector', () => {
    const citation = find('Regulation (EU) 2016/679/EU applies.', 'Regulation (EU) 2016/679/EU');
    assert.equal(citation?.celex, '32016R0679');
    assert.equal(citation?.label, 'EU regulation');
  });

  test('recognises the French act name with a trailing suffix', () => {
    const citation = find('Règlement (CE) 2016/679/CE', 'Règlement (CE) 2016/679/CE');
    assert.equal(citation?.celex, '32016R0679');
    assert.equal(citation?.label, 'EU regulation');
  });

  test('maps a published decision to the D sector', () => {
    const citation = find('Decision 2010/87/EU', 'Decision 2010/87/EU');
    assert.equal(citation?.celex, '32010D0087');
    assert.equal(citation?.label, 'EU decision');
  });

  test('maps a recommendation to the H sector', () => {
    // "Recommendation" was missing from the keyword list entirely — found by
    // testing a batch of realistic citation formats beyond the ones already
    // fixed. Confirmed live that recommendations use CELEX sector letter 'H',
    // not 'D': 32003H0361 resolves against the real EUR-Lex/CELLAR endpoint,
    // 32003D0361 (the 'D' guess) 404s.
    const citation = find('Commission Recommendation 2003/361/EC concerning SMEs.', 'Recommendation 2003/361/EC');
    assert.equal(citation?.celex, '32003H0361');
    assert.equal(citation?.label, 'EU recommendation');
  });
});

describe('post-2015 legislation (bracketed sector, no trailing suffix)', () => {
  test('recognises the GDPR', () => {
    const citation = find('Regulation (EU) 2016/679', 'Regulation (EU) 2016/679');
    assert.equal(citation?.celex, '32016R0679');
    assert.equal(citation?.label, 'EU regulation');
  });

  test('recognises a post-2015 directive', () => {
    const citation = find('Directive (EU) 2016/680', 'Directive (EU) 2016/680');
    assert.equal(citation?.celex, '32016L0680');
    assert.equal(citation?.label, 'EU directive');
  });

  test('recognises the French bracket form', () => {
    const citation = find('Règlement (UE) 2016/679', 'Règlement (UE) 2016/679');
    assert.equal(citation?.celex, '32016R0679');
    assert.equal(citation?.label, 'EU regulation');
  });

  test('does not require the "(EU)" bracket to sit directly against the number', () => {
    const citation = find('Regulation (EU) 2016/679 of the European Parliament', 'Regulation (EU) 2016/679');
    assert.equal(citation?.celex, '32016R0679');
  });

  test('recognises the informal short form that drops the sector bracket entirely', () => {
    // Confirmed against a real citation ("Implementing Regulation 2023/814, Art. 8(5)")
    // and the CELEX it implies (32023R0814) against the live EUR-Lex/CELLAR endpoint.
    // The keyword plus an unambiguous 4-digit year is enough; the bracket is only
    // needed to disambiguate the "No" (pre-2015 regulation) case, which reverses
    // the number order — see parseActNumbers.
    const citation = find('Implementing Regulation 2023/814, Art. 8(5).', 'Regulation 2023/814');
    assert.equal(citation?.celex, '32023R0814');
    assert.equal(citation?.label, 'EU regulation');
    assert.deepEqual(citation?.locator, { kind: 'article', start: 8, paragraph: 5, end: undefined });
  });

  test('recognises a bracket-less directive the same way', () => {
    const citation = find('Directive 2019/1937 on whistleblower protection', 'Directive 2019/1937');
    assert.equal(citation?.celex, '32019L1937');
  });
});

describe('pre-2015 regulations (number/year, marked by "No")', () => {
  test('recognises Regulation (EC) No 1/2003 with a single-digit number', () => {
    const citation = find('Regulation (EC) No 1/2003', 'Regulation (EC) No 1/2003');
    assert.equal(citation?.celex, '32003R0001');
  });

  test('recognises the Merger Regulation, ignoring the "Council" prefix', () => {
    const citation = find('Council Regulation (EC) No 139/2004', 'Regulation (EC) No 139/2004');
    assert.equal(citation?.celex, '32004R0139');
  });

  test('recognises Brussels Ia', () => {
    const citation = find('Regulation (EU) No 1215/2012', 'Regulation (EU) No 1215/2012');
    assert.equal(citation?.celex, '32012R1215');
  });
});

/**
 * These remain unrecognised by design, so the boundary is visible rather than
 * implied.
 */
describe('known detection gaps', () => {
  test('does not resolve the two-digit year of the old EEC convention', () => {
    // "Regulation (EEC) No 2913/92" predates the four-digit-year convention;
    // resolving the implied century (19xx) is not attempted.
    assert.deepEqual(detectCitations('Regulation (EEC) No 2913/92'), []);
  });

  test('does not take a four-digit regulation number for its year', () => {
    // The 1989 Merger Regulation, as the 2026 draft merger guidelines cite it. Read year-first
    // it became CELEX 34064R0089, reported as resolved.
    assert.deepEqual(detectCitations('Notes on Council Regulation 4064/89, p. 25.'), []);
  });

  test('does not read a pre-2015 regulation year-first', () => {
    // Number 1998 of 2006. A regulation's year has led only since 2015, so the year-first
    // reading would be a regulation of 1998 — another document. Bracket-less number/year is
    // not read at all, so this reports nothing rather than the wrong act.
    assert.deepEqual(detectCitations('Commission Regulation 1998/2006 on de minimis aid'), []);
  });
});

describe('Treaty articles', () => {
  // Likely the single most common EU-law citation format of all, previously
  // undetected entirely. Individual treaty articles carry their own
  // dedicated CELEX identifier — confirmed live against the real EUR-Lex/
  // CELLAR endpoint: 12016E101 (TFEU Art. 101), 12016M006 (TEU Art. 6), and
  // 12016P047 (Charter Art. 47) each resolve to a small single-article
  // document containing the correct provision. See celexForTreatyArticle.
  test('recognises a TFEU article', () => {
    const [citation] = detectCitations('This infringes Article 101 TFEU and is void.');
    assert.equal(citation.celex, '12016E101');
    assert.equal(citation.label, 'TFEU article');
    assert.equal(citation.source, 'eur-lex');
    assert.deepEqual(citation.locator, { kind: 'article', start: 101, paragraph: undefined });
  });

  test('recognises a TEU article with a paragraph locator', () => {
    const [citation] = detectCitations('See Article 6(3) TEU.');
    assert.equal(citation.celex, '12016M006');
    assert.equal(citation.label, 'TEU article');
    assert.deepEqual(citation.locator, { kind: 'article', start: 6, paragraph: 3 });
  });

  test('recognises the Charter, with or without "of Fundamental Rights" spelled out', () => {
    const short = detectCitations('Article 47 of the Charter guarantees an effective remedy.');
    assert.equal(short[0].celex, '12016P047');
    assert.equal(short[0].label, 'Charter article');

    const long = detectCitations('Article 47 of the Charter of Fundamental Rights guarantees an effective remedy.');
    assert.equal(long[0].celex, '12016P047');
  });

  test('recognises the Charter abbreviation "CFR"', () => {
    const [citation] = detectCitations('Article 8 CFR protects personal data.');
    assert.equal(citation.celex, '12016P008');
  });

  test('recognises the French treaty abbreviations and the "de la" form', () => {
    const teu = detectCitations('Voir article 6 TUE.');
    assert.equal(teu[0].celex, '12016M006');

    const charter = detectCitations('article 47 de la Charte des droits fondamentaux.');
    assert.equal(charter[0].celex, '12016P047');
  });

  test('recognises the "Art." abbreviation for a treaty article', () => {
    const [citation] = detectCitations('Art. 102 TFEU prohibits abuse of dominance.');
    assert.equal(citation.celex, '12016E102');
  });

  test('does not treat a bare article number as a treaty citation without a treaty marker', () => {
    assert.deepEqual(detectCitations('Article 6 sets out the general obligations.'), []);
  });

  test('does not mistake an ECHR article for an EU treaty article', () => {
    // "Article 6 of the Convention" (European Convention on Human Rights) is
    // not an EU source; only the EU-treaty markers should match.
    assert.deepEqual(detectCitations('Article 6 of the Convention guarantees a fair trial.'), []);
  });
});

describe('Commission decisions', () => {
  test('routes a C(yyyy) decision to the Commission register', () => {
    const [citation] = detectCitations('Commission Decision C(2019) 3288 final');
    assert.equal(citation.source, 'commission');
    assert.equal(citation.label, 'Commission decision');
    assert.equal(citation.celex, undefined, 'CELEX is not derivable for C(yyyy) decisions');
  });

  test('detects the decision without the Commission prefix', () => {
    const [citation] = detectCitations('see Decision C(2017) 4444');
    assert.equal(citation.source, 'commission');
  });
});

describe('Commission competition case numbers', () => {
  // DG Competition's own case-number convention: distinct from the C(yyyy)
  // decision number above, and not preceded by "Decision" at all. Confirmed
  // against a real citation ("AT.37990, EC Decision of 22 September 2023...").
  test('recognises an antitrust case number', () => {
    const [citation] = detectCitations('AT.37990, EC Decision of 22 September 2023, para. 1(c).');
    assert.equal(citation.value, 'AT.37990');
    assert.equal(citation.source, 'commission');
    assert.equal(citation.label, 'Commission antitrust case');
  });

  test('recognises a State aid case number', () => {
    const [citation] = detectCitations('Case SA.12345 concerned a tax exemption.');
    assert.equal(citation.value, 'SA.12345');
    assert.equal(citation.label, 'Commission State aid case');
  });

  test('recognises a merger case number, with or without the COMP/ prefix', () => {
    const short = detectCitations('Case M.7217 (Facebook/WhatsApp).');
    assert.equal(short[0].value, 'M.7217');
    assert.equal(short[0].label, 'Commission merger case');

    const long = detectCitations('Case COMP/M.7217 (Facebook/WhatsApp).');
    assert.equal(long[0].value, 'COMP/M.7217');
    assert.equal(long[0].label, 'Commission merger case');
  });

  test('does not mistake "M." followed by a name for a merger case number', () => {
    // French abbreviation for "Monsieur" — must not collide with the merger
    // case format, which always has a digit immediately after the dot.
    assert.deepEqual(detectCitations('M. Dupont submitted observations.'), []);
  });
});

describe('locators', () => {
  test('reads a single point', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, point 80');
    assert.deepEqual(citation.locator, { kind: 'point', start: 80, paragraph: undefined, end: undefined });
  });

  test('reads a point range written with a hyphen', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, points 60-65');
    assert.deepEqual(citation.locator, { kind: 'point', start: 60, paragraph: undefined, end: 65 });
  });

  test('reads a point range written in French', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:238, points 24 à 29');
    assert.deepEqual(citation.locator, { kind: 'point', start: 24, paragraph: undefined, end: 29 });
  });

  test('reads an article locator', () => {
    const citation = find('Directive 2002/58/CE, Article 15', 'Directive 2002/58/CE');
    assert.deepEqual(citation?.locator, { kind: 'article', start: 15, paragraph: undefined, end: undefined });
  });

  test('ignores a locator that appears beyond the lookahead window', () => {
    const [citation] = detectCitations(`ECLI:EU:C:2014:317${' '.repeat(200)}point 80`);
    assert.equal(citation.locator, undefined);
  });

  // Found missing against a real client document: these abbreviations and
  // symbols are all common in practice and none were recognised before —
  // the citation itself was still detected, only the locator was silently lost.
  test('reads the "Art." abbreviation, including the paragraph within the article', () => {
    // "Art. 8(5)" is Article 8, paragraph 5 — not a range, and not "Article 8"
    // with the "(5)" discarded. Found missing against a real client document:
    // the excerpt showed the whole of Article 8 instead of just paragraph 5.
    const [citation] = detectCitations('ECLI:EU:C:2014:317, Art. 8(5)');
    assert.deepEqual(citation.locator, { kind: 'article', start: 8, paragraph: 5, end: undefined });
  });

  test('reads the "para." abbreviation', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, para. 1(c)');
    assert.deepEqual(citation.locator, { kind: 'point', start: 1, paragraph: undefined, end: undefined });
  });

  test('reads the "paras." plural abbreviation with a range', () => {
    // Found missing against a real client document ("paras. 35-36"): neither
    // "para\." (requires the "." right after "para", not after "paras") nor
    // the spelled-out "paragraphs?" matched it, so the locator was silently
    // lost even though the citation itself was still detected.
    const [citation] = detectCitations('ECLI:EU:C:2013:160, paras. 35-36');
    assert.deepEqual(citation.locator, { kind: 'point', start: 35, paragraph: undefined, end: 36 });
  });

  test('reads bare "paras" without a trailing period', () => {
    // Found via a proactive citation-format sweep: "paras 40-44" (no period) matched
    // neither "para\." (needs the period right after "para") nor "paragraphs?", so the
    // locator was silently lost even though "paras." (with a period) already worked.
    // Unlike singular "para", plural "paras" is not an ordinary English/French word on
    // its own, so no period is required to avoid false positives.
    const [citation] = detectCitations('ECLI:EU:C:2010:512, paras 40–44');
    assert.deepEqual(citation.locator, { kind: 'point', start: 40, paragraph: undefined, end: 44 });
  });

  test('does not let a later, incidental pinpoint override the actually-cited range', () => {
    // Before the bare-"paras" fix above, this silently reported paragraph 41 instead of
    // the cited 40-44 range, purely because "para. 41" happened to carry a period and
    // "paras 40-44" didn't — a wrong pinpoint shown with full confidence.
    const [citation] = detectCitations(
      'ECLI:EU:C:2010:512, paras 40–44, in particular para. 41.',
    );
    assert.deepEqual(citation.locator, { kind: 'point', start: 40, paragraph: undefined, end: 44 });
  });

  test('still requires the period for singular "para", to avoid colliding with other words', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, a para 40 discussion');
    assert.equal(citation.locator, undefined);
  });

  test('reads a section-sign locator with no space', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, §128');
    assert.deepEqual(citation.locator, { kind: 'point', start: 128, paragraph: undefined, end: undefined });
  });

  test('reads a pilcrow locator with no space', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, ¶87');
    assert.deepEqual(citation.locator, { kind: 'point', start: 87, paragraph: undefined, end: undefined });
  });

  test('does not treat the bare word "art" without a period as a locator', () => {
    const [citation] = detectCitations('ECLI:EU:C:2014:317, a fine art 15 exhibit');
    assert.equal(citation.locator, undefined);
  });
});

describe('Commission case locators', () => {
  // The AT./SA./M. detection loop did not call locatorAfter at all — found
  // missing against a real client document ("AT.37990 ... para. 1(c)"): the
  // citation was detected, but no locator was ever attached, unlike every
  // other citation family.
  test('attaches a locator to a Commission competition case number', () => {
    const [citation] = detectCitations('AT.37990, EC Decision of 22 September 2023, para. 1(c).');
    assert.deepEqual(citation.locator, { kind: 'point', start: 1, paragraph: undefined, end: undefined });
  });
});

describe('the name a Commission case is cited under', () => {
  // Kept to check the number against: the Commission's 2026 draft merger guidelines cite
  // `M.7967 – Ball/Rexam`, and M.7967 is another case. Every shape below is from those
  // guidelines or the guidelines on exclusionary abuses.
  const nameOf = (text: string, value: string) => find(text, value)?.caseName;

  test('after a dash, up to where the citation moves on', () => {
    assert.equal(nameOf('See, e.g., Case M.7967 – Ball/Rexam; and Case M.8713 – Tata Steel/thyssenkrupp/JV, paragraphs 1318 et seq.', 'M.7967'), 'Ball/Rexam');
    assert.equal(nameOf('See, e.g., Case M.7967 – Ball/Rexam; and Case M.8713 – Tata Steel/thyssenkrupp/JV, paragraphs 1318 et seq.', 'M.8713'), 'Tata Steel/thyssenkrupp/JV');
    assert.equal(nameOf('Case M.10301 – CVC/Ethniki (patients’ health data)', 'M.10301'), 'CVC/Ethniki');
    assert.equal(nameOf('Case M.7932 – Dow/DuPont and Case M.7278 – General Electric/Alstom (Thermal Power), paragraph 3.', 'M.7932'), 'Dow/DuPont');
    assert.equal(nameOf('Case M.1616 – BSCH/Champalimaud. The Commission also adopted decisions.', 'M.1616'), 'BSCH/Champalimaud');
    assert.equal(nameOf('Case M.12052 – UniCredit/Banco BPM.', 'M.12052'), 'UniCredit/Banco BPM');
    assert.equal(nameOf('Case M.9728 –Altice/Omers/Allianz/Covage, paragraph 12.', 'M.9728'), 'Altice/Omers/Allianz/Covage');
    assert.equal(nameOf('Case AT.40437 – Apple – App Store (music streaming), paragraph 7.', 'AT.40437'), 'Apple – App Store');
  });

  test('without a dash only where it is a merger’s Party/Party', () => {
    assert.equal(nameOf('Case M.6461 Outokumpu/Inoxum, paragraphs 496-510.', 'M.6461'), 'Outokumpu/Inoxum');
    assert.equal(nameOf('AT.37990, EC Decision of 22 September 2023, para. 1(c).', 'AT.37990'), undefined);
    assert.equal(nameOf('Case AT.39740 Google Shopping, paragraph 12.', 'AT.39740'), undefined, 'no slash and no dash: not taken as a name');
  });

  test('is not turned loose as a short form for the rest of the document', () => {
    const [, later] = getCitationContextsForFootnotes([
      'Case M.8713 – Tata Steel/thyssenkrupp/JV, paragraph 189.',
      'Tata Steel/thyssenkrupp/JV, paragraph 12.',
    ]);
    assert.deepEqual(later, []);
  });
});

describe('a Commission decision cited by its numbered sections', () => {
  // Every shape from the Commission's two 2026 sets of guidelines.
  const locatorOf = (text: string, value: string) => find(text, value)?.locator;

  test('one section, a range, and a list', () => {
    assert.deepEqual(locatorOf('See, e.g., Case M.10658 – Norsk Hydro/Alumetal, section 9.1.3.3.7.', 'M.10658'),
      { kind: 'section', start: 9, sections: [{ from: '9.1.3.3.7' }] });
    assert.deepEqual(locatorOf('Case M.11071 – Lufthansa/MEF/ITA, Sections 7.5-7.7.', 'M.11071'),
      { kind: 'section', start: 7, sections: [{ from: '7.5', to: '7.7' }] });
    assert.deepEqual(locatorOf('Case AT.40670 – Google - Adtech and Data-related practices, sections 8.3.4.1 and 8.4.4.1.', 'AT.40670'),
      { kind: 'section', start: 8, sections: [{ from: '8.3.4.1' }, { from: '8.4.4.1' }] });
  });

  test('each case keeps its own section, and one without takes none', () => {
    const text = 'Case M.11793 – Mytheresa/YNAP, Section 6.2.7, and Case M.10615 – Booking/eTraveli, Section 6.4.';
    assert.deepEqual(locatorOf(text, 'M.11793')?.sections, [{ from: '6.2.7' }]);
    assert.deepEqual(locatorOf(text, 'M.10615')?.sections, [{ from: '6.4' }]);
    assert.equal(locatorOf('Case M.7967 – Ball/Rexam and Case M.8713 – Tata Steel, section 5.', 'M.7967'), undefined);
  });

  test("an annex's section is not the decision's", () => {
    assert.equal(locatorOf('Case M.7932 – Dow/DuPont, Annex 5, Section 6.', 'M.7932'), undefined);
  });

  test('a paragraph pinpoint is still a paragraph pinpoint', () => {
    assert.equal(locatorOf('Case M.8713 – Tata Steel/thyssenkrupp/JV, paragraphs 189 et seq.', 'M.8713')?.kind, 'point');
  });
});

/**
 * Every text below is a footnote of the Commission's 2026 draft merger guidelines, and every
 * one put a passage the drafter never cited on screen under a case they did cite. Found by
 * comparing detection against an answer key built from the published PDF without reference
 * to what detection reported — `scripts/answer-keys/`.
 */
describe('a Commission case takes only its own pinpoint', () => {
  const citation = (text: string, value: string) => find(text, value);

  test('not the paragraph of the case cited after it in the same sentence (footnote 143)', () => {
    const text = 'See, e.g., Case M.7278 – General Electric/Alstom (Thermal Power - Renewable Power & Grid Business), Section 8.7.3 and Case M.11177 – Pfizer/Seagen, paragraph 183.';
    assert.deepEqual(citation(text, 'M.7278')?.locator, { kind: 'section', start: 8, sections: [{ from: '8.7.3' }] });
    assert.equal(citation(text, 'M.7278')?.pinpoint, undefined);
    assert.deepEqual(citation(text, 'M.11177')?.pinpoint, { paragraphs: [183] });
  });

  test('a case with no pinpoint of its own takes none from the next (footnote 144)', () => {
    const text = 'See, e.g., Cases M.7932 - Dow/DuPont and Case M.7278 – General Electric/Alstom (Thermal Power - Renewable Power & Grid Business), paragraph 387 and Section 8.7.4.';
    assert.equal(citation(text, 'M.7932')?.locator, undefined);
    assert.deepEqual(citation(text, 'M.7278')?.pinpoint, { paragraphs: [387] });
  });

  test('nor from a judgment cited after it', () => {
    const text = 'See, e.g., Case M.7612 – Hutchison 3G UK/Telefonica UK, and Judgment of 13 July 2023, European Commission v CK Telecoms UK Investments Ltd, C-376/20 P, EU:C:2023:561, paragraph 165.';
    assert.equal(citation(text, 'M.7612')?.locator, undefined);
  });

  test('a parenthesis describing which decision is meant is not a pinpoint (footnote 472)', () => {
    const text = 'Case M.1616 –  BSCH/Champalimaud (Article 21(3) decision of 20.07.1999), paragraphs 65-67; Case M.10494 – VIG/AEGON CEE, paragraph 32.';
    const bsch = citation(text, 'M.1616');
    assert.equal(bsch?.locator?.kind, 'point');
    assert.deepEqual(bsch?.pinpoint, { paragraphs: [65, 66, 67] });
    assert.deepEqual(citation('Case M.4197 – E.ON/Endesa (decision of 20.12.2006), paragraph 25.', 'M.4197')?.pinpoint, { paragraphs: [25] });
  });

  test('nor from the sentence after it (footnote 432)', () => {
    const text = 'See Case M.1346 – EDF / London Electricity; Case M.567 – Lyonnaise des Eaux / Northumbrian Water. The application of Article 21 EUMR has also been considered in a number of other cases.';
    assert.equal(citation(text, 'M.567')?.locator, undefined);
    assert.deepEqual(citation('Case M.8124 – Microsoft/LinkedIn, para. 350. See also recital 12.', 'M.8124')?.pinpoint, { paragraphs: [350] },
      'an abbreviation before the pinpoint is not the end of the sentence');
  });

  test("an annex's paragraph is not the decision's", () => {
    assert.equal(citation('See, e.g., Case M.9730 – FCA/PSA, Economic Annex, paragraph 45.', 'M.9730')?.locator, undefined);
    assert.equal(citation('See, e.g., Case M.10896 – Orange/MásMóvil, Annex A, paragraph 5 et seq.', 'M.10896')?.locator, undefined);
    assert.equal(citation('See, e.g., Case M.7612 – H3G UK/Telefónica UK, Annex A, paragraphs 96-100 and Section 3.1.', 'M.7612')?.locator, undefined);
    assert.deepEqual(citation('See, e.g., Case M.7932 – Dow/DuPont, paragraphs 2337–2352 and Annex 5.', 'M.7932')?.locator,
      { kind: 'point', start: 2337, paragraph: undefined, end: 2352 }, 'an annex named after the pinpoint takes nothing from it');
  });
});

describe('a lettered paragraph is not the paragraph its number names', () => {
  // Orange/MásMóvil numbers paragraphs inserted into its decision `1605a` and `1694b`; the
  // guidelines cite three of them. Read as 1605, the pane showed the paragraph before the one
  // cited.
  test('refused, rather than read as its number', () => {
    assert.equal(find('See, e.g., Case M.10896 – Orange/MásMóvil, paragraph 1605a.', 'M.10896')?.locator, undefined);
    assert.equal(find('Case M.10896 – Orange/MásMóvil, paragraph 1694b; Case M.7000 – Liberty Global/Ziggo, paragraph 373.', 'M.10896')?.locator, undefined);
    assert.equal(find('Directive 2002/58/EC, Article 15a', 'Directive 2002/58/EC')?.locator, undefined);
  });

  test('the forms that only look similar still read', () => {
    assert.deepEqual(find('Case C-131/12, ECLI:EU:C:2014:317, para. 1(c).', 'ECLI:EU:C:2014:317')?.locator,
      { kind: 'point', start: 1, paragraph: undefined, end: undefined });
    assert.equal(find('Regulation (EU) 2016/679, Article 17(1)(b)', 'Regulation (EU) 2016/679')?.locator?.start, 17);
    assert.equal(find('Case M.10896 – Orange/MásMóvil, paragraph 1605 and 1606.', 'M.10896')?.locator?.start, 1605);
  });
});

describe('an act named in the title of another act', () => {
  // Footnote 47 of the 2026 draft merger guidelines. The paragraphs are the Form's, in Annex I
  // to Regulation 2023/914; the acts the title names were given them.
  const text = 'See also Annex I to the Commission Implementing Regulation (EU) 2023/914 of 20 April 2023 implementing Council Regulation (EC) No 139/2004 on the control of concentrations between undertakings and repealing Commission Regulation (EC) No 802/2004, Form Relating to the Notification of a Concentration Pursuant to Council Regulation (EC) No 139/2004, paragraphs 13-14.';

  test('takes no pinpoint that belongs to the act whose title it is in', () => {
    const acts = detectCitations(text).filter((citation) => citation.source === 'eur-lex');
    assert.deepEqual(acts.map((citation) => citation.celex), ['32023R0914', '32004R0139', '32004R0802', '32004R0139']);
    assert.deepEqual(acts.map((citation) => citation.locator), [undefined, undefined, undefined, undefined]);
  });

  test('an act cited for itself keeps its pinpoint', () => {
    assert.equal(find('See Regulation (EU) 2022/1925, Article 6(5).', 'Regulation (EU) 2022/1925')?.locator?.start, 6);
    assert.equal(find('Undertakings operating under Regulation (EU) 2022/1925, Article 6(5), must comply.', 'Regulation (EU) 2022/1925')?.locator?.start, 6,
      '"under" alone is prose; it is a title only where an instrument was named before it');
  });
});

describe('pinpoints cited "et seq."', () => {
  // From the Commission's 2026 draft merger guidelines, footnote 28. The list stopped at the
  // first "et seq.", so the pane showed recital 189 as all of what this footnote cites.
  test('keeps every paragraph of a list whose items are each "et seq."', () => {
    const [citation] = detectCitations('See, e.g., Case M.8713 – Tata Steel/thyssenkrupp/JV, paragraphs 189 et seq., 1324 et seq. and 1398 et seq.');
    assert.deepEqual(citation.pinpoint, { paragraphs: [189, 1324, 1398], following: [189, 1324, 1398] });
    assert.equal(citation.locator?.start, 189);
  });

  test('and does not reach across the semicolon into the next case', () => {
    // Footnote 30 of the same guidelines.
    const text = 'See, e.g., Case M.7932 – Dow/DuPont, paragraphs 1975 et seq.; Case M.8084 – Bayer/Monsanto, paragraphs 61 et seq., 1004 et seq.; and Case M.11177 – Pfizer/Seagen, paragraphs 18-20, 179-185.';
    assert.deepEqual(find(text, 'M.7932')?.pinpoint, { paragraphs: [1975], following: [1975] });
    assert.deepEqual(find(text, 'M.8084')?.pinpoint, { paragraphs: [61, 1004], following: [61, 1004] });
    assert.deepEqual(find(text, 'M.11177')?.pinpoint, { paragraphs: [18, 19, 20, 179, 180, 181, 182, 183, 184, 185] },
      'a list with no "et seq." carries no `following`');
  });

  test('reads the other spellings: ff., et seqq., and the French et s. and et suiv.', () => {
    assert.deepEqual(detectCitations('Case M.8124, paragraph 350 ff.')[0].pinpoint, { paragraphs: [350], following: [350] });
    assert.deepEqual(detectCitations('Case M.8124, paragraphs 350 et seqq.')[0].pinpoint, { paragraphs: [350], following: [350] });
    // French "et" is also a joiner, which is exactly what the list used to be split on.
    assert.deepEqual(detectCitations('Affaire AT.39740, points 40 et s. et 52 et suiv.')[0].pinpoint,
      { paragraphs: [40, 52], following: [40, 52] });
    assert.deepEqual(detectCitations('Affaire AT.39740, points 40 et 52.')[0].pinpoint, { paragraphs: [40, 52] });
  });

  test('marks only the items that say so', () => {
    const [citation] = detectCitations('Case C-413/14 P, paras 40–44, 46 et seq. and 48.');
    assert.deepEqual(citation.pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46, 48], following: [46] });
  });
});

describe('result set', () => {
  test('returns citations in document order', () => {
    const text = 'Directive 2002/58/CE, then Case C-293/12, then C(2019) 3288.';
    const indexes = detectCitations(text).map((citation) => citation.index);
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes);
  });

  test('returns an empty list when nothing is recognised', () => {
    assert.deepEqual(detectCitations('This footnote cites no EU source.'), []);
  });

  test('keeps the same citation cited at two different positions', () => {
    const citations = detectCitations('Case C-293/12 ... and again Case C-293/12.');
    assert.equal(citations.length, 2);
  });
});

describe('detectCitationsAcrossFootnotes (explicitly defined short forms)', () => {
  // The single most common real citation pattern: cite in full once, then abbreviate for
  // the rest of the document. detectCitations alone cannot resolve the later, shorthand
  // footnotes — it only ever sees one footnote's text at a time.
  test('resolves a later footnote that only uses a defined case-name short form', () => {
    const [, second] = detectCitationsAcrossFootnotes([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40 ("Akzo Nobel").',
      'Akzo Nobel, para. 45.',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].ecli, 'ECLI:EU:C:2010:512');
    assert.equal(second[0].source, 'curia');
    assert.deepEqual(second[0].locator, { kind: 'point', start: 45, paragraph: undefined, end: undefined });
  });

  test('resolves a later footnote that only uses a defined legislation acronym', () => {
    const [, second] = detectCitationsAcrossFootnotes([
      'Regulation (EU) 2022/1925 (the "DMA").',
      'DMA, Article 6(5).',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].celex, '32022R1925');
    assert.deepEqual(second[0].locator, { kind: 'article', start: 6, paragraph: 5, end: undefined });
  });

  test('recognises a curly-quoted defined term', () => {
    const [, second] = detectCitationsAcrossFootnotes([
      'Opinion of Advocate General Kokott, ECLI:EU:C:2010:229 (“Kokott Opinion”).',
      'Kokott Opinion, para. 12.',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].ecli, 'ECLI:EU:C:2010:229');
    assert.equal(second[0].documentType, 'opinion');
  });

  test('does not self-match the definition footnote against its own parenthetical', () => {
    const [first] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512, para. 40 ("Akzo Nobel").',
    ]);
    assert.equal(first.length, 1, 'only the hard ECLI match, not a spurious second match on "Akzo Nobel"');
  });

  test('reports an undefined short form as an unresolved gap rather than silently dropping it', () => {
    // Previously this returned nothing at all: a bare party name was never matched, so a
    // real citation the reader would recognise came back as "no citation in this footnote".
    // "Intel" names more than one EU competition case and this footnote gives nothing to
    // choose between them, so the reviewer is shown the candidates and asked, not guessed at.
    const [only] = detectCitationsAcrossFootnotes(['Intel, para. 132.']);
    assert.equal(only.length, 1);
    assert.equal(only[0].status, 'unresolved_ambiguous');
    assert.equal(only[0].celex, undefined, 'an ambiguous short form must never carry a resolved identifier');
    assert.ok((only[0].candidates?.length ?? 0) > 1);
  });

  test('resolves a party name that the document cited in full but never defined in quotes', () => {
    // Most drafting never declares a short form in quotes at all — it states the case in
    // full once and abbreviates from then on. Requiring an explicit parenthetical missed
    // every one of those, which is the common case, not the exception.
    const [, second] = detectCitationsAcrossFootnotes([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40.',
      'Akzo Nobel, para. 45.',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].status, 'resolved');
    assert.equal(second[0].resolutionMethod, 'generated_variant');
    assert.equal(second[0].ecli, 'ECLI:EU:C:2010:512');
    assert.deepEqual(second[0].locator, { kind: 'point', start: 45, paragraph: undefined, end: undefined });
  });

  test('does not treat an inferred short form used as prose as a citation', () => {
    // A generated variant is inferred, not declared, so it only counts where the text is
    // unmistakably citing: carrying a pinpoint. Without this, "the Akzo Nobel line of
    // cases" would put a source panel behind a phrase the drafter never meant as a
    // reference.
    const [, second] = detectCitationsAcrossFootnotes([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40.',
      'This follows the Akzo Nobel line of cases.',
    ]);
    assert.deepEqual(second, []);
  });

  test('an explicitly declared short form still needs no pinpoint', () => {
    const [, second] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512 ("Akzo Nobel").',
      'This follows Akzo Nobel.',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].resolutionMethod, 'explicit_alias');
  });

  test('does not duplicate a citation when a footnote uses both the short form and the full identifier together', () => {
    // e.g. "See Akzo Nobel, ECLI:EU:C:2010:512, para. 40" — "Akzo Nobel" is plain framing
    // text right next to the restated ECLI for the very same document, not a second,
    // independent shorthand reference; it must not produce a duplicate chip.
    const [, second] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512 ("Akzo Nobel").',
      'See Akzo Nobel, ECLI:EU:C:2010:512, para. 40; and Case C-1/10, Second Authority, paras 25–27.',
    ]);
    assert.equal(second.length, 2, 'the Akzo Nobel ECLI once, and the unrelated C-1/10, not three');
    assert.equal(second.filter((citation) => citation.ecli === 'ECLI:EU:C:2010:512').length, 1);
  });

  test('resolves the same defined term across multiple later footnotes independently', () => {
    const [, second, third] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512 ("Akzo Nobel").',
      'Akzo Nobel, para. 41.',
      'See further Akzo Nobel, para. 60.',
    ]);
    assert.deepEqual(second[0].locator, { kind: 'point', start: 41, paragraph: undefined, end: undefined });
    assert.deepEqual(third[0].locator, { kind: 'point', start: 60, paragraph: undefined, end: undefined });
  });

  // From the Commission's 2026 draft merger guidelines. The term names the Notice, which
  // detection does not report; the Regulation is only in the Notice's title. Bound to the
  // Regulation, every later use of the term showed the Merger Regulation as the document cited.
  test('does not give an act the term defined for a notice whose title names it', () => {
    const [first, second] = detectCitationsAcrossFootnotes([
      'See Commission Notice on a simplified treatment for certain concentrations under Council Regulation (EC) No 139/2004 on the control of concentrations between undertakings, OJ C 160, 5.5.2023, p.1 (‘Notice on Simplified Procedure’).',
      'Notice on Simplified Procedure, paragraph 5(d)(bb).',
    ]);
    assert.deepEqual(first.map((citation) => citation.celex), ['32004R0139'], 'the Regulation is still cited where it is named');
    // What is left is the ordinary report of a name Ibid cannot place: asked about, not answered.
    assert.ok(second.length > 0);
    assert.ok(second.every((citation) => citation.status !== 'resolved' && !citation.celex && !citation.ecli && !citation.caseNumber));
  });

  test('does not give a term to an act named inside another act’s title', () => {
    // Nearest to the term is the Regulation being repealed. Nor does the term pass back to the
    // act at the head of the title: whether it would be right to is not something the text
    // around a single citation can settle, and an undefined term shows nothing wrong.
    const [, second] = detectCitationsAcrossFootnotes([
      'Commission Implementing Regulation (EU) 2023/914 implementing Council Regulation (EC) No 139/2004 and repealing Commission Regulation (EC) No 802/2004 (‘Implementing Regulation’).',
      'See the Implementing Regulation.',
    ]);
    assert.deepEqual(second, []);
  });

  test('does not give a judgment’s short name to the Treaty article it interprets', () => {
    const [, second] = detectCitationsAcrossFootnotes([
      'Judgment of 6 September 2017, Intel v Commission, C-413/14 P, EU:C:2017:632, on Article 102 TFEU (‘Intel’).',
      'Intel, paragraph 138.',
    ]);
    assert.equal(second.some((citation) => citation.celex === '12016E102'), false);
  });

  test('still gives the term to the act it follows where nothing else is named first', () => {
    // The same guidelines, and the shape the rule above must leave alone: an article of the
    // act is not a different instrument.
    const [, second] = detectCitationsAcrossFootnotes([
      'As guaranteed by Article 22 of Regulation (EU) 2024/1083 establishing a common framework for media services in the internal market (the ‘European Media Freedom Act’).',
      'Article 22 European Media Freedom Act.',
    ]);
    assert.equal(second.length, 1);
    assert.equal(second[0].celex, '32024R1083');
    assert.equal(second[0].resolutionMethod, 'explicit_alias');
  });

  test('reads each act of a list against its own term', () => {
    // A term already declared ends the reference it closed, so the second act is not taken
    // for part of the first one's title.
    const [, second] = detectCitationsAcrossFootnotes([
      'Regulation (EU) 2022/1925 (‘DMA’) and Regulation (EU) 2022/2065 (‘DSA’).',
      'DMA, Article 6; DSA, Article 34.',
    ]);
    assert.deepEqual(second.map((citation) => citation.celex), ['32022R1925', '32022R2065']);
  });
});

describe('getCitationContextsForFootnotes', () => {
  test('carries the resolved citation fields and builds a context around the short form', () => {
    const [, second] = getCitationContextsForFootnotes([
      'ECLI:EU:C:2010:512 ("Akzo Nobel").',
      'Akzo Nobel, para. 45.',
    ]);
    assert.equal(second[0].ecli, 'ECLI:EU:C:2010:512');
    assert.ok(second[0].context.includes('Akzo Nobel, para. 45'));
  });
});

describe('getCitationContexts', () => {
  test('collapses whitespace in the surrounding context', () => {
    const [context] = getCitationContexts('Judgment in\n\n   Case C-293/12   here.');
    assert.ok(!/\s{2}/.test(context.context));
    assert.ok(context.context.includes('C-293/12'));
  });

  test('marks a truncated context with ellipses on both sides', () => {
    const filler = 'x'.repeat(400);
    const [context] = getCitationContexts(`${filler} Case C-293/12 ${filler}`);
    assert.ok(context.context.startsWith('…'));
    assert.ok(context.context.endsWith('…'));
  });

  test('omits ellipses when the whole text is inside the radius', () => {
    const [context] = getCitationContexts('Case C-293/12.');
    assert.ok(!context.context.startsWith('…'));
    assert.ok(!context.context.endsWith('…'));
  });

  test('honours a custom radius', () => {
    const filler = 'x'.repeat(400);
    const [narrow] = getCitationContexts(`${filler} Case C-293/12 ${filler}`, 20);
    const [wide] = getCitationContexts(`${filler} Case C-293/12 ${filler}`, 200);
    assert.ok(narrow.context.length < wide.context.length);
  });

  test('carries the citation fields through unchanged', () => {
    const [context] = getCitationContexts('Directive 2002/58/CE, Article 15');
    assert.equal(context.celex, '32002L0058');
    assert.equal(context.source, 'eur-lex');
  });
});

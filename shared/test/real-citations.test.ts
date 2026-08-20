import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { citedAuthorities, detectCitationsAcrossFootnotes, PREVIEW_FOOTNOTES, type CitationMatch } from '../src/index.ts';

/**
 * A realistic EU data-protection and competition memo, written the way the citations
 * actually appear in practice — full cites, joined cases, a French-language footnote,
 * declared and undeclared short forms, two authorities in one footnote, Advocate General
 * opinions, legislation cited both ways round, Charter and Treaty articles.
 *
 * Every case number and ECLI below was verified against the live CELLAR record on
 * 2026-08-14, by fetching each judgment's RDF metadata (`Accept: application/rdf+xml`) and
 * comparing the ECLI it declares against the one written here. That matters more than it
 * sounds: the judgment *text* served by CELLAR does not contain its own ECLI, so an
 * earlier check against the document body could not have caught a wrong one — it reported
 * every citation as a mismatch and told us nothing. Fixtures asserting made-up identifiers
 * would make this whole suite worse than useless, since it would pass while being wrong.
 *
 * Re-verify the same way before adding any citation here.
 */
export const MEMO_FOOTNOTES = PREVIEW_FOOTNOTES;

const resolved = detectCitationsAcrossFootnotes(MEMO_FOOTNOTES);
const footnote = (number: number): CitationMatch[] => resolved[number - 1];
const one = (number: number): CitationMatch => {
  const citations = footnote(number);
  assert.equal(citations.length, 1, `footnote ${number}: expected one citation, got ${citations.map((c) => `"${c.value}"`).join(', ') || 'none'}`);
  return citations[0];
};

describe('real citations — full cites carry the right identifiers', () => {
  test('a case number and ECLI stated together derive a consistent CELEX', () => {
    const google = one(3);
    assert.equal(google.ecli, 'ECLI:EU:C:2014:317');
    assert.equal(google.caseNumber, 'C-131/12');
    assert.equal(google.celex, '62012CJ0131');
    assert.deepEqual(google.pinpoint, { paragraphs: [80, 81, 82, 88] });
  });

  test('a joined-cases group takes the first case number and reports one citation', () => {
    const dri = one(6);
    assert.equal(dri.caseNumber, 'C-293/12');
    assert.equal(dri.celex, '62012CJ0293');
  });

  test('the French joined-cases form is read the same way', () => {
    const tele2 = one(7);
    assert.equal(tele2.ecli, 'ECLI:EU:C:2016:970');
    assert.equal(tele2.caseNumber, 'C-203/15');
    assert.deepEqual(tele2.pinpoint, { paragraphs: [112] });
  });

  test('an Advocate General opinion gets the opinion CELEX, not the judgment one', () => {
    // The sector is derived from the document type, so an opinion is retrievable in its own
    // right — `CC`, not the judgment's `CJ`. Both confirmed live: 62012CC0131 is AG
    // Jääskinen in Google Spain and 62014CC0413 is AG Wahl in Intel, and each focuses on
    // the cited point.
    assert.equal(one(5).documentType, 'opinion');
    assert.equal(one(5).celex, '62012CC0131');
    assert.equal(one(16).documentType, 'opinion');
    assert.equal(one(16).celex, '62014CC0413');
  });

  test('an opinion takes its case number from the case, not from a document in it', () => {
    // "Opinion of Advocate General Jääskinen … in Google Spain" states no case number. The
    // number belongs to the case, so it comes from the judgment cited in full at footnote 3
    // — and only the number: the opinion stays a separate authority from the judgment.
    assert.equal(one(5).caseNumber, 'C-131/12');
    assert.equal(one(3).caseNumber, 'C-131/12');
    assert.notEqual(one(5).celex, one(3).celex, 'same case, different documents');
    assert.notEqual(one(5).ecli, one(3).ecli);
  });

  test('legislation is read with the provision on either side of it', () => {
    assert.equal(one(1).celex, '32016R0679');
    assert.deepEqual(one(1).locator, { kind: 'article', start: 17, paragraph: undefined, end: undefined });
    assert.equal(one(9).celex, '32002L0058');
    assert.deepEqual(one(9).locator, { kind: 'article', start: 15, paragraph: 1, end: undefined });
  });

  test('Charter and Treaty articles resolve to their own per-article CELEX', () => {
    assert.deepEqual(footnote(13).map((citation) => citation.celex), ['12016P007', '12016P047']);
    assert.equal(one(17).celex, '12016E102');
  });
});

describe('real citations — short forms resolved from the document', () => {
  test('a declared acronym resolves', () => {
    assert.equal(one(2).resolutionMethod, 'explicit_alias');
    assert.equal(one(2).celex, '32016R0679');
    assert.deepEqual(one(2).locator, { kind: 'article', start: 17, paragraph: 1, end: undefined });
  });

  test('an undeclared case name resolves from the full citation earlier', () => {
    assert.equal(one(4).resolutionMethod, 'generated_variant');
    assert.equal(one(4).ecli, 'ECLI:EU:C:2014:317');
    assert.deepEqual(one(4).pinpoint, { paragraphs: [97] });
  });

  test('two short forms in one footnote each keep their own pinpoint', () => {
    // The semicolon splits them; without that the first would take the second's paragraph.
    const [dri, tele2] = footnote(8);
    assert.equal(dri.ecli, 'ECLI:EU:C:2014:238');
    assert.deepEqual(dri.pinpoint, { paragraphs: [62, 65] });
    assert.equal(tele2.ecli, 'ECLI:EU:C:2016:970');
    assert.deepEqual(tele2.pinpoint, { paragraphs: [119] });
  });

  test('a case known by a party that is not the applicant still resolves', () => {
    // Intel Corp. v Commission — the applicant, so this is the ordinary path.
    assert.equal(one(15).resolutionMethod, 'generated_variant');
    assert.equal(one(15).caseNumber, 'C-413/14 P');
    assert.deepEqual(one(15).pinpoint, { paragraphs: [133] });
  });

  test('a numbered back-reference reaches five footnotes back to the judgment it names', () => {
    assert.equal(one(19).resolutionMethod, 'numbered_footnote');
    assert.equal(one(19).caseNumber, 'C-413/14 P');
    assert.equal(one(19).backReference?.footnote, 14);
    assert.deepEqual(one(19).pinpoint, { paragraphs: [140] });
  });

  test('a bare Ibid. takes both the authority and the pinpoint from the reference before it', () => {
    assert.equal(one(20).resolutionMethod, 'preceding_citation');
    assert.equal(one(20).caseNumber, 'C-413/14 P');
    assert.equal(one(20).backReference?.footnote, 19);
    assert.deepEqual(one(20).pinpoint, { paragraphs: [140] },
      'inherited from footnote 19, which was itself a back-reference — the chain has to hold');
  });

  test('back-references add no authority of their own to the review list', () => {
    // They resolve to the Intel judgment footnote 14 already establishes, so the reviewer's
    // pick-list must come out identical to the same memo without them. Compared whole
    // rather than counted per case number: Intel legitimately holds two entries there — the
    // judgment and Advocate General Wahl's opinion in it — and counting would hide which.
    const withoutBackReferences = citedAuthorities(detectCitationsAcrossFootnotes(MEMO_FOOTNOTES.slice(0, 18)));
    assert.deepEqual(citedAuthorities(resolved), withoutBackReferences);
  });
});

describe('real citations — the ambiguity that a real document actually produces', () => {
  test('"Schrems" is ambiguous once the document cites both Schrems judgments', () => {
    // This is not a contrived case. Schrems II is "Data Protection Commissioner v Facebook
    // Ireland and Schrems" — Schrems is the respondent — so generating applicant-side names
    // only made it unreachable by the name every lawyer uses, and a bare "Schrems" resolved
    // silently to Schrems I. Both are cited in full here, paragraph 94 exists in both, and
    // nothing in the document says which is meant.
    const schrems = one(12);
    assert.equal(schrems.status, 'unresolved_ambiguous');
    assert.equal(schrems.ecli, undefined);
    assert.equal(schrems.celex, undefined);
    assert.deepEqual(schrems.candidates?.map((candidate) => candidate.caseNumber).sort(), ['C-311/18', 'C-362/14']);
  });

  test('a case never cited in this document is reported as a gap', () => {
    assert.equal(one(18).status, 'unresolved_not_found');
    assert.equal(one(18).value, 'Post Danmark');
  });

  test('everything else in the memo resolves', () => {
    const undecided = resolved.flat().filter((citation) => citation.status !== 'resolved');
    assert.deepEqual(undecided.map((citation) => citation.value), ['Schrems', 'Post Danmark']);
  });
});

describe('real citations — what the reviewer can pick from', () => {
  const authorities = citedAuthorities(resolved);

  test('offers every distinct authority the memo establishes, each once', () => {
    assert.equal(authorities.length, 13);
    assert.equal(new Set(authorities.map((authority) => authority.ecli ?? authority.celex)).size, 13);
  });

  test('keeps a judgment and its Advocate General opinion apart', () => {
    // They share a case and, where the name is readable, a name — but they are different
    // documents, and offering them as one would resolve a citation to the wrong text.
    const eclis = authorities.map((authority) => authority.ecli);
    assert.ok(eclis.includes('ECLI:EU:C:2017:632'), 'the Intel judgment');
    assert.ok(eclis.includes('ECLI:EU:C:2016:788'), 'AG Wahl in Intel');
  });

  test('the judgments offered carry the case number and CELEX needed to fetch them', () => {
    const google = authorities.find((authority) => authority.ecli === 'ECLI:EU:C:2014:317');
    assert.equal(google?.caseNumber, 'C-131/12');
    assert.equal(google?.celex, '62012CJ0131');
  });
});

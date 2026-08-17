import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  citationSegments, citedAuthorities, detectCitations, detectCitationsAcrossFootnotes, normaliseCaseNumber,
  parsePinpoint, reresolveBackReferences, shortNameVariants, FREQUENT_CASES, type CitationMatch,
} from '../src/index.ts';

const only = (matches: CitationMatch[]): CitationMatch => {
  assert.equal(matches.length, 1, `expected exactly one citation, got ${matches.map((m) => m.value).join(' | ') || 'none'}`);
  return matches[0];
};

const at = (footnotes: string[], index: number): CitationMatch[] => detectCitationsAcrossFootnotes(footnotes)[index];

describe('Layer 1 — pinpoint grammar', () => {
  test('parses a single paragraph', () => {
    assert.deepEqual(parsePinpoint('x, para. 40.', 1)?.pinpoint, { paragraphs: [40] });
  });

  test('expands a consecutive range', () => {
    assert.deepEqual(parsePinpoint('x, paras 40–44.', 1)?.pinpoint, { paragraphs: [40, 41, 42, 43, 44] });
  });

  test('parses a mixed list of ranges and single paragraphs', () => {
    // A pinpoint is a list, not a number. Reporting only "40" here would understate what
    // the drafter actually cited by six paragraphs.
    assert.deepEqual(parsePinpoint('x, paras 40–44, 46 and 48.', 1)?.pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46, 48] });
  });

  test('accepts the §§ convention for the same list', () => {
    assert.deepEqual(parsePinpoint('x, §§ 40-44, 46.', 1)?.pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46] });
  });

  test('still reports the first range through `locator`, which is what the source lookup narrows to', () => {
    assert.deepEqual(parsePinpoint('x, paras 40–44, 46 and 48.', 1)?.locator, { kind: 'point', start: 40, paragraph: undefined, end: 44 });
  });

  test('does not run a range across an implausible span', () => {
    // A typo must not expand into thousands of paragraph numbers; the endpoints are kept.
    assert.deepEqual(parsePinpoint('x, paras 40–4000.', 1)?.pinpoint, { paragraphs: [40, 4000] });
  });

  test('reads the provision-then-act form, where the pinpoint precedes the citation', () => {
    const citation = only(detectCitations('Article 6(5) of Regulation (EU) 2022/1925 applies.'));
    assert.equal(citation.celex, '32022R1925');
    assert.deepEqual(citation.locator, { kind: 'article', start: 6, paragraph: 5, end: undefined });
  });

  test('reads a recital cited by the same form', () => {
    const citation = only(detectCitations('See recital 65 of Regulation (EU) 2022/1925.'));
    assert.equal(citation.celex, '32022R1925');
    // 'point' is how the EUR-Lex adapter is told to anchor on a recital heading rather
    // than an article heading; only `kind: 'article'` takes the article path.
    assert.deepEqual(citation.locator, { kind: 'point', start: 65, paragraph: undefined, end: undefined });
  });

  test('does not attach a provision belonging to an earlier act in the same sentence', () => {
    const citations = detectCitations('Article 5 of Regulation (EU) 2016/679 and Regulation (EU) 2022/1925.');
    const dma = citations.find((citation) => citation.celex === '32022R1925');
    assert.equal(dma?.locator, undefined);
  });
});

describe('Layer 1 — case number spellings', () => {
  test('accepts the non-breaking hyphen CURIA itself renders', () => {
    // Confirmed live: CELLAR's XHTML of C-131/12 writes "C‑131/12" with U+2011. A pattern
    // accepting only "-" reads that footnote as containing no citation at all.
    const citation = only(detectCitations('Case C‑131/12 concerned the right to be forgotten.'));
    assert.equal(citation.caseNumber, 'C-131/12');
    assert.equal(citation.celex, '62012CJ0131');
  });

  test('keeps the appeal suffix, and does not let it change the derived CELEX', () => {
    const citation = only(detectCitations('Case C-550/07 P is the leading authority.'));
    assert.equal(citation.caseNumber, 'C-550/07 P');
    assert.equal(citation.celex, '62007CJ0550');
  });

  test('keeps a General Court referral-back suffix', () => {
    assert.equal(only(detectCitations('Case T-286/09 RENV.')).caseNumber, 'T-286/09 RENV');
  });

  test('normalises every accepted spelling to one identity', () => {
    assert.equal(normaliseCaseNumber('c–550/07 p'), 'C-550/07 P');
    assert.equal(normaliseCaseNumber('C550/07'), 'C-550/07');
  });

  test('does not mistake an abbreviated name for a case suffix', () => {
    assert.equal(only(detectCitations('Case C-1/10 Para 5 is unrelated.')).caseNumber, 'C-1/10');
  });
});

describe('Layer 1 — case names', () => {
  test('reads the party-versus-party name preceding an identifier', () => {
    const citation = only(detectCitations('Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40.'));
    assert.equal(citation.caseName, 'Akzo Nobel Chemicals and Akcros Chemicals v Commission');
  });

  test('reads a name stated after a joined-cases group', () => {
    const citation = only(detectCitations('Joined Cases C-293/12 and C-594/12 Digital Rights Ireland, ECLI:EU:C:2014:238.'));
    assert.equal(citation.caseName, 'Digital Rights Ireland');
  });

  test('does not invent a case name out of surrounding prose', () => {
    assert.equal(only(detectCitations('Judgment in ECLI:EU:C:2014:317.')).caseName, undefined);
    assert.equal(only(detectCitations('Case C-293/12 concerned data retention.')).caseName, undefined);
  });
});

describe('Layer 1 — footnote segment splitting', () => {
  test('splits a footnote on the semicolon separating independent authorities', () => {
    assert.deepEqual(citationSegments('a; b; c').map((segment) => segment.end), [1, 4, 7]);
  });

  test('never lets one authority take the next authority\'s pinpoint', () => {
    // Without segment bounds the forward scan from the ECLI runs straight past the
    // semicolon and reports paragraph 25 — the second authority's pinpoint — as this
    // judgment's. That is a wrong paragraph shown with full confidence.
    const citations = detectCitations('See Akzo Nobel, ECLI:EU:C:2010:512; and Case C-1/10, paras 25–27.');
    const akzo = citations.find((citation) => citation.ecli === 'ECLI:EU:C:2010:512');
    assert.equal(akzo?.locator, undefined);
    assert.deepEqual(citations.find((citation) => citation.caseNumber === 'C-1/10')?.pinpoint, { paragraphs: [25, 26, 27] });
  });
});

describe('Layer 2 — short-name variant generation', () => {
  test('drops the defendant and the secondary applicant, keeping shortening prefixes', () => {
    const variants = shortNameVariants('Akzo Nobel Chemicals and Akcros Chemicals v Commission');
    assert.ok(variants.includes('Akzo Nobel'));
    assert.ok(variants.includes('Akzo Nobel Chemicals'));
    assert.ok(variants.includes('Akzo'));
  });

  test('never emits a generic institutional defendant as a short form', () => {
    // "v Commission" ends hundreds of unrelated cases, so it can shorten none of them.
    const variants = shortNameVariants('Akzo Nobel Chemicals v Commission');
    assert.ok(!variants.some((variant) => variant.toLowerCase() === 'commission'));
  });

  test('never emits a bare Member State name', () => {
    assert.ok(!shortNameVariants('Spain v Commission').includes('Spain'));
  });

  test('skips a one-word variant that is a generic company-name opener', () => {
    // A document citing Digital Rights Ireland must not treat every later "Digital" as a
    // reference back to it.
    assert.ok(!shortNameVariants('Digital Rights Ireland and Seitlinger and Others').includes('Digital'));
  });

  test('strips corporate suffixes before shortening', () => {
    assert.ok(shortNameVariants('Google Spain SL v AEPD').includes('Google Spain'));
  });
});

describe('Layer 2 — ambiguity policy', () => {
  test('reports a short form matching two different authorities as ambiguous, with both candidates', () => {
    const citation = only(at([
      'Judgment of 17 September 2007, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:T:2007:287.',
      'Judgment of 10 September 2009, Akzo Nobel and Others v Commission, ECLI:EU:C:2009:536.',
      'Akzo Nobel, para. 58.',
    ], 2));
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.equal(citation.ecli, undefined, 'an ambiguous span must never carry one candidate\'s identifier');
    assert.equal(citation.celex, undefined);
    assert.deepEqual(citation.candidates?.map((candidate) => candidate.ecli).sort(), ['ECLI:EU:C:2009:536', 'ECLI:EU:T:2007:287']);
  });

  test('an explicitly declared short form overrides the ambiguity, because the drafter said which one', () => {
    const citation = only(at([
      'Judgment of 17 September 2007, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:T:2007:287.',
      'Judgment of 10 September 2009, Akzo Nobel and Others v Commission, ECLI:EU:C:2009:536 ("Akzo Nobel").',
      'Akzo Nobel, para. 58.',
    ], 2));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.resolutionMethod, 'explicit_alias');
    assert.equal(citation.ecli, 'ECLI:EU:C:2009:536');
  });

  test('the same authority cited twice is not ambiguous', () => {
    const citation = only(at([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512.',
      'Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 12.',
      'Akzo Nobel, para. 58.',
    ], 2));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.ecli, 'ECLI:EU:C:2010:512');
  });

  test('a later redefinition of a declared short form governs from that point on', () => {
    const [, beforeRedefinition, redefinition, afterRedefinition] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512 ("Leading Case").',
      'Leading Case, para. 40.',
      'ECLI:EU:C:2017:632 ("Leading Case").',
      'Leading Case, para. 41.',
    ]);
    assert.equal(only(beforeRedefinition).ecli, 'ECLI:EU:C:2010:512', 'the footnote before the redefinition keeps the original');
    assert.equal(only(redefinition).ecli, 'ECLI:EU:C:2017:632', 'the redefining footnote is not matched against the term it replaces');
    assert.equal(only(afterRedefinition).ecli, 'ECLI:EU:C:2017:632');
  });
});

describe('Layer 1 — the modern CJEU citation style', () => {
  // Since 2014 the Court and its Advocates General write the identifier bare and
  // parenthesised — "Judgment in Achmea (C-284/16, EU:C:2018:158, paragraph 35)" — rather
  // than with the `ECLI:` prefix. Requiring the prefix missed the ECLI in the dominant form
  // of modern EU legal writing. Found across 14 real Advocate General opinions.
  test('reads an ECLI written without its prefix, as the Court itself writes it', () => {
    const citation = only(detectCitations('Judgment in Achmea (C-284/16, EU:C:2018:158, paragraph 35).'));
    assert.equal(citation.ecli, 'ECLI:EU:C:2018:158', 'normalised to carry the prefix');
    assert.equal(citation.value, 'EU:C:2018:158', 'while the value keeps what the document wrote');
    assert.equal(citation.caseNumber, 'C-284/16');
    assert.equal(citation.celex, '62016CJ0284');
  });

  test('the prefixed spelling still reads as one citation, not two', () => {
    const citation = only(detectCitations('Case C-131/12, ECLI:EU:C:2014:317, para. 80.'));
    assert.equal(citation.ecli, 'ECLI:EU:C:2014:317');
  });

  test('a joined-cases group in that style is one authority, not one per case number', () => {
    // The consequence of missing the bare ECLI: with no identifier tying them together,
    // "(C-293/12 and C-594/12, EU:C:2014:238)" read as two separate authorities — one case
    // reported as two, and every short form referring to it ambiguous between a case and
    // its own sibling.
    const citation = only(detectCitations('Judgment in Digital Rights Ireland and Others (C‑293/12 and C‑594/12, EU:C:2014:238, paragraph 46).'));
    assert.equal(citation.caseNumber, 'C-293/12');
    assert.equal(citation.celex, '62012CJ0293');
    assert.deepEqual(citation.pinpoint, { paragraphs: [46] });
  });

  test('and an Ibid. after it resolves instead of asking which sibling was meant', () => {
    const citation = only(at([
      'Judgment in Digital Rights Ireland and Others (C‑293/12 and C‑594/12, EU:C:2014:238, paragraph 46).',
      'Ibid., paragraph 53.',
    ], 1));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.celex, '62012CJ0293');
    assert.deepEqual(citation.pinpoint, { paragraphs: [53] });
  });

  test('a cross-reference to the opinion\'s own points is not an authority', () => {
    // "Above, point 19." — the same family as "See paragraph 41 above", found four times in
    // one opinion. A position word can never begin a case name.
    for (const prose of ['Above, point 19.', 'Above, points 76 to 82 of this Opinion.', 'Below, paragraph 12.']) {
      assert.deepEqual(at(['Judgment in Achmea (C-284/16, EU:C:2018:158, paragraph 35).', prose], 1), [], prose);
    }
  });
});

describe('Layer 3 — back-references (Ibid., Id., supra note n)', () => {
  const LEAD = 'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.';

  test('reads Ibid. as the authority the preceding footnote established', () => {
    const citation = only(at([LEAD, 'Ibid., para. 44.'], 1));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.caseNumber, 'C-293/12');
    assert.equal(citation.celex, '62012CJ0293');
    assert.equal(citation.resolutionMethod, 'preceding_citation');
    assert.equal(citation.backReference?.footnote, 1);
  });

  test('is not a prompt: the resolution is stated, not put to the reviewer', () => {
    // The distinction this layer turns on. `Ibid.` naming the authority cited immediately
    // before it is what the word means, so confirming it would ask the reviewer to sign off
    // on what the document says outright — the reflex-prompt this tool refuses to become.
    const citation = only(at([LEAD, 'Ibid., para. 44.'], 1));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.candidates, undefined);
  });

  test('a bare Ibid. repeats the pinpoint as well as the authority', () => {
    assert.deepEqual(only(at([LEAD, 'Ibid.'], 1)).pinpoint, { paragraphs: [40] });
  });

  test('an Ibid. carrying its own pinpoint keeps the authority and states a new one', () => {
    assert.deepEqual(only(at([LEAD, 'Ibid., para. 44.'], 1)).pinpoint, { paragraphs: [44] });
  });

  test('inherits the locator and the pinpoint as a pair, never mixing a new one with a stale one', () => {
    // A new locator carrying the previous citation's paragraph list would report paragraphs
    // the footnote does not cite — a wrong pinpoint shown with full confidence.
    const citation = only(at([LEAD, 'Ibid., paras 51–53.'], 1));
    assert.deepEqual(citation.locator, { kind: 'point', start: 51, paragraph: undefined, end: 53 });
    assert.deepEqual(citation.pinpoint, { paragraphs: [51, 52, 53] });
  });

  test('carries an article locator across, for legislation as much as case law', () => {
    const footnotes = ['Regulation (EU) 2016/679, Article 6(1).', 'Ibid., Article 9(2).', 'Ibid.'];
    assert.deepEqual(only(at(footnotes, 1)).locator, { kind: 'article', start: 9, paragraph: 2, end: undefined });
    assert.deepEqual(only(at(footnotes, 2)).locator, { kind: 'article', start: 9, paragraph: 2, end: undefined },
      'the bare Ibid. repeats the article the one before it stated, not the one the act opened with');
  });

  test('chains: each Ibid. resolves against the one before it, pinpoint and all', () => {
    // The common shape in real drafting, and the reason resolution has to run in document
    // order — footnote 4 is three steps from the only footnote that names the case.
    const footnotes = [LEAD, 'Ibid., para. 44.', 'Ibid.', 'Id., para. 51.'];
    for (const index of [1, 2, 3]) {
      assert.equal(only(at(footnotes, index)).caseNumber, 'C-293/12', `footnote ${index + 1}`);
    }
    assert.deepEqual(only(at(footnotes, 2)).pinpoint, { paragraphs: [44] }, 'the bare Ibid. inherits from the Ibid. before it');
    assert.deepEqual(only(at(footnotes, 3)).pinpoint, { paragraphs: [51] });
  });

  test('accepts the spellings drafters actually use, including the French', () => {
    for (const form of ['Ibid., para. 44.', 'Ibidem, para. 44.', 'Id., para. 44.', 'Idem, para. 44.', 'See ibid., para. 44.', 'Cf. ibid., para. 44.']) {
      assert.equal(only(at([LEAD, form], 1)).caseNumber, 'C-293/12', form);
    }
  });

  test('resolves against the preceding citation in its own footnote before the preceding footnote', () => {
    const citations = at([LEAD, 'See Case C-131/12 Google Spain, para. 5; ibid., para. 9.'], 1);
    assert.equal(citations.length, 2);
    assert.equal(citations[1].caseNumber, 'C-131/12', 'the nearest citation is the one in the same footnote, not the one before it');
    assert.deepEqual(citations[1].pinpoint, { paragraphs: [9] });
  });

  test('reports an Ibid. after a multi-authority footnote as ambiguous, nearest candidate first', () => {
    // The one case the handoff flagged as genuinely undecidable. Convention reads Ibid. as
    // the last authority cited, and the ordering says so — but ordering is offered, never
    // applied, because a convention this tool decided to trust is still a guess.
    const citation = only(at(['Case C-293/12, para. 40; Case C-131/12, para. 20.', 'Ibid., para. 44.'], 1));
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.deepEqual(citation.candidates?.map((candidate) => candidate.caseNumber), ['C-131/12', 'C-293/12']);
    assert.equal(citation.celex, undefined, 'an unresolved back-reference carries no identifier to fetch on');
    assert.equal(citation.backReference?.footnote, 1, 'it still says where it looked');
  });

  test('never resolves against an authority the document itself never established', () => {
    // The preceding footnote holds a frequent-case suggestion, which is Ibid's own outside
    // knowledge rather than something the document said. An Ibid. inheriting it would
    // present that guess one step further from the doubt that produced it.
    const suggestion = only(at(['Van Gend en Loos, para. 12.'], 0));
    assert.equal(suggestion.status, 'unconfirmed_suggestion');

    const citation = only(at(['Van Gend en Loos, para. 12.', 'Ibid., para. 14.'], 1));
    assert.equal(citation.status, 'unresolved_not_found');
    assert.equal(citation.celex, undefined);
  });

  test('an Ibid. with nothing above it is reported, not silently dropped', () => {
    const citation = only(at(['Ibid., para. 12.'], 0));
    assert.equal(citation.status, 'unresolved_not_found');
    assert.ok(citation.backReference, 'still marked a back-reference, so a confirmation stays scoped to it');
    assert.equal(citation.backReference?.footnote, undefined, 'there is no footnote 0 for the reviewer to look at');
  });

  test('supra note n reads the footnote it names, across intervening footnotes', () => {
    const citation = only(at([LEAD, 'Commentary carrying no citation at all.', 'Supra note 1, para. 33.'], 2));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.caseNumber, 'C-293/12');
    assert.equal(citation.resolutionMethod, 'numbered_footnote');
    assert.equal(citation.backReference?.footnote, 1);
    assert.deepEqual(citation.pinpoint, { paragraphs: [33] });
  });

  test('accepts the abbreviated note forms', () => {
    for (const form of ['Supra note 1, para. 33.', 'Supra n. 1, para. 33.', 'Supra n 1, para. 33.', 'Above n 1, para. 33.']) {
      assert.equal(only(at([LEAD, form], 1)).caseNumber, 'C-293/12', form);
    }
  });

  test('refuses a forward or self reference, because supra means above', () => {
    const [, forward, self] = detectCitationsAcrossFootnotes([LEAD, 'Supra note 3, para. 5.', 'Supra note 3, para. 5.']);
    assert.equal(only(forward).status, 'unresolved_not_found', 'footnote 2 cannot cite footnote 3');
    assert.equal(only(self).status, 'unresolved_not_found', 'footnote 3 cannot cite itself');
  });

  test('a supra note trailing the name it repeats is one citation, not two', () => {
    const citations = at([LEAD, 'Digital Rights Ireland, supra note 1, para. 44.'], 1);
    assert.equal(citations.length, 1, `expected one citation, got ${citations.map((match) => match.value).join(' | ')}`);
    assert.equal(citations[0].caseNumber, 'C-293/12');
  });

  test('the name in front of a supra note is not separately reported as an unresolved gap', () => {
    // The reference did resolve — just not by the name — so reporting the name as a gap
    // would send the reviewer to check something that is already settled.
    const citations = at([LEAD, 'Some Unregistered Name, supra note 1, para. 44.'], 1);
    assert.equal(citations.length, 1, `expected one citation, got ${citations.map((match) => match.value).join(' | ')}`);
    assert.equal(citations[0].status, 'resolved');
  });

  test('a supra note pointing at a multi-authority footnote is ambiguous too', () => {
    const citation = only(at(['Case C-293/12, para. 40; Case C-131/12, para. 20.', 'Supra note 1, para. 5.'], 1));
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.equal(citation.candidates?.length, 2);
  });

  test('every back-reference is marked as one, whatever came of it', () => {
    // What confirmation scope keys on: `Ibid.` means something different at every
    // occurrence, so a reviewer settling one must not settle the rest. An unresolved
    // back-reference has no resolution method to infer that from, hence the marker.
    const footnotes = [LEAD, 'Ibid.', 'Supra note 9, para. 3.', 'Case C-293/12, para. 1; Case C-131/12, para. 2.', 'Ibid.'];
    const statuses = [1, 2, 4].map((index) => only(at(footnotes, index)));
    assert.deepEqual(statuses.map((citation) => citation.status), ['resolved', 'unresolved_not_found', 'unresolved_ambiguous']);
    for (const citation of statuses) assert.ok(citation.backReference, citation.value);
  });

  test('does not read the words out of ordinary prose', () => {
    // The tokens are short and common; only their position makes them citations. A footnote
    // that merely contains them is narrating, and putting a source panel behind that would
    // be the confidently-wrong reference this tool exists to prevent.
    for (const prose of [
      'The applicant did not identify the id. of the record, nor was ibid relevant.',
      'The Commission considered this identical to the earlier finding.',
      'That reasoning applies a fortiori to the present case, see above.',
    ]) {
      assert.deepEqual(at([LEAD, prose], 1), [], prose);
    }
  });

  test('a confirmation settles the back-references that depend on it', () => {
    // The reviewer confirms the ambiguous short form in footnote 3. Footnote 4's `Ibid.`
    // resolved against detection, where footnote 3 established nothing — so without this
    // pass the pane shows footnote 3 resolved and footnote 4 still saying footnote 3 has
    // nothing to point at, two statements contradicting each other on screen.
    const detected = detectCitationsAcrossFootnotes([
      'Judgment of 6 October 2015, Schrems, Case C-362/14, ECLI:EU:C:2015:650, para. 94.',
      'Judgment of 16 July 2020, Schrems, Case C-311/18, ECLI:EU:C:2020:559, para. 168.',
      'Schrems, para. 94.',
      'Ibid., para. 95.',
    ]);
    assert.equal(only(detected[2]).status, 'unresolved_ambiguous');
    assert.equal(only(detected[3]).status, 'unresolved_not_found', 'nothing to point at, before the confirmation');

    const confirmed = detected.map((citations, index) => (index === 2
      ? citations.map((citation) => ({ ...citation, caseNumber: 'C-362/14', celex: '62014CJ0362', status: 'resolved' as const, resolutionMethod: 'user_confirmed' as const, candidates: undefined }))
      : citations));

    const settled = reresolveBackReferences(confirmed);
    assert.equal(only(settled[3]).status, 'resolved');
    assert.equal(only(settled[3]).caseNumber, 'C-362/14');
    assert.equal(only(settled[3]).resolutionMethod, 'confirmed_back_reference');
    assert.deepEqual(only(settled[3]).pinpoint, { paragraphs: [95] }, 'its own pinpoint is kept');
  });

  test('one confirmation carries down a whole chain', () => {
    const detected = detectCitationsAcrossFootnotes([
      'Judgment of 6 October 2015, Schrems, Case C-362/14, ECLI:EU:C:2015:650, para. 94.',
      'Judgment of 16 July 2020, Schrems, Case C-311/18, ECLI:EU:C:2020:559, para. 168.',
      'Schrems, para. 94.',
      'Ibid.',
      'Ibid., para. 96.',
    ]);
    const confirmed = detected.map((citations, index) => (index === 2
      ? citations.map((citation) => ({ ...citation, caseNumber: 'C-362/14', celex: '62014CJ0362', status: 'resolved' as const, resolutionMethod: 'user_confirmed' as const, candidates: undefined, locator: { kind: 'point' as const, start: 94 }, pinpoint: { paragraphs: [94] } }))
      : citations));

    const settled = reresolveBackReferences(confirmed);
    assert.equal(only(settled[3]).caseNumber, 'C-362/14', 'footnote 4 follows the confirmation');
    assert.deepEqual(only(settled[3]).pinpoint, { paragraphs: [94] }, 'a bare Ibid. still inherits the pinpoint');
    assert.equal(only(settled[4]).caseNumber, 'C-362/14', 'footnote 5 follows footnote 4');
    assert.deepEqual(only(settled[4]).pinpoint, { paragraphs: [96] });
  });

  test('a confirmation elsewhere never licenses reading forwards', () => {
    // `supra note 3` in footnote 2 is a drafting error whichever way the document is read,
    // and a confirmation in footnote 3 must not turn it into a resolvable reference.
    const detected = detectCitationsAcrossFootnotes([
      'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.',
      'Supra note 3, para. 5.',
      'Schrems, para. 94.',
    ]);
    const confirmed = detected.map((citations, index) => (index === 2
      ? citations.map((citation) => ({ ...citation, caseNumber: 'C-362/14', status: 'resolved' as const, candidates: undefined }))
      : citations));
    assert.equal(only(reresolveBackReferences(confirmed)[1]).status, 'unresolved_not_found');
  });

  test('leaves a back-reference alone while its target is still ambiguous', () => {
    const detected = detectCitationsAcrossFootnotes(['Case C-293/12, para. 40; Case C-131/12, para. 20.', 'Ibid., para. 44.']);
    const settled = reresolveBackReferences(detected);
    assert.equal(only(settled[1]).status, 'unresolved_ambiguous');
    assert.equal(only(settled[1]).celex, undefined);
  });

  test('changes nothing when the reviewer has confirmed nothing', () => {
    const detected = detectCitationsAcrossFootnotes([
      'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.',
      'Ibid., para. 44.',
      'Van Gend en Loos, para. 12.',
      'Ibid., para. 14.',
    ]);
    assert.deepEqual(reresolveBackReferences(detected), detected);
  });

  test('a cross-reference to the document\'s own text is not an authority', () => {
    // From AG Jääskinen's opinion in Google Spain, which says this three times. "See" is
    // capitalised and carries what looks like a pinpoint, so the short-form scan reported
    // it as an unidentified authority and sent the reviewer off to resolve a phantom.
    assert.deepEqual(at(['Case C-131/12 Google Spain, ECLI:EU:C:2014:317, para. 20.', 'See paragraph 41 above.'], 1), []);
    for (const lead of ['Cf. paragraph 41 above.', 'Voir point 41 ci-dessus.', 'Compare paragraph 41 above.']) {
      assert.deepEqual(at(['Case C-131/12 Google Spain, ECLI:EU:C:2014:317, para. 20.', lead], 1), [], lead);
    }
  });

  test('the real document is unaffected: it makes no back-reference', () => {
    // REAL_DOCUMENT is transcribed verbatim from the sample docx and contains none of these
    // forms, so this layer must add nothing to it.
    for (const citations of detectCitationsAcrossFootnotes(REAL_DOCUMENT)) {
      for (const citation of citations) assert.equal(citation.backReference, undefined, citation.value);
    }
  });
});

describe('Layer 5 — frequent-case fallback table', () => {
  test('offers a landmark case as a suggestion to confirm, never as an established citation', () => {
    // Everything else Ibid reports is the reviewer's own document read back to them.
    // This is Ibid volunteering something the document never said, from a hand-kept
    // list, so it is deliberately not presented the same way.
    const citation = only(at(['Van Gend en Loos, para. 12.'], 0));
    assert.equal(citation.status, 'unconfirmed_suggestion');
    assert.equal(citation.resolutionMethod, 'fallback_table');
    assert.equal(citation.celex, undefined, 'a suggestion must not carry an identifier that could be fetched');
    assert.equal(citation.caseNumber, undefined);
    assert.deepEqual(citation.candidates?.map((candidate) => candidate.caseNumber), ['C-26/62']);
    assert.equal(citation.candidates?.[0].celex, '61962CJ0026');
  });

  test('the suggestion carries no ECLI, because the table deliberately stores none', () => {
    // An ECLI cannot be derived from anything else, so a hand-entered one would be
    // unchecked data presented as fact. The case number is enough — the CELEX derives
    // from it and the source lookup confirms the document.
    assert.equal(only(at(['Van Gend en Loos, para. 12.'], 0)).candidates?.[0].ecli, undefined);
  });

  test('applies the ambiguity policy to the table too, rather than picking the more famous case', () => {
    const citation = only(at(['Schrems, para. 94.'], 0));
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.deepEqual(citation.candidates?.map((candidate) => candidate.caseNumber).sort(), ['C-311/18', 'C-362/14']);
  });

  test('an in-document citation always beats the table', () => {
    const citation = only(at([
      'Judgment of 6 October 2015, Schrems v Data Protection Commissioner, ECLI:EU:C:2015:650.',
      'Schrems, para. 94.',
    ], 1));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.resolutionMethod, 'generated_variant');
    assert.equal(citation.ecli, 'ECLI:EU:C:2015:650');
  });

  test('every table entry has a derivable CELEX', () => {
    // Guards against a typo in a hand-maintained case number going unnoticed: a case
    // number the derivation rejects would silently resolve to a citation with no source.
    for (const entry of FREQUENT_CASES) {
      assert.ok(normaliseCaseNumber(entry.caseNumber) === entry.caseNumber, `${entry.caseNumber} is not in canonical form`);
      assert.ok(only(detectCitations(`Case ${entry.caseNumber}.`)).celex, `${entry.caseNumber} yields no CELEX`);
    }
  });
});

/**
 * The acceptance set: the citation patterns collected from real drafting, run end to end
 * through document-level resolution. Each is written the way a lawyer actually writes it.
 */
describe('acceptance — the collected citation patterns', () => {
  test('1. plain judgment cite', () => {
    const citation = only(detectCitations('Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, C-550/07 P, ECLI:EU:C:2010:512.'));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.caseNumber, 'C-550/07 P');
    assert.equal(citation.documentType, 'judgment');
    assert.equal(citation.documentTypeStated, true);
  });

  test('2. ECLI only', () => {
    const citation = only(detectCitations('ECLI:EU:C:2010:512.'));
    assert.equal(citation.ecli, 'ECLI:EU:C:2010:512');
    assert.equal(citation.celex, undefined, 'no case number stated, so no CELEX is invented');
  });

  test('3. ECLI with a pinpoint and nothing else', () => {
    const citation = only(detectCitations('ECLI:EU:C:2010:512, para. 40.'));
    assert.deepEqual(citation.pinpoint, { paragraphs: [40] });
  });

  test('4. case-number form', () => {
    assert.equal(only(detectCitations('Case C-550/07 P, para. 40.')).celex, '62007CJ0550');
  });

  test('5. case-name only, resolved from the document', () => {
    const citation = only(at([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, C-550/07 P, ECLI:EU:C:2010:512.',
      'Akzo Nobel Chemicals and Akcros Chemicals v Commission, para. 40.',
    ], 1));
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.ecli, 'ECLI:EU:C:2010:512');
  });

  test('6. shortened drafting', () => {
    const citation = only(at([
      'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, C-550/07 P, ECLI:EU:C:2010:512.',
      'Akzo Nobel, para. 40.',
    ], 1));
    assert.equal(citation.resolutionMethod, 'generated_variant');
    assert.equal(citation.caseNumber, 'C-550/07 P');
  });

  test('7. consecutive paragraph range', () => {
    assert.deepEqual(only(detectCitations('ECLI:EU:C:2010:512, paras 40–44.')).pinpoint, { paragraphs: [40, 41, 42, 43, 44] });
  });

  test('8. mixed paragraph range', () => {
    assert.deepEqual(only(detectCitations('ECLI:EU:C:2010:512, paras 40–44, 46 and 48.')).pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46, 48] });
  });

  test('9. alternative punctuation', () => {
    assert.deepEqual(only(detectCitations('ECLI:EU:C:2010:512, §§ 40-44, 46.')).pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46] });
  });

  test('10. defined reference, first mention', () => {
    const first = only(at(['Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512 ("Akzo Nobel").', 'Akzo Nobel, para. 40.'], 0));
    assert.equal(first.ecli, 'ECLI:EU:C:2010:512');
    assert.equal(first.status, 'resolved');
  });

  test('11. defined reference, later mention', () => {
    const later = only(at(['Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512 ("Akzo Nobel").', 'Akzo Nobel, para. 40.'], 1));
    assert.equal(later.resolutionMethod, 'explicit_alias');
    assert.deepEqual(later.pinpoint, { paragraphs: [40] });
  });

  test('12. defined reference carrying a pinpoint in the first mention', () => {
    const [first, later] = detectCitationsAcrossFootnotes([
      'ECLI:EU:C:2010:512, para. 40 ("Akzo Nobel").',
      'Akzo Nobel, para. 45.',
    ]);
    assert.deepEqual(only(first).pinpoint, { paragraphs: [40] }, 'the definition itself keeps its own pinpoint');
    assert.deepEqual(only(later).pinpoint, { paragraphs: [45] });
  });

  test('13. Advocate General opinion in the same case', () => {
    const citation = only(detectCitations('Opinion of Advocate General Kokott of 29 April 2010 in Case C-550/07 P, ECLI:EU:C:2010:229, point 45.'));
    assert.equal(citation.documentType, 'opinion');
    assert.equal(citation.documentTypeStated, true);
  });

  test('14. an opinion the text never labels as one is reported as an assumption, not a fact', () => {
    // The ECLI's ordinal segment is a per-court sequential counter — it encodes nothing
    // about document type, so nothing here can tell that this is an opinion. The type
    // defaults to 'judgment' because that is what retrieval needs, but `documentTypeStated`
    // says the text never confirmed it, which is what the source lookup is for.
    const citation = only(detectCitations('AG Kokott, ECLI:EU:C:2010:229, point 45.'));
    assert.equal(citation.documentType, 'judgment');
    assert.notEqual(citation.documentTypeStated, true);
  });

  test('15. order in the same case', () => {
    const citation = only(detectCitations('Order of 17 November 2009, Akzo Nobel v Commission, ECLI:EU:C:2009:712, para. 15.'));
    assert.equal(citation.documentType, 'order');
    assert.equal(citation.documentTypeStated, true);
  });

  test('16. legislation cited in full', () => {
    assert.equal(only(detectCitations('Regulation (EU) 2022/1925 of the European Parliament and of the Council.')).celex, '32022R1925');
  });

  test('17. legislation shorthand', () => {
    const citation = only(at(['Regulation (EU) 2022/1925 (the "DMA").', 'DMA, Article 6(5).'], 1));
    assert.equal(citation.celex, '32022R1925');
    assert.deepEqual(citation.locator, { kind: 'article', start: 6, paragraph: 5, end: undefined });
  });

  test('18. legislation recital', () => {
    const citation = only(at(['Regulation (EU) 2022/1925 (the "DMA").', 'DMA, recital 65.'], 1));
    assert.equal(citation.celex, '32022R1925');
    assert.deepEqual(citation.locator, { kind: 'point', start: 65, paragraph: undefined, end: undefined });
  });

  test('19. citation embedded in substantive text', () => {
    const citation = only(detectCitations('The Court has consistently held that legal professional privilege does not extend to in-house counsel (see Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 44), which is decisive here.'));
    assert.equal(citation.caseName, 'Akzo Nobel Chemicals and Akcros Chemicals v Commission');
    assert.deepEqual(citation.pinpoint, { paragraphs: [44] });
  });

  test('20. two authorities in one footnote', () => {
    const citations = detectCitations('See Akzo Nobel, ECLI:EU:C:2010:512, para. 40; and Case C-1/10, Second Authority, paras 25–27.');
    assert.equal(citations.length, 2);
    assert.deepEqual(citations[0].pinpoint, { paragraphs: [40] });
    assert.deepEqual(citations[1].pinpoint, { paragraphs: [25, 26, 27] });
  });

  test('21. the deliberately insufficient citation stays unresolved', () => {
    // The pass condition for this one is that it is *not* resolved. "Intel" names more
    // than one EU competition case and this document says nothing that picks between
    // them, so it is surfaced for the lawyer with both candidates.
    const citation = only(at(['Intel, para. 132.'], 0));
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.equal(citation.celex, undefined);
    assert.equal(citation.caseNumber, undefined);
    assert.deepEqual(citation.candidates?.map((candidate) => candidate.caseNumber).sort(), ['C-413/14 P', 'T-286/09']);
  });

  test('a name that matches nothing at all is reported as a gap, not dropped', () => {
    const citation = only(at(['Some Unknown Authority, para. 4.'], 0));
    assert.equal(citation.status, 'unresolved_not_found');
    assert.equal(citation.value, 'Some Unknown Authority');
  });
});

/**
 * The footnotes of `samples/ibid-demo-docx/eu-case-law-citation-test.docx`, in document
 * order, transcribed verbatim (curly quotes and all). Running the real document surfaced
 * four defects the hand-written cases above all missed, which is why it is pinned here
 * rather than left as a manual check:
 *
 *  1. The same case stated by ECLI in one footnote and by case number in another read as
 *     two different authorities, so footnotes 5–7 — the plain "shortened drafting" case
 *     this work exists for — were all reported ambiguous between a case and itself.
 *  2. "Akzo Nobel v Commission" resolved to nothing: shortened-applicant-with-defendant
 *     was not a generated variant, and the span scan started at the defendant.
 *  3. That left "Commission" reported as an unidentified authority needing review.
 *  4. An ECLI stated as an AG opinion in one footnote reverted to 'judgment' when cited
 *     bare in the next.
 */
const REAL_DOCUMENT = [
  'Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40.',
  'ECLI:EU:C:2010:512, para. 40.',
  'Case C-550/07 P, Akzo Nobel Chemicals and Akcros Chemicals v Commission, para. 40.',
  'Akzo Nobel v Commission, para. 40.',
  'Akzo Nobel, para. 40.',
  'Akzo Nobel, paras 40–44.',
  'Akzo Nobel, paras 40–44, 46 and 48.',
  'Akzo Nobel (C-550/07 P), §§ 40-44, 46.',
  'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512 (“Akzo Nobel”).',
  'Akzo Nobel, paras 40–44.',
  'Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, para. 40 (“Akzo Nobel”).',
  'Akzo Nobel, para. 45.',
  'Opinion of Advocate General Kokott of 29 April 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:229, paras 60–63.',
  'Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:229, para. 60.',
  'Order of 17 November 2009, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2009:712, para. 15.',
  'Regulation (EU) 2022/1925 (Digital Markets Act), Article 6(5).',
  'Regulation (EU) 2022/1925 (the “DMA”).',
  'DMA, Article 6(5).',
  'Regulation (EU) 2022/1925, recital 65.',
  'See, in that regard, Judgment of 14 September 2010, Akzo Nobel Chemicals and Akcros Chemicals v Commission, ECLI:EU:C:2010:512, paras 40–44, in particular para. 41.',
  'See Akzo Nobel, ECLI:EU:C:2010:512, para. 40; and [second authority], paras 25–27.',
  'Intel, para. 132.',
];

describe('regression — samples/ibid-demo-docx/eu-case-law-citation-test.docx', () => {
  const resolved = detectCitationsAcrossFootnotes(REAL_DOCUMENT);
  const footnote = (number: number) => resolved[number - 1];

  test('every footnote yields exactly one citation', () => {
    // Not a formality: footnote 3 used to yield two (the case number, plus a short form
    // resolving to the same case by a different identifier) and footnote 4 used to yield
    // a citation of "Commission".
    for (const [index, citations] of resolved.entries()) {
      assert.equal(citations.length, 1, `footnote ${index + 1}: ${citations.map((c) => `"${c.value}"`).join(', ') || 'nothing detected'}`);
    }
  });

  test('every footnote resolves except the deliberately ambiguous last one', () => {
    for (const [index, citations] of resolved.entries()) {
      const expected = index === REAL_DOCUMENT.length - 1 ? 'unresolved_ambiguous' : 'resolved';
      assert.equal(citations[0].status, expected, `footnote ${index + 1} "${citations[0].value}"`);
    }
  });

  test('the same case stated two ways is one authority, not an ambiguity', () => {
    // Footnote 1 gives only the ECLI, footnote 3 only the case number. Every later short
    // form must resolve to the single case both describe.
    for (const number of [4, 5, 6, 7]) {
      const [citation] = footnote(number);
      assert.equal(citation.status, 'resolved', `footnote ${number}`);
      assert.equal(citation.ecli, 'ECLI:EU:C:2010:512', `footnote ${number}`);
      assert.equal(citation.caseNumber, 'C-550/07 P', `footnote ${number}`);
    }
  });

  test('a footnote citing only an ECLI still gains the CELEX another footnote supplied', () => {
    // An ECLI derives to no CELEX on its own, so without this these footnotes could only
    // ever offer a search link instead of the judgment text.
    assert.equal(footnote(2)[0].celex, undefined, 'reading order is respected: the case number has not been stated yet');
    assert.equal(footnote(20)[0].celex, '62007CJ0550');
    assert.equal(footnote(21)[0].celex, '62007CJ0550');
  });

  test('an ECLI stated once as an AG opinion stays an opinion when cited bare later', () => {
    assert.equal(footnote(13)[0].documentType, 'opinion');
    assert.equal(footnote(14)[0].documentType, 'opinion');
    assert.equal(footnote(14)[0].documentTypeStated, true);
    // The opinion's own CELEX, borrowed from the case number the judgment footnotes state:
    // `CC` for an Advocate General opinion, never the judgment's `CJ`.
    assert.equal(footnote(14)[0].celex, '62007CC0550');
    assert.notEqual(footnote(14)[0].celex, footnote(20)[0].celex, 'the opinion is not the judgment');
  });

  test('the opinion and the order are not merged into the judgment', () => {
    assert.equal(footnote(15)[0].documentType, 'order');
    assert.equal(footnote(15)[0].ecli, 'ECLI:EU:C:2009:712');
    assert.notEqual(footnote(13)[0].ecli, footnote(20)[0].ecli);
  });

  test('the pinpoint patterns all parse', () => {
    assert.deepEqual(footnote(6)[0].pinpoint, { paragraphs: [40, 41, 42, 43, 44] });
    assert.deepEqual(footnote(7)[0].pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46, 48] });
    assert.deepEqual(footnote(8)[0].pinpoint, { paragraphs: [40, 41, 42, 43, 44, 46] });
    assert.deepEqual(footnote(19)[0].locator, { kind: 'point', start: 65, paragraph: undefined, end: undefined });
  });

  test('the final footnote is ambiguous and carries no identifier of its own', () => {
    const [citation] = footnote(22);
    assert.equal(citation.status, 'unresolved_ambiguous');
    assert.equal(citation.celex, undefined);
    assert.equal(citation.ecli, undefined);
    assert.equal(citation.caseNumber, undefined);
  });
});

describe('citedAuthorities — what a reviewer can pick from', () => {
  test('lists each authority once, however many footnotes cite it', () => {
    const authorities = citedAuthorities(detectCitationsAcrossFootnotes(REAL_DOCUMENT));
    // The judgment, the AG opinion, the order, and the DMA — four distinct authorities
    // across twenty-two footnotes.
    assert.equal(authorities.length, 4);
    assert.deepEqual(authorities.map((authority) => authority.ecli ?? authority.celex), [
      'ECLI:EU:C:2010:512', 'ECLI:EU:C:2010:229', 'ECLI:EU:C:2009:712', '32022R1925',
    ]);
  });

  test('a case stated by ECLI in one footnote and by case number in another appears once, holding both', () => {
    const [judgment] = citedAuthorities(detectCitationsAcrossFootnotes(REAL_DOCUMENT));
    assert.equal(judgment.ecli, 'ECLI:EU:C:2010:512');
    assert.equal(judgment.caseNumber, 'C-550/07 P');
    assert.equal(judgment.celex, '62007CJ0550');
  });

  test('never offers an unconfirmed citation as something to pick', () => {
    // The pick-list exists to resolve uncertainty, so it must not be built out of it.
    const authorities = citedAuthorities(detectCitationsAcrossFootnotes(['Intel, para. 132.', 'Van Gend en Loos, para. 12.']));
    assert.deepEqual(authorities, []);
  });
});

describe('acceptance — trailing cases', () => {
  test('a name that matches nothing at all is still reported as a gap', () => {
    const citation = only(at(['Some Unknown Authority, para. 4.'], 0));
    assert.equal(citation.status, 'unresolved_not_found');
    assert.equal(citation.value, 'Some Unknown Authority');
  });
});

/**
 * The footnotes of `samples/ibid-demo-docx/back-reference-test.docx`, in document order.
 * That document is the manual Word check for back-references; pinning its footnotes here
 * is what stops the two drifting apart, the same arrangement as REAL_DOCUMENT above.
 *
 * Generated by `samples/ibid-demo-docx/build-back-reference-test.py` — change that and this
 * together, and keep the expected-results table in that folder's README.md in step.
 */
const BACK_REFERENCE_DOCUMENT = [
  "Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 (the “GDPR”), Article 17.",
  "GDPR, Article 17(1).",
  "Judgment of 13 May 2014, Google Spain SL and Google Inc. v AEPD and Costeja González, Case C-131/12, ECLI:EU:C:2014:317, paras 80–82.",
  "Ibid., para. 97.",
  "Ibid.",
  "Id., para. 99.",
  "Judgment of 8 April 2014, Digital Rights Ireland and Seitlinger and Others, Joined Cases C-293/12 and C-594/12, ECLI:EU:C:2014:238, paras 57–65.",
  "Supra note 3, para. 80.",
  "",
  "Supra note 7, paras 62 and 65.",
  "Ibid.",
  "Judgment of 6 October 2015, Schrems v Data Protection Commissioner, Case C-362/14, ECLI:EU:C:2015:650, para. 94; and Judgment of 16 July 2020, Data Protection Commissioner v Facebook Ireland and Schrems, Case C-311/18, ECLI:EU:C:2020:559, para. 168.",
  "Ibid., para. 94.",
  "CJUE, 21 décembre 2016, Tele2 Sverige AB et Watson e.a., affaires jointes C-203/15 et C-698/15, ECLI:EU:C:2016:970, point 112.",
  "Ibidem, point 119.",
  "See paragraph 12 above.",
  "Judgment of 6 September 2017, Intel Corp. v Commission, Case C-413/14 P, ECLI:EU:C:2017:632, paras 138–139.",
  "Opinion of Advocate General Wahl of 20 October 2016 in Intel, ECLI:EU:C:2016:788, §§ 73-75.",
  "Ibid., point 74.",
  "Supra note 25, para. 5.",
  "Post Danmark, para. 44.",
  "Ibid., para. 45.",
];

describe('regression — samples/ibid-demo-docx/back-reference-test.docx', () => {
  const resolved = detectCitationsAcrossFootnotes(BACK_REFERENCE_DOCUMENT);
  const footnote = (number: number) => resolved[number - 1];
  const single = (number: number) => {
    const citations = footnote(number);
    assert.equal(citations.length, 1, `footnote ${number}: expected one citation, got ${citations.map((c) => c.value).join(' | ') || 'none'}`);
    return citations[0];
  };

  test('the chain resolves three deep, inheriting the pinpoint where none is stated', () => {
    assert.equal(single(4).celex, '62012CJ0131');
    assert.deepEqual(single(4).pinpoint, { paragraphs: [97] });
    assert.deepEqual(single(5).pinpoint, { paragraphs: [97] }, 'the bare Ibid. inherits');
    assert.deepEqual(single(6).pinpoint, { paragraphs: [99] }, 'and a stated pinpoint wins');
    assert.equal(single(6).celex, '62012CJ0131');
  });

  test('numbering survives the empty footnote at 9', () => {
    // The whole reason the document has an empty footnote. If empties were dropped before
    // resolution, footnote 10 would count to the seventh *non-empty* footnote and resolve
    // to Google Spain instead — a different case, reported with full confidence.
    assert.deepEqual(footnote(9), [], 'footnote 9 establishes nothing');
    assert.equal(single(10).celex, '62012CJ0293', 'Digital Rights Ireland, not Google Spain');
    assert.equal(single(10).backReference?.footnote, 7);
    assert.equal(single(8).celex, '62012CJ0131', 'and the supra before the gap is unaffected');
  });

  test('a back-reference to an opinion stays with the opinion', () => {
    assert.equal(single(18).celex, '62014CC0413');
    assert.equal(single(19).celex, '62014CC0413', 'not the judgment CELEX, 62014CJ0413');
    assert.deepEqual(single(19).pinpoint, { paragraphs: [74] });
  });

  test('the refusals are refusals', () => {
    assert.equal(single(13).status, 'unresolved_ambiguous');
    assert.deepEqual(single(13).candidates?.map((c) => c.caseNumber), ['C-311/18', 'C-362/14']);
    assert.equal(single(20).status, 'unresolved_not_found', 'there is no footnote 25');
    assert.equal(single(22).status, 'unresolved_not_found', 'and no guess is inherited from 21');
    for (const number of [13, 20, 21, 22]) assert.equal(single(number).celex, undefined, `footnote ${number}`);
  });

  test('a cross-reference to the document\'s own text yields nothing', () => {
    assert.deepEqual(footnote(16), []);
  });

  test('every other footnote resolves', () => {
    const undecided = resolved.flat().filter((citation) => citation.status !== 'resolved');
    assert.deepEqual(undecided.map((citation) => citation.value), ['Ibid.', 'Supra note 25', 'Post Danmark', 'Ibid.']);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCitationsAcrossFootnotes, getCitationContextsForFootnotes, type CitationContext } from '../../shared/src/index.ts';
import { autoSelectable, bodyProseLines, candidateKey, candidateLabel, confirmationKey, documentTypeNote, excerptPassages, followingNote, inlineFootnotesInBody, needsReview, numberMismatchNote, officialSourceUrl, parentheticalsInBody, resolutionNote, sourceChanged, toReviewFootnotes, unlocatedNote, unresolvedMessage, verificationNote } from '../src/ui/citation-view.ts';

const context = (footnotes: string[], index: number): CitationContext[] => getCitationContextsForFootnotes(footnotes)[index];
const one = (footnotes: string[], index: number): CitationContext => {
  const citations = context(footnotes, index);
  assert.equal(citations.length, 1, `expected one citation, got ${citations.map((c) => c.value).join(' | ') || 'none'}`);
  return citations[0];
};

const LEAD = 'Case C-293/12 Digital Rights Ireland, ECLI:EU:C:2014:238, para. 40.';

describe('footnote numbering, which back-references count on', () => {
  test('an empty footnote keeps its slot, so the ones after it keep their numbers', () => {
    // The pane used to drop empty footnotes before handing them to resolution. Numbering is
    // positional, so every later footnote shifted up — while the pane went on displaying
    // true numbers beside them. Only reachable from Word: the preview memo has no empties.
    const numbered = toReviewFootnotes(['first', '   ', 'third']);
    assert.deepEqual(numbered.map((footnote) => footnote.number), [1, 2, 3]);
    assert.deepEqual(numbered.map((footnote) => footnote.text), ['first', '', 'third']);
  });

  test('supra note n still names the right footnote across an empty one', () => {
    const texts = [LEAD, '', '', 'Supra note 1, para. 33.'];
    const footnotes = toReviewFootnotes(texts);
    const citation = one(footnotes.map((footnote) => footnote.text), 3);
    assert.equal(citation.status, 'resolved');
    assert.equal(citation.caseNumber, 'C-293/12');
    assert.equal(citation.backReference?.footnote, 1);
    // And the number the reviewer is pointed at is the number shown beside footnote 1.
    assert.equal(footnotes[0].number, citation.backReference?.footnote);
  });

  test('an Ibid. after an empty footnote is flagged, not quietly read past it', () => {
    // Keeping the empty footnote is what makes numbering honest, and it has a consequence
    // worth being deliberate about: the `Ibid.` in footnote 3 now points at footnote 2,
    // which establishes nothing, so it is reported rather than resolved. That is the same
    // rule as everywhere else — never skip back past a footnote with no authority in it —
    // and here it is doing real work, because an empty footnote is usually a citation
    // someone deleted, which is exactly when an `Ibid.` after it has gone stale.
    const footnotes = toReviewFootnotes([LEAD, '', 'Ibid., para. 44.']);
    const citations = getCitationContextsForFootnotes(footnotes.map((footnote) => footnote.text));
    assert.equal(footnotes[2].number, 3, 'the citation sits at the position of footnote 3');
    assert.equal(citations[2][0].status, 'unresolved_not_found');
    assert.equal(citations[2][0].backReference?.footnote, 2, 'and says which footnote it looked at');
    assert.equal(citations[2][0].celex, undefined);
  });
});

describe('confirmation scope', () => {
  test('a short form is settled once for the whole document', () => {
    // Two footnotes, same name, same key: confirming either answers both, which is the
    // point — a name means one thing throughout a document.
    const footnotes = ['Case C-362/14 Schrems, para. 94.', 'Case C-311/18 Schrems, para. 168.', 'Schrems, para. 94.', 'Schrems, para. 95.'];
    const third = one(footnotes, 2);
    const fourth = one(footnotes, 3);
    assert.equal(confirmationKey(third, 'footnote-3'), confirmationKey(fourth, 'footnote-4'));
  });

  test('a back-reference is settled only where it stands', () => {
    // The bug this exists to prevent: two `Ibid.` spelled identically, meaning different
    // authorities. Sharing a key would apply one reviewer's decision to both.
    const footnotes = [LEAD, 'Ibid., para. 44.', 'Case C-131/12 Google Spain, para. 20.', 'Ibid., para. 21.'];
    const second = one(footnotes, 1);
    const fourth = one(footnotes, 3);
    assert.equal(second.value.toLowerCase(), fourth.value.toLowerCase(), 'identical text');
    assert.notEqual(confirmationKey(second, 'footnote-2'), confirmationKey(fourth, 'footnote-4'));
  });

  test('the same back-reference keeps one key across re-reads', () => {
    const citation = one([LEAD, 'Ibid., para. 44.'], 1);
    assert.equal(confirmationKey(citation, 'footnote-2'), confirmationKey({ ...citation }, 'footnote-2'));
  });
});

describe('what the reviewer is told about a resolution', () => {
  test('names the footnote an Ibid. was read from', () => {
    assert.equal(resolutionNote(one([LEAD, 'Ibid., para. 44.'], 1)),
      'Read as the authority cited immediately before it, in footnote 1.');
  });

  test('names the footnote a supra note points at', () => {
    assert.equal(resolutionNote(one([LEAD, 'Filler.', 'Supra note 1, para. 33.'], 2)),
      'Read from footnote 1, which this reference names.');
  });

  test('says plainly when a resolution rests on the reviewer\'s own confirmation', () => {
    // Not folded in with the other two: this one is not something the document states, and
    // the reviewer needs to see how far their own decision has carried.
    const citation = one([LEAD, 'Ibid.'], 1);
    assert.equal(resolutionNote({ ...citation, resolutionMethod: 'confirmed_back_reference' }),
      'Read from footnote 1, which you confirmed.');
  });

  test('distinguishes confirming a reference from confirming a name', () => {
    const backReference = one([LEAD, 'Ibid.'], 1);
    assert.equal(resolutionNote({ ...backReference, resolutionMethod: 'user_confirmed' }), 'Confirmed by you for this reference.');
    const name = one(['Case C-362/14 Schrems, para. 94.', 'Schrems, para. 94.'], 1);
    assert.equal(resolutionNote({ ...name, resolutionMethod: 'user_confirmed' }), 'Confirmed by you for this document.');
  });

  test('a citation that states its own identifier claims no inference', () => {
    assert.equal(resolutionNote(one([LEAD], 0)), 'Stated in this footnote.');
  });
});

describe('what the reviewer is told about a gap', () => {
  test('an unresolved back-reference points at the footnote it read, not at the document', () => {
    // "nothing in this document defines it" is the wrong thing to say about an `Ibid.`:
    // nothing defines an Ibid., and the useful fact is which footnote it looked at.
    const citation = one(['Van Gend en Loos, para. 12.', 'Ibid., para. 14.'], 1);
    assert.equal(unresolvedMessage(citation),
      '"Ibid." points back to footnote 1, which does not establish an authority to point at.');
  });

  test('an Ibid. with nothing above it says so without inventing a footnote number', () => {
    const citation = one(['Ibid., para. 12.'], 0);
    assert.equal(unresolvedMessage(citation),
      '"Ibid." points back to an authority cited before it, but nothing before it establishes one.');
  });

  test('an ambiguous back-reference blames the footnote, not the reference', () => {
    const citation = one(['Case C-293/12, para. 40; Case C-131/12, para. 20.', 'Ibid., para. 44.'], 1);
    assert.equal(unresolvedMessage(citation),
      'Footnote 1 cites more than one authority, so "Ibid." does not say which of them is meant.');
  });

  test('an ordinary short form keeps the wording it had', () => {
    const citation = one(['Case C-362/14 Schrems, para. 94.', 'Case C-311/18 Schrems, para. 168.', 'Schrems, para. 94.'], 2);
    assert.equal(unresolvedMessage(citation), '"Schrems" could refer to more than one authority, and this document does not say which.');
  });
});

describe('the official source a back-reference links to', () => {
  test('links to the authority it resolved to, never to the word Ibid.', () => {
    // `value` is "Ibid.", which is not a usable CURIA query and not a document; the link
    // has to come from the identifiers it inherited.
    const citation = one([LEAD, 'Ibid., para. 44.'], 1);
    assert.equal(officialSourceUrl(citation), 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62012CJ0293');
  });

  test('a judgment and the opinion in the same case are told apart in a pick-list', () => {
    const [judgment, opinion] = detectCitationsAcrossFootnotes([
      'Judgment of 6 September 2017, Intel v Commission, Case C-413/14 P, ECLI:EU:C:2017:632, para. 138.',
      'Opinion of Advocate General Wahl of 20 October 2016 in Intel, ECLI:EU:C:2016:788, point 73.',
    ]).flat();
    assert.notEqual(candidateLabel({ ...judgment }), candidateLabel({ ...opinion }));
  });

  test('the order and the judgment in one case are separate options, not one', () => {
    // Both from the Intel decision, which cites T-457/08 in both document types. Neither
    // carries an ECLI — orders usually do not — so a key built on the case number was the
    // same string for both, and React may drop one child of a pair sharing a key. The
    // reviewer would then be choosing between two documents with one of them off the screen.
    const order = { label: 'T-457/08', source: 'curia' as const, caseNumber: 'T-457/08', celex: '62008TO0457', documentType: 'order' as const };
    const judgment = { label: 'T-457/08', source: 'curia' as const, caseNumber: 'T-457/08', celex: '62008TJ0457', documentType: 'judgment' as const };
    assert.notEqual(candidateKey(order), candidateKey(judgment));
  });
});

describe('what the list shows, and what opens by itself', () => {
  test('a footnote whose citations all resolved needs no review', () => {
    assert.equal(needsReview(context([LEAD], 0)), false);
  });

  test('an ambiguous citation puts its footnote on the list', () => {
    const footnotes = ['Case C-362/14 Schrems, para. 94.', 'Case C-311/18 Schrems, para. 168.', 'Schrems, para. 94.'];
    assert.equal(needsReview(context(footnotes, 2)), true);
  });

  test('a footnote with no citation at all is not something to review', () => {
    // Ordinary commentary. Listing it would be noise, which is the problem being solved.
    assert.equal(needsReview(context([LEAD, 'This proposition is uncontroversial.'], 1)), false);
  });

  test('landing on a footnote with one citation opens it', () => {
    assert.equal(autoSelectable(context([LEAD], 0))?.value, 'ECLI:EU:C:2014:238');
  });

  test('landing on a footnote citing two authorities opens neither', () => {
    // There is a choice to make and no basis for making it. Opening one would put a source
    // panel behind a decision the reviewer never took.
    const both = context(['Case C-293/12, para. 40; Case C-131/12, para. 20.'], 0);
    assert.equal(both.length, 2);
    assert.equal(autoSelectable(both), undefined);
  });

  test('landing on a footnote with no citation opens nothing', () => {
    assert.equal(autoSelectable([]), undefined);
  });
});

/**
 * Footnotes the conversion did not convert.
 *
 * The real decision this was built against holds 549 Word footnotes and nine more that a PDF
 * conversion left as body paragraphs, each opening with its PDF number typed as superscript.
 * Word has no footnote to report for those and the pane's list has none to match, so on the
 * page they look like every other footnote and to Ibid they did not exist at all.
 */
describe('footnotes a PDF conversion left in the body text', () => {
  const inline = '72 See, by analogy judgments of 10 September 2009, Akzo Nobel and others v Commission, C-97/08 P, EU:C:2009:536, paragraph 61.';

  test('a paragraph opening with a number and a capital is read as a note', () => {
    const [note] = inlineFootnotesInBody(`Body text of the decision.\r${inline}\rMore body text.`);
    assert.equal(note.number, 72, 'the number it carries in the document is the one to show');
    assert.ok(note.text.startsWith('See, by analogy judgments'), 'the typed number is not part of the note');
    assert.equal(note.inBody, true, 'and it is marked as something Word does not hold as a footnote');
  });

  test('the tail of a note broken across a page is not read as a note of its own', () => {
    // Conversions split a long note at a page boundary and leave the remainder as its own
    // paragraph, opening with whatever number the sentence happened to reach. Every one of
    // those continues mid-sentence, in lower case, which is what tells them apart.
    const fragments = [
      '15 seconds. The accelerated delivery time did not create any inaccuracies in the system.',
      '40 of that Regulation is to empower investigations by researchers on the evolution of risk.',
      '45 million active recipients. In fact, X is a social media platform with a wide reach.',
    ].join('\r');
    assert.deepEqual(inlineFootnotesInBody(fragments), []);
  });

  test('an ordinary body paragraph is not mistaken for one', () => {
    const body = 'The Commission observes that XIUC is legally a distinct entity.\r(48) Finally, the functional approach to the notion of provider applies here.';
    assert.deepEqual(inlineFootnotesInBody(body), []);
  });

  test('a numeral with a few words after it is too little to be a note', () => {
    assert.deepEqual(inlineFootnotesInBody('72 See Nature.'), []);
  });

  test('two notes carrying the same text are still two entries', () => {
    // Two of the nine repeat a source verbatim under different numbers. Keying them by text
    // would collapse them into one, and the second would vanish from the review.
    const source = 'The Verge, https://www.theverge.com/2022/11/9/23450289/platform-impersonators.';
    const notes = inlineFootnotesInBody(`92 ${source}\r131 ${source}`);
    assert.deepEqual(notes.map((note) => note.number), [92, 131]);
    assert.equal(new Set(notes.map((note) => note.id)).size, 2, 'and they are told apart');
  });
});

/**
 * Citations in the running text.
 *
 * Footnotes are where EU drafting puts its authorities, and everything the pane read assumed
 * it. The parenthetical form is ordinary prose all the same, and to Ibid it did not exist:
 * the body was read only for notes a conversion had flattened into it.
 */
describe('citations the drafter wrote into the running text', () => {
  test('a parenthetical citation in prose is offered for review', () => {
    const [span] = parentheticalsInBody([
      'The Court has held otherwise (Case C-293/12 Digital Rights Ireland, para. 40).',
    ]);
    assert.equal(span.text, 'Case C-293/12 Digital Rights Ireland, para. 40');
    assert.equal(span.inText, true, 'and it is marked as text rather than as a note');
    assert.equal(span.number, 0, 'the document gives it no number of its own');
  });

  test('an act carrying its own brackets is read to the outer close', () => {
    // Cutting at the first ")" would hand detection "Regulation (EU" and lose the act.
    const [span] = parentheticalsInBody(['see (Regulation (EU) 2016/679, Article 17(1))']);
    assert.equal(span.text, 'Regulation (EU) 2016/679, Article 17(1)');
  });

  test('a reference mark left in the text is not a citation', () => {
    // The guidelines on exclusionary abuses write their footnote marks `(90)`, and a
    // conversion leaves every one behind; the Intel decision numbers its recitals `(48)`.
    // Digits alone, and both would otherwise be offered to the reviewer to inspect.
    assert.deepEqual(parentheticalsInBody(['A paragraph of the decision. (90)', '(48)']), []);
  });

  test('a bracket the conversion never closed yields nothing', () => {
    assert.deepEqual(parentheticalsInBody(['a conversion left this open (Case C-293/12']), []);
  });

  test('two parentheses in one paragraph are two spans', () => {
    const spans = parentheticalsInBody([
      'compare (Case C-293/12, para. 40) with (Case C-362/14, para. 94) on this point',
    ]);
    assert.equal(spans.length, 2);
    assert.equal(new Set(spans.map((span) => span.id)).size, 2, 'and they are told apart');
  });

  test('a note flattened into the body is not also read as running text', () => {
    // Such a note carries parentheses of its own. Reading the same paragraph both ways would
    // list every citation in it twice — once as the note, once as a citation in the text.
    const body = '72 See Akzo Nobel and others v Commission (C-97/08 P), paragraph 61.\rOrdinary prose.';
    assert.deepEqual(parentheticalsInBody(bodyProseLines(body)), []);
  });
});

describe('when a passage was last confirmed against EUR-Lex', () => {
  const at = (iso: string) => new Date(iso);

  test('states the time as a fact, with no hedging around it', () => {
    // The point of revalidating on every use is that this is not a disclaimer. CELLAR
    // answering `304` is the Publications Office saying the text in hand is current, so the
    // pane says when that happened and stops — no "cached", no "may be out of date".
    const note = verificationNote(at('2026-08-21T14:32:00').toISOString(), at('2026-08-21T14:35:00'));
    assert.equal(note, 'Verified against EUR-Lex at 14:32');
  });

  test('names the day when the confirmation was not today', () => {
    // A document served from a store with nothing left to revalidate it against carries the
    // time it genuinely was last confirmed. Rendered as "at 14:32" alone, last week's
    // confirmation would be read as this afternoon's.
    const note = verificationNote(at('2026-08-18T09:05:00').toISOString(), at('2026-08-21T14:35:00'));
    assert.equal(note, 'Verified against EUR-Lex on 18 August at 09:05');
  });

  test('names the year too once it is a different one', () => {
    const note = verificationNote(at('2025-12-30T23:59:00').toISOString(), at('2026-08-21T14:35:00'));
    assert.equal(note, 'Verified against EUR-Lex on 30 December 2025 at 23:59');
  });

  test('claims nothing where nothing was retrieved', () => {
    // The CURIA case-record and Commission register previews fetch no text, so they have
    // confirmed nothing and must not appear to have.
    assert.equal(verificationNote(undefined), undefined);
    assert.equal(verificationNote('not a date'), undefined);
  });

  test('a Commission decision names the Commission, which is who confirmed it', () => {
    const note = verificationNote(at('2026-08-21T14:32:00').toISOString(), at('2026-08-21T14:35:00'), { source: 'European Commission' });
    assert.equal(note, 'Verified against the Commission at 14:32');
  });

  test('a passage waiting for its confirmation says so after the date it really has', () => {
    const note = verificationNote(at('2026-08-18T09:05:00').toISOString(), at('2026-08-21T14:35:00'),
      { source: 'European Commission', checking: true });
    assert.equal(note, 'Verified against the Commission on 18 August at 09:05; checking for changes');
  });
});

describe('telling a republished source from a confirmed one', () => {
  const passage = { url: 'https://ec.europa.eu/x.pdf', excerpt: '(1000) The Commission concludes.', passage: 'cited' };

  test('a confirmation that changed only the date changed nothing', () => {
    assert.equal(sourceChanged([passage], [{ ...passage, verifiedAt: '2026-09-16T10:00:00Z' } as typeof passage]), false);
  });

  test('a different passage, decision, or kind of passage is a change', () => {
    assert.equal(sourceChanged([passage], [{ ...passage, excerpt: '(1000) The Commission finds.' }]), true);
    assert.equal(sourceChanged([passage], [{ ...passage, url: 'https://ec.europa.eu/y.pdf' }]), true);
    assert.equal(sourceChanged([passage], [{ ...passage, passage: 'opening' }]), true);
    assert.equal(sourceChanged([passage], [passage, passage]), true, 'a single answer that became an ambiguity');
  });
});

describe('what Word hands back as a footnote', () => {
  test("the reference mark is stripped, because `Ibid.` is anchored to what follows it", () => {
    // `Footnote.body.text` opens with the mark that draws the note's number — U+0002 for an
    // auto-numbered footnote, and it is not whitespace, so `trim` alone left it in place.
    // See CONTROL_CHARACTERS in citation-view.ts for what it cost.
    const [note] = toReviewFootnotes([String.fromCharCode(2) + 'Ibid., para. 97.']);
    assert.equal(note.text, 'Ibid., para. 97.');
  });

  test('a tab after the mark becomes a space rather than disappearing', () => {
    // Word writes the mark and then a tab. Removing both outright would join the number to
    // the first word; a space is what the document shows anyway.
    const [note] = toReviewFootnotes([String.fromCharCode(2) + String.fromCharCode(9) + 'Ibid.']);
    assert.equal(note.text, 'Ibid.');
    const [split] = toReviewFootnotes(['Judgment of 13 May 2014,' + String.fromCharCode(11) + 'Google Spain.']);
    assert.equal(split.text, 'Judgment of 13 May 2014, Google Spain.', 'and words are not run together');
  });
});

describe('a passage citing several paragraphs, or "et seq."', () => {
  test('an excerpt of disjoint passages is set as those passages', () => {
    assert.deepEqual(excerptPassages('(189) First.\n\n…\n\n(1324) Second.\n\n…\n\n(1398) Third.'),
      ['(189) First.', '(1324) Second.', '(1398) Third.']);
    assert.deepEqual(excerptPassages('(189) One passage,\nwrapped over two lines.'), ['(189) One passage,\nwrapped over two lines.']);
    assert.deepEqual(excerptPassages(''), [], 'a scan shows no empty paragraph');
  });

  test('a cited paragraph the text does not have is named', () => {
    assert.equal(unlocatedNote(['1398']), 'Paragraph 1398 is not in the retrieved text; the other paragraphs cited are shown.');
    assert.equal(unlocatedNote(['1324', '1398–1400']), 'Paragraphs 1324 and 1398–1400 are not in the retrieved text; the other paragraphs cited are shown.');
    assert.equal(unlocatedNote(['8.4.4.1'], 'Sections 8.3.4.1 and 8.4.4.1'), 'Section 8.4.4.1 is not in the retrieved text; the other sections cited are shown.');
    assert.equal(unlocatedNote(undefined), undefined);
    assert.equal(unlocatedNote([]), undefined);
  });

  test('"et seq." says that the paragraphs after the one named are not shown', () => {
    assert.equal(followingNote([189]), 'Cited “et seq.”: paragraph 189 is shown, not the paragraphs after it.');
    assert.equal(followingNote([189, 1324, 1398]), 'Cited “et seq.”: paragraphs 189, 1324 and 1398 are shown, not the paragraphs after each.');
    assert.equal(followingNote(undefined), undefined);
  });

  test('and leaves out a paragraph that is not shown at all', () => {
    assert.equal(followingNote([189, 1398], ['1398']), 'Cited “et seq.”: paragraph 189 is shown, not the paragraphs after it.');
    assert.equal(followingNote([1398], ['1398']), undefined);
  });
});

describe('a case number that is another case', () => {
  test('a corrected number says what was written, what that is, and what is shown', () => {
    assert.equal(numberMismatchNote({
      cited: 'M.7967', citedTitle: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', name: 'Ball/Rexam', caseNumber: 'M.7567',
    }), 'Case number corrected. The footnote cites M.7967, which the Commission’s register files as APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING. '
      + 'The case it names, Ball/Rexam, is M.7567, and that is the case shown here.');
  });

  test('a number the register has never used says so', () => {
    assert.equal(numberMismatchNote({ cited: 'M.9376', name: 'Siemens/Alstom', caseNumber: 'M.8677' }),
      'Case number corrected. The footnote cites M.9376, which is not in the Commission’s case data. '
      + 'The case it names, Siemens/Alstom, is M.8677, and that is the case shown here.');
  });

  test('where no case carries the name, it says that nothing is shown', () => {
    assert.equal(numberMismatchNote({ cited: 'M.7967', citedTitle: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', name: 'Nonexistent/Parties' }),
      'Check the case number. The footnote cites M.7967, which the Commission’s register files as APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING, not Nonexistent/Parties. '
      + 'No single case in the register is titled Nonexistent/Parties, so no decision is shown.');
    assert.equal(numberMismatchNote(undefined), undefined);
  });
});

describe('a court document that is not what the footnote called it', () => {
  // Footnote 460 of the 2026 draft merger guidelines cites Advocate General Rantos's Opinion
  // as "Judgment of 15 December 2002 … EU:C:2022:993". The resolver shows the Opinion the ECLI
  // names and reports what its heading says it is.
  test('says what the footnote called it and what is shown', () => {
    assert.equal(documentTypeNote({ documentType: 'judgment', documentTypeStated: true }, 'opinion'),
      'The footnote calls this a judgment, but the document its ECLI names is an Advocate General’s Opinion, and that is what is shown here.');
  });

  test('does not put words in the footnote’s mouth where it named no kind of document', () => {
    assert.equal(documentTypeNote({ documentType: 'judgment' }, 'order'), 'The document this citation names is an order.');
  });

  test('says nothing where the two agree, or where the document said nothing', () => {
    assert.equal(documentTypeNote({ documentType: 'opinion', documentTypeStated: true }, 'opinion'), undefined);
    assert.equal(documentTypeNote({ documentType: 'judgment', documentTypeStated: true }, undefined), undefined);
  });
});

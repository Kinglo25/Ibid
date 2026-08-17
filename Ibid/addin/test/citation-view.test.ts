import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCitationsAcrossFootnotes, getCitationContextsForFootnotes, type CitationContext } from '../../shared/src/index.ts';
import { candidateLabel, confirmationKey, officialSourceUrl, resolutionNote, toReviewFootnotes, unresolvedMessage } from '../src/ui/citation-view.ts';

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
});

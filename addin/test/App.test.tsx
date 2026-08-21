import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import App from '../src/ui/App.tsx';
import { installWordStub } from './word-stub.ts';

/**
 * The task pane, rendered. Everything below goes through the browser-preview document that
 * ships in `shared`, so what these tests click through is the same memo the resolver suite
 * asserts against — one fixture, not two that can drift.
 *
 * These cover the wiring the pure `citation-view` tests cannot: that the right citation
 * reaches the right footnote, that confirming one actually changes the pane, and that a
 * confirmation carries to the back-references depending on it.
 */

afterEach(cleanup);

/**
 * The pane's default stub returns no documents, so every retrieval state below the 'empty'
 * one went unexercised — including the note that tells a lawyer the passage in front of
 * them is not English. That note is the whole of the current French policy: where no
 * English version was ever published, Ibid shows the authentic French and says why. It is
 * the one thing that must not silently regress, because the failure mode is a reader
 * assuming they are looking at something they are not.
 */
const originalFetch = globalThis.fetch;
const servingDocuments = (documents: unknown[]) => {
  globalThis.fetch = (() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ documents }),
  } as Response)) as typeof fetch;
};
afterEach(() => { globalThis.fetch = originalFetch; });

const frenchJudgment = {
  title: 'Case C-280/19', source: 'CURIA', url: 'https://eur-lex.europa.eu/x',
  excerpt: '30 Par lettre du 24 juin 2016, l\u2019ERCEA a confirm\u00e9 sa position.',
  language: 'fr' as const,
};

const findChip = async (label: string) => {
  const chips = await screen.findAllByRole('button', { name: (name) => name.trim() === label });
  return chips;
};

/** The list defaults to what needs a decision; resolved citations live behind the toggle. */
const showEveryFootnote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /Show all/ }));
};

describe('the pane, rendered', () => {
  test('reads the preview document when Word is not there', async () => {
    const user = userEvent.setup();
    render(<App />);
    await showEveryFootnote(user);
    // Footnote 1 is the GDPR cited in full; its chip is the act itself.
    assert.ok(await screen.findByRole('button', { name: /Regulation \(EU\) 2016\/679/ }));
    // ...and the memo runs all the way to its back-references, so the whole document was
    // read rather than just its opening.
    assert.equal((await findChip('Ibid.')).length, 1);
    assert.equal((await findChip('Supra note 14')).length, 1);
  });

  test('lists only what needs a decision, until asked for everything', async () => {
    // The reason the pane changed shape. A brief with a hundred footnotes has a handful
    // that need a person, and listing all hundred buries them.
    const user = userEvent.setup();
    render(<App />);

    // "Schrems" is ambiguous and "Post Danmark" undefined, so both must be listed...
    assert.ok(await screen.findByRole('button', { name: /Schrems \?/ }));
    assert.ok(await screen.findByRole('button', { name: /Post Danmark \?/ }));
    // ...while a citation that resolved cleanly is not competing for attention.
    assert.equal(screen.queryByRole('button', { name: /Regulation \(EU\) 2016\/679/ }), null);

    await showEveryFootnote(user);
    assert.ok(await screen.findByRole('button', { name: /Regulation \(EU\) 2016\/679/ }));
  });

  test('says how many footnotes are still outstanding', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Needs review' });
    // The memo leaves exactly two: the ambiguous "Schrems" and the undefined "Post Danmark".
    const count = await screen.findByText('2', { selector: '.count' });
    assert.ok(count);
  });

  test('a resolved back-reference says which footnote it was read from', async () => {
    // Footnote 20 is a bare `Ibid.`; footnote 19 is `Supra note 14`. Selecting each has to
    // show provenance naming the footnote it read, not a generic "stated in this footnote".
    const user = userEvent.setup();
    render(<App />);
    await showEveryFootnote(user);

    const [supra] = await findChip('Supra note 14');
    await user.click(supra);
    await screen.findByText('Read from footnote 14, which this reference names.');

    const [ibid] = await findChip('Ibid.');
    await user.click(ibid);
    await screen.findByText('Read as the authority cited immediately before it, in footnote 19.');
  });

  test('an ambiguous citation offers its candidates instead of a source', async () => {
    // Footnote 12's "Schrems" matches both Schrems judgments, which the memo cites in full.
    const user = userEvent.setup();
    render(<App />);

    const [schrems] = await findChip('Schrems ?');
    await user.click(schrems);
    await screen.findByText(/could refer to more than one authority/);
    assert.equal(screen.getAllByRole('button', { name: 'Use this' }).length, 2);
  });

  test('confirming an ambiguous citation resolves it and says who decided', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [schrems] = await findChip('Schrems ?');
    await user.click(schrems);
    const [firstCandidate] = await screen.findAllByRole('button', { name: 'Use this' });
    await user.click(firstCandidate);

    await screen.findByText('Confirmed by you for this document.');
    await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'Use this' }), null));
  });

  describe('the language of the passage', () => {
    test('a French-only passage is shown in French and says so', async () => {
      // What the reviewer must never do is read this as English. No translator is
      // configured, so the authentic text is what there is - labelled, not disguised.
      servingDocuments([frenchJudgment]);
      const user = userEvent.setup();
      render(<App />);
      await showEveryFootnote(user);
      await user.click((await findChip('Ibid.'))[0]);

      await screen.findByText('Published only in French. Shown in the official language.');
      assert.ok(screen.getByText(/Par lettre du 24 juin 2016/));
    });

    test('the published English text is shown with no note at all', async () => {
      // The case that needs no explaining. A note here would be noise on every citation.
      servingDocuments([{ ...frenchJudgment, language: 'en', excerpt: '40 Nor is that retention of data...' }]);
      const user = userEvent.setup();
      render(<App />);
      await showEveryFootnote(user);
      await user.click((await findChip('Ibid.'))[0]);

      await screen.findByText(/Nor is that retention of data/);
      assert.equal(screen.queryByText(/Published only in French/), null);
    });

    test('a machine translation is marked as not authentic and links to the French', async () => {
      // Unreachable today - no translator is wired - but this is the path that opens the
      // moment one is, and a translation presented as the authority is the worst outcome
      // the feature can produce.
      servingDocuments([{ ...frenchJudgment, language: 'en', excerpt: '30 By letter of 24 June 2016...',
        translation: { from: 'fr', officialUrl: 'https://eur-lex.europa.eu/official-fr' } }]);
      const user = userEvent.setup();
      render(<App />);
      await showEveryFootnote(user);
      await user.click((await findChip('Ibid.'))[0]);

      await screen.findByText(/this is not the authentic text/);
      const link = screen.getByRole('link', { name: 'Open the official version' });
      assert.equal(link.getAttribute('href'), 'https://eur-lex.europa.eu/official-fr');
      assert.equal(screen.queryByText(/Published only in French/), null);
    });
  });

  /**
   * Whether the passage is the one that was cited.
   *
   * The resolver can retrieve the right judgment and still fail to find the paragraph
   * inside it — the markup conventions are not exhausted — and what it shows then is the
   * document's opening. On screen, under a citation naming a paragraph, that is
   * indistinguishable from the answer unless the pane says which one it is.
   */
  describe('what the passage is', () => {
    const wouters = {
      title: 'Wouters and Others, C-309/99', source: 'CURIA', url: 'https://eur-lex.europa.eu/x',
      locator: 'Point 46', language: 'en' as const,
    };

    test('the document opening is labelled as not being the cited paragraph', async () => {
      servingDocuments([{ ...wouters, passage: 'opening',
        excerpt: 'Avis juridique important | 61999J0309 Judgment of the Court of 19 February 2002...' }]);
      const user = userEvent.setup();
      render(<App />);
      await showEveryFootnote(user);
      await user.click((await findChip('Ibid.'))[0]);

      await screen.findByText(/Point 46 could not be located in the retrieved text/);
    });

    test('the cited paragraph carries no such note', async () => {
      servingDocuments([{ ...wouters, passage: 'cited',
        excerpt: '46 According to settled case-law, in the field of competition law...' }]);
      const user = userEvent.setup();
      render(<App />);
      await showEveryFootnote(user);
      await user.click((await findChip('Ibid.'))[0]);

      await screen.findByText(/According to settled case-law/);
      assert.equal(screen.queryByText(/could not be located/), null);
    });
  });
});

/**
 * The pane with a cursor, which is how it is actually used.
 *
 * A reviewer works from the document and asks the pane about the citation in front of them.
 * These drive a caret between footnotes through the Word stub and assert what is on screen,
 * which is the behaviour the browser-preview tests above structurally cannot reach.
 */
describe('following the cursor', () => {
  const googleSpain = 'Judgment of 13 May 2014, Google Spain SL and Google Inc. v AEPD, C-131/12, ECLI:EU:C:2014:317, paras 80-82.';
  const crossReference = 'See paragraph 12 above.';

  let word: ReturnType<typeof installWordStub> | undefined;
  afterEach(() => { word?.remove(); word = undefined; });

  test('the footnote index is collapsed, so the pane is the citation under the cursor', async () => {
    // The complaint this answers: on a real Commission decision the index is a hundred-odd
    // entries, and it stood between the reviewer and the one panel they wanted.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);

    const summary = await screen.findByText('Look through the footnotes instead');
    const index = summary.closest('details');
    assert.ok(index, 'the index should be inside a disclosure');
    assert.equal(index.open, false, 'the index should start collapsed');
  });

  test('landing on a citation opens it without being asked', async () => {
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByRole('heading', { name: 'Source' });
    await screen.findByText('ECLI:EU:C:2014:317', { selector: '.selected-citation' });
  });

  test('moving the cursor to a footnote without a citation clears the source', async () => {
    // Otherwise the only thing on screen describes a footnote the reviewer has left, which
    // is worse with the index collapsed than it was with a list to re-orient against.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByRole('heading', { name: 'Source' });

    word.putCursorOn(1);
    await screen.findByRole('heading', { name: 'No citation selected' });
  });

  test('a footnote whose body Word will not name is found by the paragraph the caret is in', async () => {
    // The build this was written for: a caret inside a long footnote of a converted
    // decision, with a hundred characters of it selected, reported as being in no footnote
    // at all. `parentBody` said the document, the reference-mark route said nothing, and the
    // pane concluded the reviewer had left the footnotes entirely — leaving the previous
    // footnote's source up as the answer. The paragraph is the smaller, more local claim.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorInFootnoteParagraph(0);
    await screen.findByText('Footnote 1 context');
    assert.equal(word.documentTextLoads(), 0, 'and still without reading the whole document');
  });

  test('one citation picked out of a footnote holding several names that footnote', async () => {
    // A reviewer with seven citations in one footnote selects the one they want. Word calls
    // the parent body the section, reports no reference mark, and hands back the fragment —
    // 122 characters that are plainly the footnote's own opening words.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.selectWithinFootnote(0, 60);
    await screen.findByText('Footnote 1 context');
  });

  test('a fragment Word spells differently from the footnote it came from still matches', async () => {
    // The failure this was written for. Every route that worked compared a body's text to a
    // body's text; this is the only one comparing a `Range` to a `Body`, and Word need not
    // spell them alike — a hyperlinked ECLI, a non-breaking hyphen holding a case number
    // together across a line break, the footnote's own numbering mark. So identity rests on
    // letters and digits, not on how Word chose to punctuate them.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.selectWithinFootnote(0, 60, (text) => `\u0002 ${text.replace(/-/g, '\u2011').replace(/, /g, ',\u00a0')}`);
    await screen.findByText('Footnote 1 context');
  });

  test('a footnote a selection was dragged across is read back out of the selection', async () => {
    // What a reviewer actually did: swept the cursor over a long multi-citation footnote in
    // a decision converted from PDF. Word named the parent body the section, handed back
    // more text than the footnote holds, and offered body paragraphs for it — so every route
    // that asks what the caret is inside failed, and the pane left the previous footnote's
    // source standing as though it were the answer. A selection that contains a footnote
    // identifies it just as well as one contained by it.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.dragAcrossFootnote(0);
    await screen.findByText('Footnote 1 context');
  });

  test('a section the cursor turns out to be in is not read either', async () => {
    // A section of a decision converted from PDF is the decision. Skipping only `MainDoc`
    // meant the one cursor position that reports a section paid the whole cost the rest of
    // this function exists to avoid, on every movement of the caret.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.dragAcrossFootnote(0);
    await screen.findByText('Footnote 1 context');

    assert.equal(word.documentTextLoads(), 0, 'a section is as expensive to read as the document');
  });

  test('a short footnote swallowed by a long selection is not claimed as the answer', async () => {
    // The containing direction is the dangerous one. This document has 148 footnotes whose
    // text duplicates another's, and the short ones — `Ibid.`, a bare cross-reference — sit
    // inside almost any long passage. Matching on one would answer confidently with a
    // footnote the reviewer had not gone anywhere near.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.dragAcrossFootnote(1);
    await screen.findByRole('heading', { name: 'No citation selected' });
  });

  test('a selection holding two footnotes answers with the one it is about', async () => {
    // The rule that settles the containing direction when more than one footnote qualifies:
    // the longest. A sweep across a long note in a converted decision picks up whatever short
    // notes sit beside it, and answering with one of those would be answering about a
    // footnote the reviewer never went near.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.dragAcrossFootnote(0, crossReference);
    await screen.findByText('Footnote 1 context');
  });

  test('landing on a reference mark does not read the whole document', async () => {
    // The caret on a reference mark sits in the body, so `selection.parentBody` is the
    // document itself. Loading its text alongside its type cost every word of a 199-page
    // decision on every cursor movement, before a single match had been attempted — and
    // the one thing that string can never be is equal to a footnote.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');

    assert.equal(word.documentTextLoads(), 0, 'the document body is not what identifies a footnote');
  });

  test('re-reading the document leaves the handler the cursor arrives on alone', async () => {
    // Registering a handler and removing one are both asynchronous, and the pane awaits
    // neither, so tearing one down and putting it back races Office for the live handler.
    // Keying registration on the footnotes forced exactly that — a fresh array twice at
    // startup, since StrictMode double-invokes the mount effect, and once per hot update.
    // The pane that loses the race answers the reviewer's first click and freezes on it,
    // which is indistinguishable on screen from a pane that is simply following.
    const user = userEvent.setup();
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/footnotes ready for review/);
    assert.deepEqual(word.handlerChurn(), { registrations: 1, removals: 0 });

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');
  });

  test('a source the cursor has moved away from says so rather than reading as the answer', async () => {
    // The cursor in ordinary body text deliberately leaves the panel up — a reviewer
    // reading the document should not have the source they are working from blanked at the
    // first click. But with the index collapsed the panel is the only thing on screen, and
    // it answers a question about where the cursor is. It has to say which footnote it is
    // still describing.
    word = installWordStub([googleSpain, crossReference]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');

    word.putCursorOn(null);
    await screen.findByText(/The cursor has left footnote 1/);
    assert.ok(screen.getByText('Footnote 1 context'), 'the source itself stays, so nothing is taken away');
  });
});

/**
 * The cursor in places the reference-mark route does not reach.
 *
 * A reviewer reading a long footnote clicks in the footnote itself, at the foot of the
 * page, not on the mark in the body. That is a different path through the Word API and it
 * is the one that was failing in practice.
 */
describe('finding the footnote the cursor is actually in', () => {
  const akzo = 'Judgment of 10 September 2009, Akzo Nobel and Others v Commission, Case C-97/08 P, ECLI:EU:C:2009:536, paragraph 60.';
  const sevenCitations = 'See, by analogy judgments of 10 September 2009, Akzo Nobel and others v Commission, C-97/08 P, EU:C:2009:536, paragraph 61; of 1 October 2013, Elf Aquitaine v Commission, C-521/09 P, EU:C:2011:620, paragraphs 57 and 63.';

  let word: ReturnType<typeof installWordStub> | undefined;
  afterEach(() => { word?.remove(); word = undefined; });

  test('clicking inside the footnote text finds that footnote, not the one before it', async () => {
    word = installWordStub([akzo, sevenCitations]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');

    // The footnote citing several authorities. It opens none of them by itself, but the
    // pane must at least have moved off footnote 1 — that staleness was the reported bug.
    word.putCursorInFootnoteText(1);
    await screen.findByText('Footnote 2', { selector: '.count' });
    assert.equal(screen.queryByText('Footnote 1 context'), null);
  });

  test('a footnote citing several authorities offers each of them', async () => {
    word = installWordStub([akzo, sevenCitations]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorInFootnoteText(1);
    await screen.findByText('Footnote 2', { selector: '.count' });

    // Nothing opens by itself where there is a choice to make, so both are offered — on the
    // footnote under the cursor, which is a different row from the index's own chips.
    const chips = within(document.querySelector('.focused-chips') as HTMLElement);
    assert.ok(chips.getByRole('button', { name: /EU:C:2009:536/ }));
    assert.ok(chips.getByRole('button', { name: /EU:C:2011:620/ }));
  });

  test('a selection identifies its footnote even when the parent body does not', async () => {
    word = installWordStub([akzo, sevenCitations]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    // Word reported a body the pane never read; the selected text still pins it down.
    word.putCursorInUnknownFootnote('Elf Aquitaine v Commission, C-521/09 P');
    await screen.findByText('Footnote 2', { selector: '.count' });
  });

  test('a note the conversion left in the body is followed like any other', async () => {
    // The point of picking those notes up at all: no selecting, no explaining. The caret
    // lands in the paragraph and the pane answers, exactly as it does for a real footnote.
    const inline = `72 ${sevenCitations}`;
    word = installWordStub([akzo], `Body text of the decision.\r${inline}\rMore body text.`);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorInBodyParagraph(inline);
    await screen.findByText('Note 72, in body text');
  });

  test('a note in the body keeps the number the document shows, not a position in the list', async () => {
    // It is appended past the 549 real footnotes so that nothing already numbered moves,
    // and it is the seventy-second note on the page. The reviewer goes looking for 72.
    const inline = `72 ${sevenCitations}`;
    word = installWordStub([akzo], `Body text of the decision.\r${inline}`);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context', undefined, { timeout: 3000 });

    word.putCursorInBodyParagraph(inline);
    await screen.findByText('Note 72, in body text');
    assert.equal(screen.queryByText('Footnote 2 context'), null, 'its position in the list is not its number');
  });

  test('a citation Word has no footnote for is answered from the text selected', async () => {
    // The X/DSA decision, converted from PDF: some footnote text is left inline in the body,
    // so Word reports the section, reports no reference mark, and the pane's list — 549
    // footnotes, none of them empty — holds no entry matching what is on screen. There is no
    // footnote here to find. The reviewer is still looking straight at a citation.
    word = installWordStub([akzo]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.selectTextOutsideFootnotes(sevenCitations.slice(0, 121));
    await screen.findByRole('heading', { name: 'Source' });
    await screen.findByText('EU:C:2009:536', { selector: '.selected-citation' });
  });

  test('a passage answered from the selection claims no footnote number', async () => {
    // Word does not know this is a footnote, so the pane must not invent a number the
    // reviewer could go looking for in the document.
    word = installWordStub([akzo]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.selectTextOutsideFootnotes(sevenCitations.slice(0, 121));
    await screen.findByText('What you selected', { selector: '.context-label' });
    assert.equal(screen.queryByText(/Footnote \d+ context/), null, 'no footnote number is claimed');
    assert.ok(screen.getByText('Selected text', { selector: '.count' }), 'the panel says what it is about');
  });

  test('reading through the document does not answer from whatever words are under the caret', async () => {
    // Answering from a selection is something the reviewer asked for by making one. Doing it
    // for a caret would replace the source they are working from at the first click into the
    // text, which is the behaviour the cursor-follow was careful to avoid.
    word = installWordStub([akzo]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');

    word.selectTextOutsideFootnotes('Akzo Nobel');
    await screen.findByText(/The cursor has left footnote 1/);
    assert.ok(screen.getByText('Footnote 1 context'), 'the source itself stays, so nothing is taken away');
  });

  test('a selection holding several citations opens none of them by itself', async () => {
    // The same rule a footnote holding several gets: the reviewer says which they meant.
    word = installWordStub([akzo]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.selectTextOutsideFootnotes(sevenCitations);
    const chips = await screen.findByText(/EU:C:2011:620/);
    assert.ok(chips, 'each citation in the selection is offered');
    assert.equal(screen.queryByText('What you selected', { selector: '.context-label' }), null, 'and none opens by itself');
  });

  test('a footnote it cannot identify is admitted, not answered stale', async () => {
    word = installWordStub([akzo, sevenCitations]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');

    // Nothing to match on at all. The previous footnote's source must not stay on screen
    // pretending to describe this one.
    word.putCursorInUnknownFootnote('');
    await screen.findByText(/could not match to one it has read/);
    assert.equal(screen.queryByText('Footnote 1 context'), null);
  });
});

/**
 * Footnotes a conversion rebuilt as an auto-numbered list.
 *
 * The third shape the X/DSA decision's footnotes arrive in. Fifty-three of them are body
 * paragraphs whose number Word draws itself, so the paragraph's own text opens at "Judgment
 * of 31 May 2018, Groningen Seaports v. Commission…" and no reading of the body text can
 * find a number in it. It is also why the same decision shows two footnotes numbered 275:
 * Word renumbered its own 549 from one, while these kept the numbers they had in the PDF.
 */
describe('footnotes Word numbers but does not hold', () => {
  const groningen = 'Judgment of 31 May 2018, Groningen Seaports v. Commission, Case T-160/16, EU:T:2018:317, paragraph 116.';

  let word: ReturnType<typeof installWordStub> | undefined;
  afterEach(() => { word?.remove(); word = undefined; });

  test('a note whose number only Word knows is read with that number', async () => {
    word = installWordStub(['Reply to the second RFI, request 2 of section VII.'], 'Body text.', [
      { label: '275', text: groningen },
    ]);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorInBodyParagraph(groningen);
    await screen.findByText('Note 275, in body text');
    await screen.findByText('EU:T:2018:317', { selector: '.selected-citation' });
  });

  test('a recital numbered as a list is not read as a note', async () => {
    // The decision's own recitals are an auto-numbered list too. They render as `(48)`, and
    // the converted footnotes as a bare `275` — which is the whole of the difference left
    // between them after the conversion.
    word = installWordStub(['A real footnote.'], 'Body text.', []);
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorInBodyParagraph('A recital of the decision, numbered as a list.');
    assert.equal(screen.queryByText(/in body text/), null, 'a recital is not a footnote');
  });

  test('a document Word cannot list paragraphs for still reads its footnotes', async () => {
    // Guarded on purpose: this is one more call into API surface that varies by build, at
    // the point where the whole document is being read. Losing the list-numbered notes is a
    // gap; losing the 549 real footnotes with them would be the pane not working at all.
    word = installWordStub(['Judgment of 10 September 2009, Akzo Nobel and Others v Commission, Case C-97/08 P, ECLI:EU:C:2009:536, paragraph 60.']);
    word.breakParagraphs();
    render(<App />);
    await screen.findByText('Look through the footnotes instead');

    word.putCursorOn(0);
    await screen.findByText('Footnote 1 context');
  });
});

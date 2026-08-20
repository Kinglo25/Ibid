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

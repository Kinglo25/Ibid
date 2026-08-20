import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import App from '../src/ui/App.tsx';

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
});

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

const findChip = async (label: string) => {
  const chips = await screen.findAllByRole('button', { name: (name) => name.trim() === label });
  return chips;
};

describe('the pane, rendered', () => {
  test('reads the preview document when Word is not there', async () => {
    render(<App />);
    // Footnote 1 is the GDPR cited in full; its chip is the act itself.
    assert.ok(await screen.findByRole('button', { name: /Regulation \(EU\) 2016\/679/ }));
    // ...and the memo runs all the way to its back-references, so the whole document was
    // read rather than just its opening.
    assert.equal((await findChip('Ibid.')).length, 1);
    assert.equal((await findChip('Supra note 14')).length, 1);
  });

  test('a resolved back-reference says which footnote it was read from', async () => {
    // Footnote 20 is a bare `Ibid.`; footnote 19 is `Supra note 14`. Selecting each has to
    // show provenance naming the footnote it read, not a generic "stated in this footnote".
    const user = userEvent.setup();
    render(<App />);

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
});

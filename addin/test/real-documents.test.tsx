import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import App from '../src/ui/App.tsx';
import { installWordStub, type WordStub } from './word-stub.ts';
import { notesFromDocx } from '../../scripts/corpus-sources.mjs';
import { getCitationContextsForFootnotes } from '../../shared/src/index.ts';

/**
 * The pane, driven by real Word documents instead of by fixtures.
 *
 * Every other test in this file's neighbourhood hands `installWordStub` footnotes typed out
 * by hand, and a hand-typed footnote is written by the same understanding that wrote the
 * pane. The bug that cost the most here — Word's reference mark surviving `trim`, so every
 * back-reference in a real document silently became no citation at all — was invisible to
 * all of them until someone opened the file in Word. These read the notes out of the .docx
 * itself, through the same reader the corpus harness uses, so what reaches the pane is what
 * a reviewer's document actually contains: the ligatures, the non-breaking spaces, the
 * footnotes a PDF conversion left in the body text.
 *
 * What this cannot cover is Word itself. `notesFromDocx` reads the file; the pane reads
 * Office.js, and the two do not spell everything the same way — see `scripts/word-check.mjs`,
 * which asks real Word and reports where the reader disagrees with it.
 */

afterEach(cleanup);

const sample = (name: string) => fileURLToPath(new URL(`../../samples/ibid-demo-docx/${name}`, import.meta.url));

/**
 * `absent` marks a document that is not in the repository and must not be added to it: the
 * Intel decision is public, but a sample that names real parties is kept out and the suite
 * skips it rather than failing for whoever does not hold a copy.
 */
const DOCUMENTS = [
  { id: 'back-reference-test', file: 'back-reference-test.docx' },
  { id: 'eu-case-law-citation-test', file: 'eu-case-law-citation-test.docx' },
  { id: 'data-retention-memo', file: 'EU_Data_Retention_Memo.docx' },
  { id: 'intel-decision', file: 'EC Decision - Intel (2009).docx', absent: true },
  // Two 2026 Commission drafts, converted from the published PDF by Word, and converted very
  // differently: the merger guidelines came back with 433 of their footnotes still footnotes,
  // and the guidelines on exclusionary abuses with none at all. Both are public documents
  // naming no private party; both are large, and kept out of the repository for that.
  { id: 'merger-guidelines', file: 'Merger Guidelines - final for public consultation.docx', absent: true },
  { id: 'exclusionary-abuses-guidelines', file: 'Guidelines_on_exclusionary_abuses_of_dominance_102TFEU.docx', absent: true },
];

/**
 * How many footnotes any one document is driven through.
 *
 * The Intel decision holds two thousand, and landing on every one of them would trade a
 * suite that runs in seconds for one nobody waits for. Spread across the document rather
 * than taken from the front, because a conversion's damage is not evenly distributed — the
 * notes that break are the ones after the page breaks, and those are all at the end.
 */
const SAMPLE_SIZE = 12;

const spreadAcross = <T,>(values: readonly T[], count: number): T[] => {
  if (values.length <= count) return [...values];
  const step = values.length / count;
  return Array.from({ length: count }, (_, i) => values[Math.floor(i * step)]);
};

for (const document of DOCUMENTS) {
  const path = sample(document.file);
  const present = existsSync(path);

  describe(`${document.id}, as the pane reads it`, { skip: present ? false : `${document.file} is not in this checkout` }, () => {
    let word: WordStub | undefined;
    afterEach(() => { word?.remove(); word = undefined; });

    test('every footnote in the file reaches the pane', async () => {
      const notes = await notesFromDocx(path);
      assert.ok(notes.length > 0, 'the reader found no notes at all, so nothing below tests anything');
      word = installWordStub(notes);
      render(<App />);
      await screen.findByText(`${notes.length} footnote${notes.length === 1 ? '' : 's'} ready for review.`);
    });

    test('the citation it opens is the one in the footnote the cursor is on', async () => {
      const notes = await notesFromDocx(path);
      const contexts = getCitationContextsForFootnotes(notes);
      // Landing opens a citation by itself only where the footnote holds exactly one; where
      // it holds two the pane deliberately opens neither, so those say nothing here.
      const single = notes
        .map((_, index) => index)
        .filter((index) => contexts[index]?.length === 1);
      if (single.length === 0) return;

      word = installWordStub(notes);
      render(<App />);
      await screen.findByText(/footnotes? ready for review\./);

      for (const index of spreadAcross(single, SAMPLE_SIZE)) {
        word.putCursorOn(index);
        // An exact match, so a citation carrying a neighbouring footnote's identifier fails
        // here rather than passing on a shared prefix.
        await screen.findByText(contexts[index][0].value, { selector: '.selected-citation' });
      }
    });

    test('no footnote in the document knocks the pane over', async () => {
      const notes = await notesFromDocx(path);
      word = installWordStub(notes);
      render(<App />);
      await screen.findByText(/footnotes? ready for review\./);

      // Every kind of note in the file, not only the ones carrying a citation: the note that
      // breaks a pane is the one nothing was expected of, and a PDF conversion produces
      // plenty — bare page numbers, split sentences, a footnote holding one bracket.
      for (const index of spreadAcross(notes.map((_, i) => i), SAMPLE_SIZE * 2)) {
        word.putCursorOn(index);
      }
      word.putCursorOn(null);
      // Still answering, having been walked the length of the document.
      await waitFor(() => screen.getByText(/footnotes? ready for review\./));
    });
  });
}

/**
 * What the reader must not do to a document whose footnotes a conversion flattened.
 *
 * Counts rather than behaviours, because the failure these guard against was a silent one.
 * The pane listed 12 notes for a document holding 494, and 9 of the 12 were a footnote's
 * second line with the day of the month eaten off the front — `24 November 2011, EFIM v
 * Commission…` read as note 24 beginning at `November`. Nothing threw and nothing looked
 * wrong; a reviewer would have read a clean, nearly empty pane over a document nobody had
 * checked. A count is the only thing that catches that, so the counts are asserted here.
 */
describe('notes a conversion left in the body', () => {
  const notesOf = (file: string) => notesFromDocx(sample(file));
  const skipUnless = (file: string) =>
    existsSync(sample(file)) ? false : `${file} is not in this checkout`;

  const ABUSES = 'Guidelines_on_exclusionary_abuses_of_dominance_102TFEU.docx';
  const INTEL = 'EC Decision - Intel (2009).docx';

  test('a document whose footnotes all became body text still gives them up', {
    skip: skipUnless(ABUSES),
  }, async () => {
    // 494 in the PDF. Two fall under the floor that keeps headings out, and the numbering
    // restarts leave a handful merged, so the floor here is well clear of the 12 that the
    // numbering shape alone found and well under the count the file actually holds.
    const notes = await notesOf(ABUSES);
    assert.ok(notes.length > 450, `expected the notes of the whole document, got ${notes.length}`);
  });

  test('a note broken across a page is not listed as a note of its own', {
    skip: skipUnless(ABUSES),
  }, async () => {
    // The tail of such a note opens mid-sentence, and in a citation-heavy document that means
    // it opens on the rest of a date. If any note begins with a month, a tail was listed
    // rather than joined, and its first citation lost the day it was decided on.
    const notes = await notesOf(ABUSES);
    const orphans = notes.filter((note) => /^(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(note));
    assert.deepEqual(orphans, [], 'a footnote tail was read as a footnote');
  });

  test('joining a tail never swallows the document around it', {
    skip: skipUnless(INTEL),
  }, async () => {
    // The Intel decision sets long stretches of quoted submissions two points below its prose.
    // A note falling next to one of them once absorbed 14,000 characters of it, one paragraph
    // pulling in the next — which is a whole section of the decision presented as a footnote.
    const notes = await notesOf(INTEL);
    const longest = notes.reduce((worst, note) => Math.max(worst, note.length), 0);
    assert.ok(longest < 4000, `a note grew to ${longest} characters, so a join ran away`);
  });
});

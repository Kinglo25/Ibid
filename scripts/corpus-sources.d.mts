/**
 * Types for the corpus harness's document readers, which are plain ESM so the harness can
 * run with no build step.
 *
 * This file exists because the pane's own tests read real Word documents through
 * `notesFromDocx` rather than through fixtures typed out by hand. That is the whole point of
 * it: a hand-typed fixture is written by the same understanding that wrote the pane, and the
 * one bug that mattered most here — Word's reference mark surviving `trim` — was invisible
 * to every fixture in this repository until someone opened the file in Word. One reader,
 * used by both the corpus and the pane's tests, so the two cannot drift.
 */

/** Every note a .docx holds, in all three shapes a PDF conversion leaves them in. */
export function notesFromDocx(path: string): Promise<string[]>;

/** Footnotes from a CELLAR rendition, or `undefined` where the page is not the document. */
export function notesFromCellar(html: string): string[] | undefined;

/** Footnotes from the pre-Formex rendition, where nothing marks them but the numbering. */
export function notesFromLegacy(html: string): string[];

/** The ECLI a CELEX declares for itself in its RDF metadata. */
export function ecliOf(celex: string): Promise<string | undefined>;

export function fetchCellar(
  celex: string,
  options?: { accept?: string; languages?: readonly string[] },
): Promise<{ text: string; language: string; format: string } | undefined>;

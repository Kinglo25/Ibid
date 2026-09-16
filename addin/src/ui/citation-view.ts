import type { CitationCandidate, CitationContext } from '../../../shared/src';

/**
 * The presentation decisions the task pane makes about a citation, kept apart from the
 * component that renders them.
 *
 * These are the pane's judgement calls — how far a confirmation reaches, what a reviewer is
 * told about where a citation came from, how an unresolved one is explained — and each is a
 * plain function of one citation. Separating them from the JSX is what lets them be tested
 * by the repository's ordinary Node test runner, with no DOM and no React, rather than only
 * through a rendered component.
 */

export type ReviewFootnote = {
  id: string; number: number; text: string;
  /** A note the conversion left in the body text, which Word does not know is a footnote. */
  inBody?: boolean;
  /**
   * A citation the drafter put in the running text rather than in a note — the parenthetical
   * form ("(Case C-293/12, para. 40)"). It carries no number because the document gives it
   * none: it is a position in the prose, not an entry in a numbered series.
   */
  inText?: boolean;
};

/**
 * The document's footnotes, every one of them, in document order and numbered by position.
 *
 * Empty footnotes are kept rather than dropped, and that is the whole point. Resolution
 * numbers footnotes by their position in the array it is given, so removing one shifts
 * every footnote after it: `supra note 14` would read the fourteenth *non-empty* footnote
 * while the pane displayed true numbers beside each one, and the reviewer would be sent to
 * an authority the document never cited there. A back-reference is only as good as the
 * numbering it counts on.
 *
 * An empty footnote contributes no citations, so carrying it costs nothing. The list skips
 * them at the point of display instead, which is where they are merely noise.
 */
/**
 * Word's own reference mark, and anything else in the control range.
 *
 * `Footnote.body.text` opens with the mark that draws the note's number in the document —
 * `U+0002` for an auto-numbered footnote — and it is not whitespace, so `trim` leaves it
 * where it is. It cost far more than the stray glyph it drew in the pane.
 *
 * `Ibid.` is recognised only at the *start* of a footnote, because that is the only place
 * the word occurs in drafting (see `IBID_REFERENCE` in `shared/src/index.ts`). A control
 * character sitting in front of it defeats that anchor, so in a real Word document every
 * `Ibid.` and `Id.` silently stopped being a citation: detected as nothing at all, or — for
 * `Ibidem`, which is not in the not-a-case-name list — reported as a short form the document
 * never defines. Both were visible on screen as the pane simply failing to know what a
 * back-reference meant.
 *
 * Invisible to every test in this repository, because the fixtures are written by hand and
 * hand-written text has no reference marks in it. Found by opening
 * `samples/ibid-demo-docx/back-reference-test.docx` in Word and reading the pane.
 *
 * Replaced with a space rather than removed: a tab between the mark and the text is
 * ordinary, and joining words across a paragraph break would be worse than a space too many.
 */
// Matching control characters is the point here: Word's reference mark is one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function toReviewFootnotes(texts: readonly string[]): ReviewFootnote[] {
  return texts.map((text, index) => ({
    id: `footnote-${index + 1}`,
    number: index + 1,
    text: text.replace(CONTROL_CHARACTERS, ' ').trim(),
  }));
}

/**
 * Footnotes a PDF conversion left behind in the body text.
 *
 * Converting a decision from PDF does not always produce a Word footnote. On the large real
 * decision this was built against it produces 549 of them and leaves nine more as ordinary
 * body paragraphs, each opening with the number it had in the PDF, typed as superscript. Word has no footnote
 * there to report and `Body.footnotes` has none to return, so the pane's list cannot hold
 * them and nothing that matches text against that list can ever name one — while on the page
 * they look exactly like every other footnote, and hold exactly the citations a reviewer is
 * there to check.
 *
 * A superscript number is what distinguishes them, and body text does not carry formatting,
 * so the shape is read instead: a paragraph opening with a number and then a capital or a
 * quotation mark. The capital is what earns its keep. Conversions also break a note across a
 * page and leave the tail as its own paragraph — `15 seconds. The accelerated delivery…`,
 * `40 of that Regulation is to empower…` — and every one of those continues mid-sentence, in
 * lower case. On the decision this was built against the rule finds all nine notes and none
 * of the three fragments.
 */
/**
 * The shape of a note the conversion left in the body: its number, then a capital or an
 * opening quotation mark. Shared with `notesInBody` in the pane, which reads the same shape
 * off Word's paragraphs rather than off the body text, and must agree with this one.
 */
export const INLINE_NOTE_SHAPE = /^(\d{1,3})[ \t\u00a0]+([A-Z\u201c\u2018"'][\s\S]*)$/;
/** How Word separates paragraphs inside `Body.text`. */
const PARAGRAPH_BREAK = /[\r\n\v\f\u2028\u2029]/;

export function inlineFootnotesInBody(bodyText: string): ReviewFootnote[] {
  const notes: ReviewFootnote[] = [];
  for (const paragraph of bodyText.split(PARAGRAPH_BREAK)) {
    const match = INLINE_NOTE_SHAPE.exec(paragraph.trim());
    if (!match) continue;
    const [, number, text] = match;
    // Long enough to be a note rather than a stray numeral with a word after it, short
    // enough that a body paragraph opening with a figure is not swept up as one.
    if (text.length < INLINE_NOTE_FLOOR || text.length > INLINE_NOTE_CEILING) continue;
    notes.push({ id: `body-note-${notes.length + 1}`, number: Number(number), text, inBody: true });
  }
  return notes;
}

/**
 * The body's own prose \u2014 every paragraph `inlineFootnotesInBody` did not claim as a note.
 *
 * The two have to be read off the same text and told apart, or a note that also happens to
 * contain a parenthesis would be listed twice: once as the note it is, and once as a citation
 * in the running text. Kept beside the note reader for that reason, sharing its shape.
 */
export function bodyProseLines(bodyText: string): string[] {
  return bodyText.split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !INLINE_NOTE_SHAPE.test(paragraph));
}

export const INLINE_NOTE_FLOOR = 30;
export const INLINE_NOTE_CEILING = 2000;

/**
 * Citations a drafter wrote into the running text rather than into a note.
 *
 * Footnotes are where EU legal drafting puts its authorities, and everything else the pane
 * reads assumes it. But the parenthetical form is ordinary in prose \u2014 "the Court has held
 * otherwise (Case C-293/12, para. 40)" \u2014 and to Ibid those did not exist at all: `Body.text`
 * was read only to find notes a conversion had flattened into it, and a paragraph that is
 * genuinely prose was passed over. A reviewer checking such a document saw a clean pane.
 *
 * Only what is inside the parentheses is offered, and that bound is the whole of what keeps
 * this honest. Detection reaches outwards from a citation for its pinpoint and its case name,
 * so turning it loose on running prose would let a sentence supply a paragraph number to a
 * citation that never carried one \u2014 a wrong pinpoint shown with full confidence, which is the
 * failure this tool exists to prevent. A parenthesis is a boundary the drafter themselves
 * drew, and it is treated exactly as a footnote's text is: the same detection, the same
 * pinpoint rules, the same refusal to guess.
 *
 * Nothing here decides what is a citation \u2014 the spans are handed to the same detector the
 * footnotes go through, and a span holding no citation is dropped by the pane rather than
 * listed as an empty entry. So "(see below)" costs a scan and nothing else.
 */
export function parentheticalsInBody(paragraphs: readonly string[]): ReviewFootnote[] {
  const found: ReviewFootnote[] = [];
  for (const paragraph of paragraphs) {
    for (const span of parentheticalSpans(paragraph)) {
      if (span.length < PARENTHETICAL_FLOOR || span.length > PARENTHETICAL_CEILING) continue;
      // A reference mark or a recital number, not a citation. The guidelines on exclusionary
      // abuses write their footnote marks `(90)` and a conversion leaves every one of them
      // in the text; the Intel decision numbers its recitals `(48)`. Both are digits alone,
      // and both would otherwise be offered to the reviewer as something to inspect.
      if (!/[A-Za-z]/.test(span)) continue;
      found.push({ id: `in-text-${found.length + 1}`, number: 0, text: span, inText: true });
    }
  }
  return found;
}

/**
 * The parenthesised spans of one paragraph, each read to its own closing bracket.
 *
 * Depth is tracked rather than matching to the first `)`, because EU citations carry
 * parentheses of their own \u2014 "(Regulation (EU) 2016/679, Article 17(1))" is one span, and
 * cutting it at the first close would hand detection `Regulation (EU` and lose the act. An
 * opening bracket that never closes \u2014 ordinary in text a PDF conversion has been through \u2014
 * yields nothing, which is the safe direction to fail in.
 */
function parentheticalSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '(') {
      if (depth === 0) start = at + 1;
      depth += 1;
    } else if (text[at] === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(text.slice(start, at).trim());
    }
  }
  return spans;
}

// Short enough to admit "(C-293/12)", which is the whole citation in nine characters. Long
// enough that a parenthesis running to a paragraph of its own is prose being quoted, not a
// reference: past this the span stops being a boundary the drafter drew around an authority.
export const PARENTHETICAL_FLOOR = 8;
export const PARENTHETICAL_CEILING = 600;

export function citationKey(citation: CitationContext, footnoteId: string): string {
  return `${footnoteId}-${citation.index}-${citation.value}`;
}

/**
 * How far a confirmation reaches.
 *
 * A short form is a name, and a name means one thing throughout a document, so settling
 * "Akzo Nobel" once settles every later use of it — that is the whole point of confirming
 * it. A back-reference is positional: `Ibid.` means whatever precedes it, so two of them in
 * the same document are two different citations that merely happen to be spelled the same.
 * Keying those by their text would take one reviewer's decision about footnote 13 and apply
 * it, unasked and invisibly, to every other `Ibid.` in the document.
 */
export function confirmationKey(citation: CitationContext, footnoteId: string): string {
  return citation.backReference ? citationKey(citation, footnoteId) : citation.value.toLowerCase();
}

export function curiaSearchUrl(query: string): string {
  return `https://curia.europa.eu/juris/liste.jsf?language=en&num=${encodeURIComponent(query)}`;
}

export function officialSourceUrl(citation: CitationContext): string {
  // The CELEX names the document that was cited whatever kind it is — its sector is
  // derived from the document type — so an opinion links to the opinion, not to the
  // judgment in the same case.
  if (citation.celex) return `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${citation.celex}`;
  // The case's own page in DG Competition's register, not a search for its number — see the
  // note on `commissionUrl` in the resolver, which builds the same link and must agree.
  // A `C(yyyy) nnnn` decision number names an act rather than a case file and has no page
  // there, so it keeps the search.
  if (citation.source === 'commission') {
    const value = citation.value.replace(/^COMP\//i, '');
    return /^(?:AT|SA|M)\.\d{3,6}$/i.test(value)
      ? `https://competition-cases.ec.europa.eu/cases/${encodeURIComponent(value)}`
      : `https://competition-cases.ec.europa.eu/search?query=${encodeURIComponent(citation.value)}`;
  }
  // caseNumber, then ecli, then the literal matched text, in that preference order: a
  // shorthand reference resolved via a defined term (e.g. "Akzo Nobel, para. 45.") carries
  // its originating citation's caseNumber/ecli but its own `value` is just the short form,
  // which is not a usable CURIA search query on its own.
  return curiaSearchUrl(citation.caseNumber ?? citation.ecli ?? citation.value);
}

/**
 * What tells one option in the pick-list apart from another.
 *
 * CELEX first, because it is the only identifier here that names a *document* rather than a
 * case. The judgment, the order and the Advocate General's opinion in one case share a case
 * number, and where none of them carries an ECLI — which is usual for an order — keying on
 * the number gave two options the same key. React is explicit that it may then drop one of
 * them, so a reviewer asked to choose between the order and the judgment in T-457/08 could
 * be shown one option and never learn the other existed. Found by driving the pane through
 * the Intel decision in `real-documents.test.tsx`; no hand-written fixture cited a case
 * twice in two document types.
 */
export function candidateKey(candidate: CitationCandidate): string {
  if (candidate.celex) return candidate.celex;
  if (candidate.ecli) return candidate.ecli;
  if (candidate.caseNumber) {
    return candidate.documentType ? `${candidate.caseNumber}:${candidate.documentType}` : candidate.caseNumber;
  }
  return candidate.caseName ?? 'unknown';
}

/**
 * The judgment, the Advocate General's opinion, and the order in one case all share the
 * case name exactly, so a pick-list built on the name alone offers three identical-looking
 * options — the reviewer cannot tell which is which at the moment they are being asked to
 * choose. The document type is what separates them.
 */
export function candidateLabel(candidate: CitationCandidate): string {
  const name = candidate.caseName ?? candidate.caseNumber ?? candidate.label;
  return candidate.caseName && candidate.documentType ? `${name} (${candidate.documentType})` : name;
}

/**
 * Why this citation is showing what it is showing. A lawyer deciding how hard to check
 * something needs to know whether Ibid read it out of the document or inferred it, and
 * that distinction was previously only in the data, never on screen. Saying it plainly is
 * the alternative to making every citation a confirmation prompt: full transparency, no
 * forced click on the ones that are not in doubt.
 */
export function resolutionNote(citation: CitationContext): string {
  const footnote = citation.backReference?.footnote;
  switch (citation.resolutionMethod) {
    case 'user_confirmed': return citation.backReference
      ? 'Confirmed by you for this reference.'
      : 'Confirmed by you for this document.';
    case 'preceding_citation': return footnote
      ? `Read as the authority cited immediately before it, in footnote ${footnote}.`
      : 'Read as the authority cited immediately before it.';
    case 'numbered_footnote': return `Read from footnote ${footnote}, which this reference names.`;
    // Distinct from the two above on purpose: this one rests on a choice the reviewer made
    // about another footnote, not on anything the document states, and saying so is what
    // lets them see how far their own decision has carried.
    case 'confirmed_back_reference': return `Read from footnote ${footnote}, which you confirmed.`;
    case 'explicit_alias': return 'Resolved from the short form this document defines for it.';
    case 'generated_variant': return 'Inferred from a case name this document cites in full earlier.';
    // Currently unreachable: a frequent-case suggestion is never `resolved` until a
    // reviewer confirms it, at which point the method becomes 'user_confirmed'. Kept
    // because the alternative if that ever changes is the default below, which would tell
    // a lawyer the citation was stated in the footnote when it was not.
    case 'fallback_table': return "Suggested from Ibid's list of frequently cited cases — not from this document.";
    default: return 'Stated in this footnote.';
  }
}

/**
 * What an unresolved citation tells the reviewer. A back-reference needs its own wording:
 * nothing "defines" an `Ibid.`, and the useful thing to say is which footnote it points at,
 * so the reviewer knows where to look rather than being told the document is silent.
 */
export function unresolvedMessage(citation: CitationContext): string {
  const suggested = citation.candidates ?? [];
  const footnote = citation.backReference?.footnote;

  if (citation.status === 'unconfirmed_suggestion') {
    return `This document does not define "${citation.value}". Ibid recognises the name from its list of frequently cited cases — confirm before relying on it.`;
  }
  if (citation.backReference) {
    if (suggested.length) return `Footnote ${footnote} cites more than one authority, so "${citation.value}" does not say which of them is meant.`;
    return footnote
      ? `"${citation.value}" points back to footnote ${footnote}, which does not establish an authority to point at.`
      : `"${citation.value}" points back to an authority cited before it, but nothing before it establishes one.`;
  }
  return suggested.length
    ? `"${citation.value}" could refer to more than one authority, and this document does not say which.`
    : `"${citation.value}" reads like a reference to an authority, but nothing in this document defines it.`;
}

/**
 * Whether a footnote is one the reviewer still has to decide something about.
 *
 * This is what the list filters on. A brief with a hundred footnotes has a hundred entries
 * of which perhaps six need a person, and showing all hundred buries those six — the
 * reviewer's attention is the scarce resource, the same reason confirmation is not asked
 * for on every citation.
 */
export function needsReview(citations: readonly CitationContext[]): boolean {
  return citations.some((citation) => citation.status !== 'resolved');
}

/**
 * The citation to open automatically when the cursor lands on a footnote.
 *
 * Only where the footnote holds exactly one, because that is the only case with no choice
 * to make. A footnote citing two authorities gets neither opened: guessing which of them
 * the reviewer meant would put a source panel behind a decision they did not make, and the
 * two chips are right there to pick from.
 */
export function autoSelectable(citations: readonly CitationContext[]): CitationContext | undefined {
  return citations.length === 1 ? citations[0] : undefined;
}

/** English month names, so the note below reads the same wherever the pane is opened. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * When this passage was last confirmed to be what EUR-Lex holds.
 *
 * Written as a plain statement of fact, and deliberately not as a disclaimer. Ibid caches
 * retrieved documents and revalidates them on every use: CELLAR answers a conditional
 * request with `304` and no body, which is the issuing authority saying the text already in
 * hand is current. What that produces is not a copy with a caveat attached — it is the
 * official text with a timestamp on it, and the timestamp is the strongest thing this pane
 * can say about a passage a lawyer is about to rely on. Hedging it would understate what
 * was actually done.
 *
 * The date appears only when the confirmation was not today. That matters: a passage served
 * from a store written last week, with nothing left to revalidate it against, would
 * otherwise read as "at 14:32" and be taken for this afternoon.
 */
export function verificationNote(
  verifiedAt: string | undefined,
  now: Date = new Date(),
  about: { source?: string; checking?: boolean } = {},
): string | undefined {
  if (!verifiedAt) return undefined;
  const at = new Date(verifiedAt);
  if (Number.isNaN(at.getTime())) return undefined;

  // A Commission decision is confirmed against `ec.europa.eu`, not EUR-Lex, and naming the
  // wrong publisher is a false statement about where the text was checked.
  const against = about.source === 'European Commission' ? 'the Commission' : 'EUR-Lex';
  // Shown while a decision answered from what the server held waits for its confirmation.
  // The date before it is still the true one — the last time it was confirmed — so this
  // adds what is happening next rather than qualifying what was said.
  const checking = about.checking ? '; checking for changes' : '';

  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (at.toDateString() === now.toDateString()) return `Verified against ${against} at ${time}${checking}`;

  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `Verified against ${against} on ${at.getDate()} ${MONTHS[at.getMonth()]}${year} at ${time}${checking}`;
}

/**
 * Whether a confirmed answer shows something other than the answer it replaces.
 *
 * Compared on what the reviewer reads and follows — the passage, which decision it is from,
 * and what kind of passage it is — and never on `verifiedAt`, which a confirmation changes
 * every time. A `304` is the publisher saying nothing changed, and it must not be announced
 * as though something had.
 */
export function sourceChanged(
  before: readonly { url: string; excerpt: string; passage?: string }[],
  after: readonly { url: string; excerpt: string; passage?: string }[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some((document, at) => document.url !== after[at].url
    || document.excerpt !== after[at].excerpt
    || document.passage !== after[at].passage);
}

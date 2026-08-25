import { useEffect, useMemo, useRef, useState } from 'react';
import { citedAuthorities, getCitationContextsForFootnotes, reresolveBackReferences, PREVIEW_FOOTNOTES, type CitationCandidate, type CitationContext } from '../../../shared/src';
import { prefetchStatus, prefetchTargets, startPrefetch, type PrefetchProgress, type Prefetcher } from './prefetch';
import {
  candidateKey, candidateLabel, citationKey, confirmationKey, curiaSearchUrl,
  autoSelectable, inlineFootnotesInBody, INLINE_NOTE_FLOOR, needsReview, officialSourceUrl,
  resolutionNote, toReviewFootnotes,
  unresolvedMessage, verificationNote, type ReviewFootnote,
} from './citation-view';

type ReviewDocument = {
  title: string; excerpt: string; url: string; source: string;
  /** What the citation pinpointed, as the resolver labelled it: "Point 46", "Article 17(1)". */
  locator?: string;
  /** Whether the excerpt is that passage, the document's opening standing in for it, or the opening of a judgment the Court published only in part. */
  passage?: 'cited' | 'opening' | 'unpublished';
  language?: 'en' | 'fr';
  translation?: { from: 'en' | 'fr'; officialUrl: string };
  /** When the resolver last confirmed this text against EUR-Lex, as an ISO timestamp. */
  verifiedAt?: string;
};
type ReviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; documents: ReviewDocument[] }
  | { kind: 'empty' }
  | { kind: 'unresolved' }
  | { kind: 'error'; message: string };

// The preview document lives in `shared` so this and the `real citations` test suite use
// one array rather than two copies that can silently drift apart.
const sampleFootnotes: ReviewFootnote[] = toReviewFootnotes(PREVIEW_FOOTNOTES);

function isWordRuntimeAvailable(): boolean {
  return typeof Office !== 'undefined' && typeof Word !== 'undefined' && Boolean(Office.context?.document);
}

async function waitForWordRuntime(): Promise<boolean> {
  if (isWordRuntimeAvailable()) return true;
  if (typeof Office === 'undefined') return false;

  try {
    const info = await Office.onReady();
    return info.host === Office.HostType.Word && isWordRuntimeAvailable();
  } catch {
    return false;
  }
}

/**
 * Notes a conversion rebuilt as an auto-numbered list.
 *
 * The third shape this decision's footnotes arrive in, and the one nothing textual can find.
 * Fifty-three of them are body paragraphs carrying `<w:numPr>`, so Word draws the number
 * itself and the paragraph's own text begins at "Judgment of 31 May 2018, Groningen Seaports
 * v. Commission…" with no number in it anywhere. `Body.text` never sees a list label, so the
 * only way to read one is to ask Word for it.
 *
 * `listString` is what separates a note from a recital. Both are numbered lists here, but
 * the decision's recitals render as `(48)` and its converted footnotes as a bare `275` —
 * a difference in the numbering definition rather than in the text, which is why it survives
 * where every other distinction between the two has been flattened by the conversion.
 *
 * One extra read of the body's paragraphs, once per document, and guarded: a build without
 * `isListItem` returns nothing here rather than taking the whole document read down with it.
 */
async function numberedNotesInBody(
  context: Word.RequestContext,
  body: Word.Body,
): Promise<ReviewFootnote[]> {
  try {
    const paragraphs = body.paragraphs;
    paragraphs.load('items');
    await context.sync();
    paragraphs.items.forEach((paragraph) => {
      paragraph.load('text,isListItem');
      paragraph.listItemOrNullObject.load('listString');
    });
    await context.sync();

    const notes: ReviewFootnote[] = [];
    paragraphs.items.forEach((paragraph) => {
      if (!paragraph.isListItem) return;
      const label = String(paragraph.listItemOrNullObject?.listString ?? '').trim();
      if (!/^\d{1,3}$/.test(label)) return;
      const text = (paragraph.text ?? '').trim();
      if (text.length < INLINE_NOTE_FLOOR) return;
      notes.push({ id: `list-note-${notes.length + 1}`, number: Number(label), text, inBody: true });
    });
    return notes;
  } catch {
    return [];
  }
}

async function readWordDocument(): Promise<{ footnotes: ReviewFootnote[] }> {
  return Word.run(async (context) => {
    const body = context.document.body;
    const footnotes = body.footnotes;
    body.load('text');
    footnotes.load('items');
    await context.sync();
    footnotes.items.forEach((footnote) => footnote.body.load('text'));
    await context.sync();

    const numbered = await numberedNotesInBody(context, body);
    const bodyText = body.text.trim();
    return {
      footnotes: [
        // Every footnote, empties included: numbering is what back-references count on, and
        // dropping one here shifts every footnote after it. See `toReviewFootnotes`.
        ...toReviewFootnotes(footnotes.items.map((footnote) => footnote.body.text)),
        // Appended, never interleaved. Word's numbering is positional and back-references
        // count on it, so anything inserted among the real footnotes would send `supra note
        // 14` to a different authority than the document cited there. These sit past the end,
        // where they add themselves to the list without moving anything already in it.
        ...inlineFootnotesInBody(bodyText),
        // And the ones Word numbers itself, which no reading of the body text can find.
        ...numbered,
      ],
    };
  });
}

/**
 * Where the cursor is: which footnote, no footnote, or a footnote we could not name.
 *
 * Word gives an add-in no way to draw next to the text — the document canvas is Word's, and
 * a dialog opens centred on the screen rather than beside what it explains. So "show me the
 * source for the citation I am looking at" cannot be a popup at the citation; it has to be
 * the pane following the cursor. This is the part that makes that work.
 *
 * Three routes, tried in order, because there are several places a reviewer might click and
 * the obvious one is not the reliable one:
 *
 *  - the reference mark in the body text, where the selection *contains* the footnote and
 *    `Range.footnotes` reports it directly;
 *  - the cursor inside the footnote's own text at the foot of the page, where the selection's
 *    parent body *is* that footnote's body, matched against the footnote texts already read;
 *  - failing both, whatever text is actually selected, matched as a substring of a footnote.
 *    This is the one that rescues a real selection when the parent body is not what the API
 *    was expected to return, which varies by Word build and by how the document was made.
 *
 * Matching on text rather than comparing ranges is deliberate: `compareLocationWith` against
 * every footnote would be hundreds of queued operations on every cursor move, and the texts
 * are already in hand.
 *
 * The distinction that matters is the last one returned. A cursor in ordinary body text and
 * a cursor in a footnote nobody could identify are the same empty answer to a text match,
 * and treating them alike is what let the pane keep a source panel on screen describing the
 * footnote *before* the one being read — indistinguishable, to the reviewer, from a correct
 * answer. `Body.type` separates them, so the second case can be admitted rather than hidden.
 *
 * Every step is guarded. This runs on every cursor movement, against API surface that varies
 * by Word build, and a failure here must never take the pane down with it.
 */
export type CursorLocation =
  | { kind: 'footnotes'; indexes: number[] }
  /**
   * `selection` is text the reviewer deliberately selected that belongs to no footnote the
   * pane holds — still a passage, and possibly still a citation. See `stray` in the pane.
   */
  | { kind: 'unidentified'; selection?: string }
  | { kind: 'outside'; selection?: string };

const FOOTNOTE_BODIES = ['Footnote', 'Endnote', 'NoteItem'];
// Bodies whose text is the document, or most of it. Reading one costs seconds on a 199-page
// decision and can never equal a footnote, so no route below asks for their text. `Section`
// is here because a real Word build reports the parent of a footnote selection as the
// section: without it, the very cursor position this function had to be fixed for would
// also have been the one that marshalled the whole section across the bridge.
const LARGE_BODIES = ['MainDoc', 'Section'];
// Below this a selection is too short to pin down a footnote by its text alone.
const SUBSTRING_FLOOR = 12;
// A footnote the cursor is in may be one paragraph, or several in a decision converted from
// PDF. Past this the selection is a stretch of the document rather than a note, and loading
// every paragraph of it is the cost this whole function was rewritten to stop paying.
const PARAGRAPH_CEILING = 12;
// Reading a footnote out of a selection that *contains* it is the riskier direction: this
// document has 148 footnotes whose text is a duplicate of another's, and a short one such as
// `Ibid.` sits inside almost any long passage. That direction therefore demands a footnote
// long enough to be its own evidence.
const CONTAINED_FLOOR = 40;
// Below this a selection is a word or a phrase, not a passage worth reading citations out
// of on its own. A full citation runs to a hundred characters or more.
const PASSAGE_FLOOR = 24;

/**
 * One spelling for text that has to be compared across two different Word APIs.
 *
 * A decision converted from a PDF carries characters that survive the conversion but have no
 * width on the page: soft hyphens left behind by justified line-breaking, zero-width joiners,
 * compatibility forms of quotes and spaces. Word can hand back a footnote's body text and a
 * selection inside that same footnote with those in different places, and then two strings
 * that look identical do not compare equal. NFKC folds the compatibility forms together, the
 * character class drops what has no width at all, and collapsing whitespace makes the tab
 * runs between a footnote's citations count as one space.
 */
function normaliseText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The form two Word APIs can be compared in.
 *
 * Every route in `readCursorLocation` that has ever worked compares a *body's* text to a
 * body's text: `known` is read from `Footnote.body`, and the parent-body route reads a body
 * again. A selection is a `Range`, and Word does not guarantee that a range and the body
 * around it spell the same content the same way — a footnote's auto-numbering mark, a
 * hyperlinked ECLI, a non-breaking hyphen holding `C-97/08` together across a line break.
 * The one route that must work when Word calls the parent a section is the only one making
 * that cross-API comparison, and it was failing on 122 characters that were plainly, to the
 * reviewer looking at them, the footnote's own opening words.
 *
 * So comparison happens on letters, digits and single spaces alone. Punctuation carries none
 * of the identity of a citation — `EU:C:2009:536` is the same citation however Word chose to
 * hand back its colons — and dropping it costs nothing at the lengths the floors below
 * demand.
 */
function comparisonKey(value: string): string {
  return normaliseText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Which known footnote a piece of text belongs to, in either direction.
 *
 * A caret inside a footnote yields text that the footnote contains. A selection dragged
 * across one yields text that contains the footnote instead — and Word reports the parent of
 * such a selection as the section rather than the footnote, so this containing direction is
 * the only thing left that can name it. Where several footnotes are contained, the longest
 * wins: it is the one the selection is about, and the short notes it also swallowed are
 * incidental to it.
 */
function findFootnote(keys: readonly string[], text: string): number {
  const key = comparisonKey(text);
  if (key.length < SUBSTRING_FLOOR) return -1;
  const inside = keys.findIndex((candidate) => candidate.includes(key));
  if (inside >= 0) return inside;
  let longest = -1;
  keys.forEach((candidate, index) => {
    if (candidate.length < CONTAINED_FLOOR || !key.includes(candidate)) return;
    if (longest < 0 || candidate.length > keys[longest].length) longest = index;
  });
  return longest;
}

/** A footnote read back from Word, matched to the list the pane already holds. */
function identify(known: readonly string[], keys: readonly string[], text: string): number {
  const exact = known.indexOf(normaliseText(text));
  return exact >= 0 ? exact : findFootnote(keys, text);
}

async function readCursorLocation(knownTexts: readonly string[]): Promise<CursorLocation> {
  const known = knownTexts.map(normaliseText);
  const keys = known.map(comparisonKey);

  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    const contained = selection.footnotes;
    contained.load('items');
    selection.load('text');
    const parent = selection.parentBody;
    // Type now, text only if it turns out to be worth having. See below.
    parent.load('type');
    await context.sync();

    // The reference mark, or a stretch of body text covering several of them.
    if (contained.items.length) {
      contained.items.forEach((footnote) => footnote.body.load('text'));
      await context.sync();
      const hits = contained.items
        .map((footnote) => identify(known, keys, footnote.body.text))
        .filter((index) => index >= 0);
      if (hits.length) return { kind: 'footnotes' as const, indexes: hits };
    }

    // The parent body's own text — but never the document's or a section's. With the cursor
    // on a reference mark the parent *is* the document, so loading its text marshals every
    // word of a 199-page decision across the bridge, on every cursor movement, before
    // anything has been matched: seconds of waiting for a string that could never equal a
    // footnote. Any other body is small enough to be worth reading, and an unrecognised type
    // is read as before rather than skipped, since the cost of being wrong there is a match
    // missed.
    const parentType = String(parent.type ?? '');
    if (!LARGE_BODIES.includes(parentType)) {
      parent.load('text');
      await context.sync();
      const parentText = normaliseText(parent.text ?? '');
      const exact = parentText ? identify(known, keys, parentText) : -1;
      if (exact >= 0) return { kind: 'footnotes' as const, indexes: [exact] };
    }

    // What is actually selected. Survives a parent body that is a paragraph, a section or
    // the main document body rather than the footnote itself.
    const selectedText = normaliseText(selection.text ?? '');
    const selected = findFootnote(keys, selectedText);
    if (selected >= 0) return { kind: 'footnotes' as const, indexes: [selected] };

    // The paragraphs the caret actually sits in.
    //
    // `parentBody` is what ought to identify a footnote, and in at least one real Word build
    // it does not: a caret inside a long footnote of a converted decision was reported as
    // sitting in a section. A paragraph is a smaller, more local claim — whatever container
    // the conversion left around it, the paragraph's own text is still part of the
    // footnote's. The longest goes first, because a selection's outermost paragraphs are the
    // ones a drag is most likely to have cut in half. This runs only once every route above
    // has failed, so its two round trips are paid on the way to an answer the pane would
    // otherwise not have.
    const paragraphs = selection.paragraphs;
    paragraphs.load('items');
    await context.sync();
    if (paragraphs.items.length && paragraphs.items.length <= PARAGRAPH_CEILING) {
      paragraphs.items.forEach((paragraph) => paragraph.load('text'));
      await context.sync();
      const texts = paragraphs.items
        .map((paragraph) => normaliseText(paragraph.text ?? ''))
        .sort((a, b) => b.length - a.length);
      for (const text of texts) {
        const containing = findFootnote(keys, text);
        if (containing >= 0) return { kind: 'footnotes' as const, indexes: [containing] };
      }
    }

    // Nothing matched. Whether that is worth telling the reviewer depends entirely on
    // whether they were in a footnote at all.
    const inFootnote = FOOTNOTE_BODIES.includes(parentType);
    // Only a deliberate selection, never a bare caret. Reading every body paragraph the
    // cursor passes through would replace the source a reviewer is working from at the first
    // click into the text; asking for what they selected is something they did on purpose.
    const passage = selectedText.length >= PASSAGE_FLOOR ? selectedText : undefined;
    return inFootnote
      ? { kind: 'unidentified' as const, selection: passage }
      : { kind: 'outside' as const, selection: passage };
  });
}

/**
 * Exactly what is put on the wire, and nothing else.
 *
 * The nine fields are named one by one rather than spread from the citation, and this is
 * the only place they are named. The object in hand is a `CitationContext`, which carries
 * `context` — the prose surrounding the citation — so spreading it would put the document's
 * own text on the wire; naming the fields means a developer adding a field to the citation
 * type cannot cause it to start crossing the wire by accident. See `docs/DATA-FLOW.md`.
 *
 * One function rather than one expression because there are now two callers — a reviewer
 * selecting a citation, and the background warming that starts at document open — and the
 * guarantee is stronger for their sharing it than it would be for each spelling the fields
 * out again.
 */
function lookupFor(citation: CitationContext) {
  return {
    source: citation.source, value: citation.value, celex: citation.celex, ecli: citation.ecli,
    // The other numbers a joined judgment may be filed under. Identifiers the document
    // itself stated, never anything read out of it — see `docs/DATA-FLOW.md`.
    alternativeCelexes: citation.alternativeCelexes,
    caseNumber: citation.caseNumber, caseName: citation.caseName,
    documentType: citation.documentType, locator: citation.locator,
    // Every paragraph the footnote names, not just the one retrieval anchors on: a citation
    // to "paras 62 and 65" is a citation to both, and the resolver cannot know that from the
    // locator alone.
    paragraphs: citation.pinpoint?.paragraphs,
  };
}

/**
 * A retrieval failure carrying a sentence a reviewer can act on.
 *
 * Only messages written here are ever put on screen. `fetch` rejects with a `TypeError`
 * reading "Failed to fetch" when the server is unreachable — which is exactly the failure a
 * hosted deployment produces when its API is down, and exactly the wrong thing to show a
 * lawyer. Locally the Vite proxy hides that behind a `500`, so the raw browser message is a
 * production-only path and would not have been seen in dev.
 */
class RetrievalError extends Error {}

const RETRIEVAL_FAILED = 'The source could not be retrieved. Open the official record below.';

async function resolveSource(citation: CitationContext, signal?: AbortSignal): Promise<ReviewDocument[]> {
  // `import.meta.env` is Vite's, and exists only in a Vite-built bundle. Reaching through
  // it unguarded threw a TypeError under every other runtime — which meant the task-pane
  // tests never reached `fetch` at all, and every retrieval state below was silently
  // untested. Optional-chaining here costs nothing in the browser and makes the pane
  // runnable wherever it is imported.
  const apiBase = import.meta.env?.VITE_IBID_API_BASE_URL?.replace(/\/$/, '') ?? '/api';
  const response = await fetch(`${apiBase}/sources?lookup=${encodeURIComponent(JSON.stringify(lookupFor(citation)))}`, { signal });
  if (!response.ok) throw new RetrievalError(`The source could not be retrieved (${response.status}). Open the official record below.`);
  const payload = await response.json() as { documents?: ReviewDocument[] };
  return payload.documents ?? [];
}

/**
 * Says so when the passage above is not the authentic text.
 *
 * A translation is not the authority, and a lawyer arguing from a paragraph has to know
 * whether the words in front of them are the Court's or a machine's. So a translated
 * passage is labelled and the official version is one click away; a French passage shown
 * untranslated is labelled too, because a reader expecting English should be told why they
 * did not get it rather than left to work it out. Where the excerpt is the published
 * English text this renders nothing at all — that is the case that needs no explaining.
 */
function SourceLanguageNote({ document }: { document: ReviewDocument }) {
  if (document.translation) {
    return <p className="source-note">
      Translated from the official {document.translation.from === 'fr' ? 'French' : 'English'};
      this is not the authentic text.{' '}
      <a href={document.translation.officialUrl} target="_blank" rel="noreferrer">Open the official version</a>
    </p>;
  }
  if (document.language && document.language !== 'en') {
    return <p className="source-note">Published only in French. Shown in the official language.</p>;
  }
  return null;
}

/**
 * When this passage was last confirmed against EUR-Lex.
 *
 * Shown on every retrieved passage, and phrased as a fact rather than as a warning. Ibid
 * keeps documents it has retrieved and revalidates each one on use — CELLAR answers a
 * conditional request with `304` and no body, which is the Publications Office confirming
 * that the text already in hand is the current one. So a lawyer reading this is not reading
 * a copy that might be stale; they are reading the official text, with the time it was last
 * checked printed underneath it. That is worth stating plainly and worth not hedging.
 */
function VerificationNote({ document }: { document: ReviewDocument }) {
  const note = verificationNote(document.verifiedAt);
  return note ? <p className="source-verified">{note}</p> : null;
}

/**
 * Says so when the passage below is not the paragraph that was cited.
 *
 * The retrieved document is the right one; the pinpoint inside it could not be found, and
 * what is shown instead is the document's opening — for a judgment, the parties and the
 * catchwords. That is worth showing, and it is not what the footnote pointed at. Left
 * unlabelled it reads as the answer: a lawyer checking "paragraph 46" sees a passage under
 * a citation naming paragraph 46 and has no reason to doubt it, which is a worse position
 * than being shown nothing. The official-source link below it is then the way to the
 * paragraph itself.
 */
function ExcerptScopeNote({ document }: { document: ReviewDocument }) {
  const what = document.locator ?? 'The cited passage';
  // The Court published this judgment in extract, and the cited paragraph is one it kept
  // back. Said differently from an ordinary miss on purpose: "could not be located" invites
  // the reader to suspect the tool and look again, and here there is nothing to find. The
  // document in hand is complete, correct, and the official text — it is simply not all of
  // the judgment, and only the Court decides that.
  if (document.passage === 'unpublished') return <p className="source-note">
    {what} is not in the published text: the Court published only part of this judgment.
    Below is the opening of what it did publish.
  </p>;
  if (document.passage !== 'opening') return null;
  return <p className="source-note">
    {what} could not be located in the retrieved text — this is
    the opening of the document, not the passage cited.
  </p>;
}

/**
 * A citation Ibid will not resolve on its own. It never picks the likeliest candidate,
 * because a wrong citation shown with full confidence is worse for the reviewer than a
 * flagged gap — but declining to guess must not leave the reviewer stuck, so this is where
 * they decide. An ambiguous span offers its candidates; a span with no candidates at all
 * offers every authority the document itself establishes. Confirming a short form applies
 * for the whole document; confirming a back-reference applies to that one reference, since
 * the next `Ibid.` means whatever precedes *it* — see `confirmationKey`.
 */
function UnresolvedReview({ citation, authorities, onConfirm }: {
  citation: CitationContext;
  authorities: CitationCandidate[];
  onConfirm: (candidate: CitationCandidate) => void;
}) {
  const suggested = citation.candidates ?? [];
  const options = suggested.length ? suggested : authorities;
  const message = unresolvedMessage(citation);

  return <div className="unresolved-review">
    <p className="error">{message}</p>
    {options.length > 0 ? <>
      <p className="context-label">{suggested.length ? 'Confirm which one is meant' : 'Or pick an authority cited elsewhere in this document'}</p>
      <ul className="candidate-list">
        {options.map((candidate) => <li key={candidateKey(candidate)}>
          <button type="button" className="candidate-confirm" onClick={() => onConfirm(candidate)}>
            Use this
          </button>
          <span className="candidate-name">{candidateLabel(candidate)}</span>
          <span className="muted"> {[candidate.caseNumber, candidate.ecli, candidate.caseName ? undefined : candidate.celex].filter(Boolean).join(' · ')}</span>
          <a className="candidate-check" href={curiaSearchUrl(candidate.caseNumber ?? candidate.ecli ?? candidate.caseName ?? '')} target="_blank" rel="noreferrer">check</a>
        </li>)}
      </ul>
    </> : <p className="muted">This document does not establish any authority this could refer to. Cite it in full once, then refresh.</p>}
  </div>;
}

export default function App() {
  const [footnotes, setFootnotes] = useState<ReviewFootnote[]>([]);
  const [status, setStatus] = useState('Loading source material…');
  const [selected, setSelected] = useState<{ citation: CitationContext; footnote: ReviewFootnote } | null>(null);
  const [review, setReview] = useState<ReviewState>({ kind: 'idle' });
  // Which footnote the cursor is in, when Word is telling us. Null in the browser preview
  // and whenever the cursor is somewhere that is not a footnote.
  const [focused, setFocused] = useState<number | null>(null);
  // The cursor is in a footnote Ibid could not identify. Distinct from `focused === null`,
  // which is the ordinary case of a cursor somewhere that is not a footnote at all.
  const [unidentified, setUnidentified] = useState(false);
  /**
   * Text the reviewer selected that belongs to no footnote the pane holds.
   *
   * On a decision converted from PDF this is not a rare corner. The conversion of the real
   * decision leaves some footnotes inline in the body: Word reports the parent body as the
   * section, reports no reference mark, and the pane's list — 549 footnotes, none empty —
   * simply has no entry whose text is the passage on screen, because Word does not consider
   * it a footnote. The reviewer is nonetheless looking straight at a citation and asking
   * what it is. Reading it out of what they selected needs no footnote to exist.
   */
  const [stray, setStray] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  // Whether Word answered at all. Distinct from `following`, which is whether the selection
  // handler registered: the pane can be in Word and not be following it.
  const [wordReady, setWordReady] = useState(false);
  // A hundred footnotes of which six need a decision: showing all hundred buries the six.
  const [showAll, setShowAll] = useState(false);
  // Keyed by the short form itself, so confirming "Intel" once settles every "Intel" in the
  // document rather than asking again at each footnote. Deliberately not persisted: a
  // confirmation is a judgement about this document, and silently carrying it into the next
  // one would be exactly the kind of unexamined reuse this whole design avoids.
  const [confirmations, setConfirmations] = useState<Record<string, CitationCandidate>>({});
  /**
   * How far the background warming has got, for the pane to say plainly.
   *
   * Null before it starts and after a document with nothing to warm — the reviewer is told
   * about work that is happening, not reassured about work that is not.
   */
  const [prefetching, setPrefetching] = useState<PrefetchProgress | null>(null);

  const refresh = async () => {
    setStatus('Connecting to Word…');
    const runtimeAvailable = await waitForWordRuntime();
    if (!runtimeAvailable) {
      setFootnotes(sampleFootnotes);
      setStatus('Browser preview: sample footnotes are shown. Open Ibid in Word to review your document.');
      return;
    }

    setWordReady(true);
    setStatus('Reading the document and its footnotes…');
    try {
      const next = await readWordDocument();
      setFootnotes(next.footnotes);
      setStatus(next.footnotes.length
        ? `${next.footnotes.length} footnote${next.footnotes.length === 1 ? '' : 's'} ready for review.`
        : 'No footnotes found in this document.');
    } catch {
      setStatus('Ibid could not read this document. Confirm that Word supports the WordApi 1.5 requirement set.');
    }
  };

  /**
   * Retrieve a citation's source, or hand back what warming already retrieved for it.
   *
   * Keyed on the exact request that would be sent, so only a citation asking for precisely
   * the same passage is served from here. A different pinpoint of the same judgment misses
   * this and goes to the API — where the document itself is cached, so what it costs is one
   * conditional request rather than another download.
   */
  const alreadyRetrieved = (citation: CitationContext) => retrieved.current.get(JSON.stringify(lookupFor(citation)));

  const retrieve = async (citation: CitationContext): Promise<ReviewDocument[]> => {
    const held = alreadyRetrieved(citation);
    if (held) return held;
    const documents = await resolveSource(citation);
    retrieved.current.set(JSON.stringify(lookupFor(citation)), documents);
    return documents;
  };

  const selectCitation = async (citation: CitationContext, footnote: ReviewFootnote) => {
    setSelected({ citation, footnote });
    // A short form Ibid could not tie to a specific authority has nothing to look up.
    // Attempting a lookup anyway would either fail or, worse, retrieve whichever
    // candidate happened to be guessed — the reviewer confirms which case is meant first.
    if (citation.status !== 'resolved') {
      setReview({ kind: 'unresolved' });
      return;
    }
    // Already in hand from the background warming: showing a loading state for something
    // that is going to appear in the same tick is a flicker, not information.
    const held = alreadyRetrieved(citation);
    if (held) {
      setReview(held.length ? { kind: 'success', documents: held } : { kind: 'empty' });
      return;
    }
    setReview({ kind: 'loading' });
    try {
      const documents = await retrieve(citation);
      setReview(documents.length ? { kind: 'success', documents } : { kind: 'empty' });
    } catch (error) {
      setReview({ kind: 'error', message: error instanceof RetrievalError ? error.message : RETRIEVAL_FAILED });
    }
  };

  const confirmCitation = async (candidate: CitationCandidate) => {
    if (!selected) return;
    setConfirmations((current) => ({ ...current, [confirmationKey(selected.citation, selected.footnote.id)]: candidate }));
    const confirmed: CitationContext = {
      ...selected.citation, ...candidate, status: 'resolved', resolutionMethod: 'user_confirmed', candidates: undefined,
    };
    setSelected({ citation: confirmed, footnote: selected.footnote });
    setReview({ kind: 'loading' });
    try {
      const documents = await retrieve(confirmed);
      setReview(documents.length ? { kind: 'success', documents } : { kind: 'empty' });
    } catch (error) {
      setReview({ kind: 'error', message: error instanceof RetrievalError ? error.message : RETRIEVAL_FAILED });
    }
  };

  useEffect(() => { void refresh(); }, []);

  // The footnote texts a selection is matched against, and the read that answers one. Both
  // live in refs so that re-reading the document leaves the Office handler alone.
  const footnoteTexts = useRef<readonly string[]>([]);
  const readLocation = useRef<() => void>(() => undefined);
  /**
   * Sources already retrieved for the document currently open, keyed by the exact request
   * that fetched them. Emptied whenever the document is re-read: a preview belongs to the
   * document it was retrieved for, and carrying one into another would be the same
   * unexamined reuse that confirmations are deliberately not persisted across.
   */
  const retrieved = useRef(new Map<string, ReviewDocument[]>());
  /** The running queue, so the cursor can reorder what it has not reached yet. */
  const warming = useRef<Prefetcher | null>(null);
  /**
   * The citations as currently resolved, for the warming queue to be built from. Read
   * through a ref so that a confirmation — which changes `citationsByFootnote` — does not
   * cancel and restart a queue that is halfway through the document. Confirming a citation
   * retrieves its own source there and then, so nothing is left unwarmed by this.
   */
  const currentCitations = useRef<readonly (readonly CitationContext[])[]>([]);

  useEffect(() => {
    footnoteTexts.current = footnotes.map((footnote) => footnote.text);
    // The document arriving is itself a reason to answer: the handler registers before there
    // is anything to match a selection against, and the cursor is somewhere even then.
    readLocation.current();
  }, [footnotes]);

  /**
   * Follow the cursor, on one handler, for as long as the pane is mounted.
   *
   * Registering a handler and removing one are both asynchronous and neither is awaited, so
   * re-running this effect queues a removal and a registration whose order Office decides.
   * A removal landing last takes the live handler with it, and the pane then answers only
   * the direct call made at registration: it agrees with the reviewer's first click and
   * describes that footnote forever after. Frozen, with nothing on screen to say so.
   *
   * Nothing about following a cursor needs re-registration. What forced it was keying this
   * on `footnotes`, which is a fresh array every time the document is read — twice at
   * startup, since StrictMode double-invokes the mount effect, and once more for every hot
   * update while the pane is open. The texts are read from a ref instead, so one handler
   * serves whatever the document currently holds.
   */
  useEffect(() => {
    if (!wordReady || !isWordRuntimeAvailable()) return;
    let cancelled = false;

    const onSelectionChanged = () => {
      const texts = footnoteTexts.current;
      // Registered ahead of the document being read; the effect above calls back when it lands.
      if (!texts.length) return;
      void readCursorLocation(texts)
        .then((location) => {
          if (cancelled) return;
          setFocused(location.kind === 'footnotes' ? location.indexes[0] : null);
          setUnidentified(location.kind === 'unidentified');
          setStray(location.kind === 'footnotes' ? null : location.selection ?? null);
        })
        // Silent by design: this fires on every cursor movement, so a failure must not
        // produce an error the reviewer has to dismiss over and over. The list still works.
        .catch(() => undefined);
    };
    readLocation.current = onSelectionChanged;

    try {
      Office.context.document.addHandlerAsync(
        Office.EventType.DocumentSelectionChanged,
        onSelectionChanged,
        (result) => { if (!cancelled) setFollowing(result.status === Office.AsyncResultStatus.Succeeded); },
      );
    } catch { setFollowing(false); }

    onSelectionChanged();
    return () => {
      cancelled = true;
      readLocation.current = () => undefined;
      try {
        Office.context.document.removeHandlerAsync(Office.EventType.DocumentSelectionChanged, { handler: onSelectionChanged });
      } catch { /* the pane is closing; nothing useful remains to do */ }
    };
  }, [wordReady]);

  // Computed once for the whole document, in footnote order, so a short form defined in
  // one footnote (e.g. `ECLI:EU:C:2010:512 ("Akzo Nobel")`) is recognised in a later one
  // that only uses the short form ("Akzo Nobel, para. 45.") — see
  // detectCitationsAcrossFootnotes. Per-footnote detection alone cannot do this, since it
  // has no memory of what was cited earlier in the document.
  const detected = useMemo(
    () => getCitationContextsForFootnotes(footnotes.map((footnote) => footnote.text)),
    [footnotes],
  );

  // Confirmations are applied on top of detection rather than fed back into it, so the
  // reviewer's choices never change how the document itself is read — refreshing re-derives
  // the same citations, and only what a person explicitly settled is layered over them.
  const citationsByFootnote = useMemo(
    // Two layers, in this order. First the reviewer's explicit choices; then the
    // back-references those choices settle indirectly, since confirming the footnote an
    // `Ibid.` points at answers that `Ibid.` too — see `reresolveBackReferences`.
    () => reresolveBackReferences(detected.map((citations, index) => citations.map((citation) => {
      if (citation.status === 'resolved') return citation;
      const confirmed = confirmations[confirmationKey(citation, footnotes[index].id)];
      return confirmed ? { ...citation, ...confirmed, status: 'resolved' as const, resolutionMethod: 'user_confirmed' as const, candidates: undefined } : citation;
    }))),
    [detected, confirmations, footnotes],
  );
  currentCitations.current = citationsByFootnote;

  /**
   * Warm the cache for every authority the document cites, starting at open.
   *
   * The pane has the whole list before the reviewer clicks anything — detection and
   * short-form resolution run over the document locally at open — so waiting for a click
   * before asking EUR-Lex for any of it means every first inspection pays a cold
   * retrieval while the reviewer watches. This starts that work earlier. It does not make
   * it faster: the resolver's request spacing is unchanged, the requests go one at a time,
   * and nothing here is parallelised, because a burst of concurrent fetches is precisely
   * the fingerprint anti-bot protection reacts to.
   *
   * Keyed on `detected`, which is the document as read, so it starts once per document and
   * is cancelled when the document changes or the pane closes. It is deliberately *not*
   * keyed on `citationsByFootnote`: that changes on every confirmation, and restarting a
   * queue halfway through a hundred-footnote brief because the reviewer settled one short
   * form would undo the work it had just done.
   *
   * Only where there is a document. The browser preview shows a fixed sample memo to
   * demonstrate the pane, and firing a queue of live EUR-Lex retrievals at whoever opens
   * that page is not what the sample is for — its citations are real, so those would be
   * real requests to a public service on behalf of someone who is only looking.
   */
  useEffect(() => {
    retrieved.current = new Map();
    setPrefetching(null);
    if (!wordReady) return;
    const targets = prefetchTargets(currentCitations.current);
    if (!targets.length) return;

    const queue = startPrefetch({
      targets,
      retrieve: async (target, signal) => {
        const documents = await resolveSource(target.citation, signal);
        retrieved.current.set(JSON.stringify(lookupFor(target.citation)), documents);
      },
      onProgress: setPrefetching,
    });
    warming.current = queue;
    return () => {
      warming.current = null;
      queue.cancel();
    };
  }, [detected, wordReady]);

  /**
   * The cursor is the best statement of what the reviewer is about to want, so whatever the
   * footnote under it cites goes to the front of the queue. Reading order is only a guess at
   * the same question, and it loses the moment there is a better one.
   */
  useEffect(() => {
    if (focused !== null) warming.current?.promote(focused);
  }, [focused]);

  /**
   * The selected passage, shaped like a footnote so everything downstream can treat it as
   * one. `number` is 0 because it has none — Word does not know it is a footnote, and the
   * pane must not invent a number for it that the reviewer could go looking for.
   *
   * Its citations are detected from the passage alone, not across the document, so a short
   * form defined in some earlier footnote will not resolve here. That is the honest limit:
   * the passage is not in the document's footnote sequence, so there is no position from
   * which "the case cited above" means anything.
   */
  const strayFootnote = useMemo<ReviewFootnote | null>(
    () => (stray ? { id: 'selection', number: 0, text: stray } : null),
    [stray],
  );
  const strayCitations = useMemo(
    () => (stray ? getCitationContextsForFootnotes([stray])[0] ?? [] : []),
    [stray],
  );

  const authorities = useMemo(() => citedAuthorities(detected), [detected]);

  // Landing on a footnote opens its source, but only where there is no choice to make —
  // see `autoSelectable`. Keyed on the footnote so moving the cursor within one footnote
  // does not reopen what the reviewer may have just navigated away from.
  useEffect(() => {
    // No footnote to name, but a passage the reviewer selected on purpose. Answering from it
    // is the only thing that works where the conversion left a footnote's text in the body:
    // there is no footnote for Word to report or for the pane to match, and the citation is
    // on screen regardless.
    if (focused === null && strayFootnote) {
      const citation = autoSelectable(strayCitations);
      if (citation) { void selectCitation(citation, strayFootnote); return; }
      // Several citations in the selection, or none. Nothing opens by itself, and whatever
      // stands on screen belongs to somewhere the reviewer has since left.
      setSelected((current) => (current && current.footnote.text !== strayFootnote.text ? null : current));
      return;
    }
    // In a footnote, but not one we can name. Holding the previous footnote's source on
    // screen here is the failure the reviewer cannot see: it looks like an answer.
    if (unidentified) { setSelected(null); return; }
    if (focused === null) return;
    const footnote = footnotes[focused];
    const citation = autoSelectable(citationsByFootnote[focused] ?? []);
    if (footnote && citation) { void selectCitation(citation, footnote); return; }
    // Nothing opened by itself, so whatever is on display belongs to a footnote the cursor
    // has left. With the index collapsed the source panel is the only thing on screen, and
    // leaving it there would have it describing a footnote the reviewer moved away from.
    // A cursor outside every footnote is left alone deliberately: reading through the body
    // text would otherwise blank the source being worked from at the first click.
    setSelected((current) => (current && footnote && current.footnote.id !== footnote.id ? null : current));
    // Deliberately keyed on the footnote and its citations only. `selectCitation` and
    // `footnotes` are read here but must not retrigger it: re-running on every render would
    // reopen the source the reviewer may have just navigated away from.
  }, [focused, unidentified, citationsByFootnote, strayFootnote, strayCitations]);
  const reviewable = useMemo(() => footnotes.filter((footnote) => footnote.text), [footnotes]);

  const focusedFootnote = focused === null ? undefined : footnotes[focused];
  // A source panel describing a footnote the cursor is no longer in.
  //
  // Leaving it up is deliberate — see the effect above; blanking it the moment a reviewer
  // clicks into the body text would take away the thing they are reading from. But while
  // the pane is following the cursor, an unlabelled panel answers a question about where
  // the cursor is, and the reviewer has no way to see that it is answering an older one.
  // This is the same illusion the unidentified-footnote case is about, in the branch where
  // Ibid is working correctly: it says which footnote the panel belongs to, and stops.
  const panelFollowsCursor = !selected
    || focusedFootnote?.id === selected.footnote.id
    || strayFootnote?.text === selected.footnote.text;
  const listed = footnotes
    .map((footnote, index) => ({ footnote, index, citations: citationsByFootnote[index] ?? [] }))
    .filter((entry) => entry.footnote.text)
    .filter((entry) => showAll || needsReview(entry.citations) || entry.index === focused);
  const outstanding = footnotes
    .filter((footnote, index) => footnote.text && needsReview(citationsByFootnote[index] ?? [])).length;

  const footnoteIndex = <>
    <div className="panel-title">
      <h2>{showAll ? 'All footnotes' : 'Needs review'}</h2>
      <span className="count">{showAll ? reviewable.length : outstanding}</span>
      <button type="button" className="list-toggle" onClick={() => setShowAll((current) => !current)}>
        {showAll ? 'Show only what needs review' : `Show all ${reviewable.length}`}
      </button>
    </div>

    {listed.length === 0
      ? <p className="muted">{reviewable.length === 0
        ? 'No footnotes available for review.'
        : 'Nothing outstanding — every citation in this document resolved.'}</p>
      : <ol className="footnote-list">
        {listed.map(({ footnote, index, citations }) => <li
          key={footnote.id}
          className={`footnote-item${index === focused ? ' focused' : ''}`}
        >
          <div
            className="footnote-number"
            title={footnote.inBody ? 'Left in the body text by the PDF conversion; Word does not hold this as a footnote.' : undefined}
          >{footnote.number}{footnote.inBody ? '*' : ''}</div>
          <div className="footnote-content">
            <p>{footnote.text}</p>
            {citations.length ? <div className="citation-chips">
              {citations.map((citation) => <button
                className={`citation-chip${citation.status === 'resolved' ? '' : ' unconfirmed'}`}
                type="button"
                key={citationKey(citation, footnote.id)}
                title={citation.status === 'resolved' ? resolutionNote(citation)
                  : citation.status === 'unconfirmed_suggestion' ? 'Ibid has a suggestion for this, but the document does not define it. Select to confirm.'
                    : 'Ibid could not confirm which authority this refers to. Select to choose one.'}
                onClick={() => void selectCitation(citation, footnote)}
              >{citation.value}{citation.status === 'resolved' ? '' : ' ?'}</button>)}
            </div> : <span className="muted">No citation pattern detected in this footnote.</span>}
          </div>
        </li>)}
      </ol>}
  </>;

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">Ibid.</p>
        <h1>EU legal source review</h1>
        <p className="lede">{following
          ? 'Put your cursor on a citation in your document and its source appears here.'
          : 'Select a citation below to inspect its official source.'}</p>
      </header>

      <section className="panel review-panel" aria-live="polite">
        <div className="panel-title">
          <h2>{selected ? 'Source' : 'No citation selected'}</h2>
          {/* A label, not a count — see `.count.label`. "Note" rather than "Footnote" is
              already the whole of what `inBody` needs to say here: it is the word that
              distinguishes the two, and the context line below spells it out in full. */}
          {focusedFootnote
            ? <span className="count label">{focusedFootnote.inBody
              ? `Note ${focusedFootnote.number}`
              : `Footnote ${focusedFootnote.number}`}</span>
            : strayFootnote && <span className="count label">Selected text</span>}
        </div>

        {selected && following && !panelFollowsCursor && <p className="muted">
          {selected.footnote.number
            ? `The cursor has left footnote ${selected.footnote.number}.`
            : 'The cursor has left the text this was read from.'} This is the last source opened,
          not the citation the cursor is on now.
        </p>}

        {!selected && unidentified && <p className="error">
          The cursor is in a footnote Ibid could not match to one it has read. Use Refresh if the
          document has changed since the pane was opened.
        </p>}

        {!selected && !unidentified && <p className="muted">{following
          ? 'Put the cursor on a citation, or in the footnote holding it, and its source appears here.'
          : 'Pick a citation from the list below.'}</p>}

        {/* The footnote under the cursor, with its citations as chips. Shown whenever it
            holds more than one, because then landing on it opens nothing by itself and the
            reviewer has to say which authority they meant. */}
        {focusedFootnote && (citationsByFootnote[focused!] ?? []).length > 1 && <div className="citation-chips focused-chips">
          {(citationsByFootnote[focused!] ?? []).map((citation) => <button
            className={`citation-chip${citation.status === 'resolved' ? '' : ' unconfirmed'}${selected?.citation === citation ? ' current' : ''}`}
            type="button"
            key={citationKey(citation, focusedFootnote.id)}
            onClick={() => void selectCitation(citation, focusedFootnote)}
          >{citation.value}{citation.status === 'resolved' ? '' : ' ?'}</button>)}
        </div>}

        {!focusedFootnote && strayFootnote && strayCitations.length > 1 && <div className="citation-chips focused-chips">
          {strayCitations.map((citation) => <button
            className={`citation-chip${citation.status === 'resolved' ? '' : ' unconfirmed'}${selected?.citation === citation ? ' current' : ''}`}
            type="button"
            key={citationKey(citation, strayFootnote.id)}
            onClick={() => void selectCitation(citation, strayFootnote)}
          >{citation.value}{citation.status === 'resolved' ? '' : ' ?'}</button>)}
        </div>}

        {selected && <>
          <p className="selected-citation">{selected.citation.value}</p>
          {selected.citation.status === 'resolved' && <p className="resolution-note">{resolutionNote(selected.citation)}</p>}
          <p className="context-label">{!selected.footnote.number
            ? 'What you selected'
            : selected.footnote.inBody
              ? `Note ${selected.footnote.number} context, in body text`
              : `Footnote ${selected.footnote.number} context`}</p>
          <blockquote>{selected.citation.context}</blockquote>
          {review.kind === 'loading' && <p>Retrieving the official source passage…</p>}
          {review.kind === 'success' && <div className="source-results">{review.documents.map((document) =>
            <article key={document.url}>
              <p className="source-provider">{document.source}</p>
              <a href={document.url} target="_blank" rel="noreferrer">{document.title}</a>
              <SourceLanguageNote document={document} />
              <ExcerptScopeNote document={document} />
              <p>{document.excerpt}</p>
              <VerificationNote document={document} />
            </article>)}</div>}
          {review.kind === 'empty' && <p>No official source passage was found for this reference. You can open the official record directly.</p>}
          {review.kind === 'unresolved' && <UnresolvedReview
            citation={selected.citation}
            authorities={authorities}
            onConfirm={(candidate) => void confirmCitation(candidate)}
          />}
          {review.kind === 'error' && <p className="error">{review.message}</p>}
          {selected.citation.status === 'resolved' &&
            <a className="source-link" href={officialSourceUrl(selected.citation)} target="_blank" rel="noreferrer">Open official source</a>}
        </>}
      </section>

      {/* The index of footnotes, where it is the only way to reach one.

          Not where the cursor is being followed. There the reviewer works from the document
          and the pane answers about whatever they are looking at, so a list of citations is
          a second place to read the same document from — and it is the bigger one: three
          entries already pushed the source panel off the screen, and a real decision has a
          hundred and twelve. What is outstanding is said in one line beside the document
          instead, which is the part a reviewer cannot get by moving the cursor.

          Where following is unavailable — the browser preview, or a Word build whose
          selection events did not register — the list is the only route to a citation, so
          it is shown in full. */}
      {!following && <section className="panel">
        {footnoteIndex}
      </section>}

      <section className="panel source-overview">
        <div className="panel-actions">
          <div>
            <h2>Document</h2>
            <p className="status">{status}</p>
            {/* What the background warming has retrieved so far. Stated plainly, including
                what it could not get: a count that stalls two short of the total with no
                explanation invites the reader to wait for something that is not coming. */}
            {prefetching && prefetchStatus(prefetching) && <p className="status">{prefetchStatus(prefetching)}</p>}
            {/* Said, not listed. Which footnotes they are is a question the cursor answers,
                but that there is anything waiting at all is not — a reviewer moving through
                a document has no way to discover it, and would finish believing every
                citation had resolved. One line, and only when the answer is not zero. */}
            {following && outstanding > 0 && <p className="status">
              {outstanding} citation{outstanding === 1 ? '' : 's'} still need{outstanding === 1 ? 's' : ''} a decision.
            </p>}
          </div>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </section>
    </main>
  );
}

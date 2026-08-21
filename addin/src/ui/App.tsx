import { useEffect, useMemo, useRef, useState } from 'react';
import { citedAuthorities, getCitationContextsForFootnotes, reresolveBackReferences, PREVIEW_FOOTNOTES, type CitationCandidate, type CitationContext } from '../../../shared/src';
import {
  candidateKey, candidateLabel, citationKey, confirmationKey, curiaSearchUrl,
  autoSelectable, needsReview, officialSourceUrl, resolutionNote, toReviewFootnotes,
  unresolvedMessage, type ReviewFootnote,
} from './citation-view';

type ReviewDocument = {
  title: string; excerpt: string; url: string; source: string;
  /** What the citation pinpointed, as the resolver labelled it: "Point 46", "Article 17(1)". */
  locator?: string;
  /** Whether the excerpt is that passage, or the document's opening standing in for it. */
  passage?: 'cited' | 'opening';
  language?: 'en' | 'fr';
  translation?: { from: 'en' | 'fr'; officialUrl: string };
};
type ReviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; documents: ReviewDocument[] }
  | { kind: 'empty' }
  | { kind: 'unresolved' }
  | { kind: 'error'; message: string };

const sampleBody = 'Browser preview of a realistic EU data-protection and competition memo. Every case number and ECLI below is a real citation, verified against the official EUR-Lex/CELLAR record. Open Ibid in Word to review your own document.';
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

async function readWordDocument(): Promise<{ body: string; footnotes: ReviewFootnote[] }> {
  return Word.run(async (context) => {
    const body = context.document.body;
    const footnotes = body.footnotes;
    body.load('text');
    footnotes.load('items');
    await context.sync();
    footnotes.items.forEach((footnote) => footnote.body.load('text'));
    await context.sync();

    return {
      body: body.text.trim(),
      // Every footnote, empties included: numbering is what back-references count on, and
      // dropping one here shifts every footnote after it. See `toReviewFootnotes`.
      footnotes: toReviewFootnotes(footnotes.items.map((footnote) => footnote.body.text)),
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
  /** `reported` is what Word said about the caret's surroundings, for the pane to repeat. */
  | { kind: 'unidentified'; reported?: string }
  | { kind: 'outside'; reported?: string };

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

/**
 * The footnote that agrees with this text for longest, and how far it got.
 *
 * For the reviewer this is the difference between two very different failures: a pane whose
 * list does not hold the footnote they are in at all, and a pane that holds it but stopped
 * recognising it at character 45. Only one of those is a matching bug, and without this the
 * pane cannot say which it is having.
 */
function nearestFootnote(keys: readonly string[], text: string): string {
  const key = comparisonKey(text);
  if (!key) return 'nothing to compare';
  let best = -1;
  let agreed = 0;
  keys.forEach((candidate, index) => {
    let shared = 0;
    while (shared < candidate.length && shared < key.length && candidate[shared] === key[shared]) shared += 1;
    if (shared > agreed) { agreed = shared; best = index; }
  });
  return best < 0 || agreed === 0
    ? `no footnote of ${keys.length} opens like it`
    : `nearest is footnote ${best + 1}, alike for ${agreed} of ${key.length}`;
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
    // whether they were in a footnote at all — and when even that is wrong, `reported` is
    // what Word claimed, so the pane can say it rather than leave it to be inferred.
    const reported = [
      `body ${parentType || 'unnamed'}`,
      `${selectedText.length} characters selected`,
      `${paragraphs.items.length} paragraphs`,
      `${contained.items.length} reference marks`,
      selectedText ? `starting "${selectedText.slice(0, 40)}"` : 'nothing selected',
      nearestFootnote(keys, selectedText),
    ].join(', ');
    const inFootnote = FOOTNOTE_BODIES.includes(parentType);
    return inFootnote ? { kind: 'unidentified' as const, reported } : { kind: 'outside' as const, reported };
  });
}

async function resolveSource(citation: CitationContext): Promise<ReviewDocument[]> {
  // `import.meta.env` is Vite's, and exists only in a Vite-built bundle. Reaching through
  // it unguarded threw a TypeError under every other runtime — which meant the task-pane
  // tests never reached `fetch` at all, and every retrieval state below was silently
  // untested. Optional-chaining here costs nothing in the browser and makes the pane
  // runnable wherever it is imported.
  const apiBase = import.meta.env?.VITE_IBID_API_BASE_URL?.replace(/\/$/, '') ?? '/api';
  const lookup = {
    source: citation.source, value: citation.value, celex: citation.celex, ecli: citation.ecli,
    caseNumber: citation.caseNumber, caseName: citation.caseName,
    documentType: citation.documentType, locator: citation.locator,
    // Every paragraph the footnote names, not just the one retrieval anchors on: a citation
    // to "paras 62 and 65" is a citation to both, and the resolver cannot know that from the
    // locator alone.
    paragraphs: citation.pinpoint?.paragraphs,
  };
  const response = await fetch(`${apiBase}/sources?lookup=${encodeURIComponent(JSON.stringify(lookup))}`);
  if (!response.ok) throw new Error(`Source lookup failed (${response.status}).`);
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
  if (document.passage !== 'opening') return null;
  return <p className="source-note">
    {document.locator ?? 'The cited passage'} could not be located in the retrieved text — this is
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
  const [body, setBody] = useState('');
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
  // What Word said about the caret the last time nothing could be matched to it. Shown with
  // the document, not with the source: it is for working out why the pane is wrong, which is
  // a question the reviewer only asks once the answer above them already looks wrong.
  const [cursorReport, setCursorReport] = useState<string | null>(null);
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

  const refresh = async () => {
    setStatus('Connecting to Word…');
    const runtimeAvailable = await waitForWordRuntime();
    if (!runtimeAvailable) {
      setBody(sampleBody);
      setFootnotes(sampleFootnotes);
      setStatus('Browser preview: sample footnotes are shown. Open Ibid in Word to review your document.');
      return;
    }

    setWordReady(true);
    setStatus('Reading the document and its footnotes…');
    try {
      const next = await readWordDocument();
      setBody(next.body);
      setFootnotes(next.footnotes);
      setStatus(next.footnotes.length
        ? `${next.footnotes.length} footnote${next.footnotes.length === 1 ? '' : 's'} ready for review.`
        : 'No footnotes found. The document body is still available below.');
    } catch {
      setStatus('Ibid could not read this document. Confirm that Word supports the WordApi 1.5 requirement set.');
    }
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
    setReview({ kind: 'loading' });
    try {
      const documents = await resolveSource(citation);
      setReview(documents.length ? { kind: 'success', documents } : { kind: 'empty' });
    } catch (error) {
      setReview({ kind: 'error', message: error instanceof Error ? error.message : 'The source lookup could not be completed.' });
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
      const documents = await resolveSource(confirmed);
      setReview(documents.length ? { kind: 'success', documents } : { kind: 'empty' });
    } catch (error) {
      setReview({ kind: 'error', message: error instanceof Error ? error.message : 'The source lookup could not be completed.' });
    }
  };

  useEffect(() => { void refresh(); }, []);

  // The footnote texts a selection is matched against, and the read that answers one. Both
  // live in refs so that re-reading the document leaves the Office handler alone.
  const footnoteTexts = useRef<readonly string[]>([]);
  const readLocation = useRef<() => void>(() => undefined);

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
          setCursorReport(location.kind === 'footnotes' ? null : location.reported ?? null);
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

  const authorities = useMemo(() => citedAuthorities(detected), [detected]);

  // Landing on a footnote opens its source, but only where there is no choice to make —
  // see `autoSelectable`. Keyed on the footnote so moving the cursor within one footnote
  // does not reopen what the reviewer may have just navigated away from.
  useEffect(() => {
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
  }, [focused, unidentified, citationsByFootnote]);
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
  const panelFollowsCursor = !selected || focusedFootnote?.id === selected.footnote.id;
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
          <div className="footnote-number">{footnote.number}</div>
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
          {focusedFootnote && <span className="count">Footnote {focusedFootnote.number}</span>}
        </div>

        {selected && following && !panelFollowsCursor && <p className="muted">
          The cursor has left footnote {selected.footnote.number}. This is the last source opened,
          not the citation the cursor is on now.
        </p>}

        {/* What Word said about a caret nothing could be matched to. Beside the source
            because that is where the reviewer is looking when the answer is wrong. */}
        {cursorReport && <p className="muted">Word reported the cursor as: {cursorReport}</p>}

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

        {selected && <>
          <p className="selected-citation">{selected.citation.value}</p>
          {selected.citation.status === 'resolved' && <p className="resolution-note">{resolutionNote(selected.citation)}</p>}
          <p className="context-label">Footnote {selected.footnote.number} context</p>
          <blockquote>{selected.citation.context}</blockquote>
          {review.kind === 'loading' && <p>Retrieving the official source passage…</p>}
          {review.kind === 'success' && <div className="source-results">{review.documents.map((document) =>
            <article key={document.url}>
              <p className="source-provider">{document.source}</p>
              <a href={document.url} target="_blank" rel="noreferrer">{document.title}</a>
              <SourceLanguageNote document={document} />
              <ExcerptScopeNote document={document} />
              <p>{document.excerpt}</p>
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

      {/* The index of footnotes.

          Where the cursor is being followed this is a fallback, not the way the pane is
          meant to be used: the reviewer works from the document, and the pane answers about
          whatever they are looking at. Listing every footnote that still needs a decision
          is a handful of entries on a brief and a hundred and twelve on a real Commission
          decision — a wall to scroll past to reach the one panel that was wanted. So it
          collapses, and what is on screen is the citation under the cursor.

          Where following is unavailable — the browser preview, or a Word build whose
          selection events did not register — it is the only route to a citation, so it
          stays open. */}
      <section className="panel">
        {following
          ? <details className="footnote-index">
            <summary>
              Look through the footnotes instead
              {outstanding > 0 && <span className="index-count">{outstanding} need{outstanding === 1 ? 's' : ''} review</span>}
            </summary>
            {footnoteIndex}
          </details>
          : footnoteIndex}
      </section>

      <section className="panel source-overview">
        <div className="panel-actions">
          <div>
            <h2>Document</h2>
            <p className="status">{status}</p>
            {cursorReport && <p className="status">Word reported the cursor as: {cursorReport}</p>}
          </div>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <details>
          <summary>View document body</summary>
          <pre className="source-text">{body || 'No document body text available.'}</pre>
        </details>
      </section>
    </main>
  );
}

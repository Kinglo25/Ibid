import { useEffect, useMemo, useState } from 'react';
import { citedAuthorities, getCitationContextsForFootnotes, PREVIEW_FOOTNOTES, type CitationCandidate, type CitationContext } from '../../../shared/src';

type Footnote = { id: string; number: number; text: string };
type ReviewDocument = { title: string; excerpt: string; url: string; source: string };
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
const sampleFootnotes: Footnote[] = PREVIEW_FOOTNOTES.map((text, index) => ({ id: `sample-${index + 1}`, number: index + 1, text }));

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

async function readWordDocument(): Promise<{ body: string; footnotes: Footnote[] }> {
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
      footnotes: footnotes.items.map((footnote, index) => ({
        id: `footnote-${index + 1}`,
        number: index + 1,
        text: footnote.body.text.trim(),
      })).filter((footnote) => footnote.text),
    };
  });
}

function citationKey(citation: CitationContext, footnoteId: string) {
  return `${footnoteId}-${citation.index}-${citation.value}`;
}

/**
 * How far a confirmation reaches.
 *
 * A short form is a name, and a name means one thing throughout a document, so settling
 * "Akzo Nobel" once settles every later use of it — that is the whole point of confirming
 * it. A back-reference is positional: `Ibid.` means whatever precedes it, so two of them
 * in the same document are two different citations that merely happen to be spelled the
 * same. Keying those by their text would take one reviewer's decision about footnote 13
 * and apply it, unasked and invisibly, to every other `Ibid.` in the document.
 */
function confirmationKey(citation: CitationContext, footnoteId: string) {
  return citation.backReference ? citationKey(citation, footnoteId) : citation.value.toLowerCase();
}

function curiaSearchUrl(query: string): string {
  return `https://curia.europa.eu/juris/liste.jsf?language=en&num=${encodeURIComponent(query)}`;
}

function officialSourceUrl(citation: CitationContext): string {
  // The CELEX names the document that was cited whatever kind it is — its sector is
  // derived from the document type — so an opinion links to the opinion, not to the
  // judgment in the same case.
  if (citation.celex) return `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${citation.celex}`;
  if (citation.source === 'commission') return `https://competition-cases.ec.europa.eu/search?query=${encodeURIComponent(citation.value)}`;
  // caseNumber, then ecli, then the literal matched text, in that preference order: a
  // shorthand reference resolved via a defined term (e.g. "Akzo Nobel, para. 45.") carries
  // its originating citation's caseNumber/ecli but its own `value` is just the short form,
  // which is not a usable CURIA search query on its own.
  return curiaSearchUrl(citation.caseNumber ?? citation.ecli ?? citation.value);
}

async function resolveSource(citation: CitationContext): Promise<ReviewDocument[]> {
  const apiBase = import.meta.env.VITE_IBID_API_BASE_URL?.replace(/\/$/, '') ?? '/api';
  const lookup = {
    source: citation.source, value: citation.value, celex: citation.celex, ecli: citation.ecli,
    caseNumber: citation.caseNumber, documentType: citation.documentType, locator: citation.locator,
  };
  const response = await fetch(`${apiBase}/sources?lookup=${encodeURIComponent(JSON.stringify(lookup))}`);
  if (!response.ok) throw new Error(`Source lookup failed (${response.status}).`);
  const payload = await response.json() as { documents?: ReviewDocument[] };
  return payload.documents ?? [];
}

function candidateKey(candidate: CitationCandidate): string {
  return candidate.ecli ?? candidate.caseNumber ?? candidate.celex ?? candidate.caseName ?? 'unknown';
}

/**
 * The judgment, the Advocate General's opinion, and the order in one case all share the
 * case name exactly, so a pick-list built on the name alone offers three identical-looking
 * options — the reviewer cannot tell which is which at the moment they are being asked to
 * choose. The document type is what separates them.
 */
function candidateLabel(candidate: CitationCandidate): string {
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
function resolutionNote(citation: CitationContext): string {
  const footnote = citation.backReference?.footnote;
  switch (citation.resolutionMethod) {
    case 'user_confirmed': return citation.backReference
      ? 'Confirmed by you for this reference.'
      : 'Confirmed by you for this document.';
    case 'preceding_citation': return footnote
      ? `Read as the authority cited immediately before it, in footnote ${footnote}.`
      : 'Read as the authority cited immediately before it.';
    case 'numbered_footnote': return `Read from footnote ${footnote}, which this reference names.`;
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
  const footnote = citation.backReference?.footnote;
  const message = citation.status === 'unconfirmed_suggestion'
    ? `This document does not define "${citation.value}". Ibid recognises the name from its list of frequently cited cases — confirm before relying on it.`
    : citation.backReference
      ? suggested.length
        ? `Footnote ${footnote} cites more than one authority, so "${citation.value}" does not say which of them is meant.`
        : footnote
          ? `"${citation.value}" points back to footnote ${footnote}, which does not establish an authority to point at.`
          : `"${citation.value}" points back to an authority cited before it, but nothing before it establishes one.`
      : suggested.length
        ? `"${citation.value}" could refer to more than one authority, and this document does not say which.`
        : `"${citation.value}" reads like a reference to an authority, but nothing in this document defines it.`;

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
  const [footnotes, setFootnotes] = useState<Footnote[]>([]);
  const [status, setStatus] = useState('Loading source material…');
  const [selected, setSelected] = useState<{ citation: CitationContext; footnote: Footnote } | null>(null);
  const [review, setReview] = useState<ReviewState>({ kind: 'idle' });
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

  const selectCitation = async (citation: CitationContext, footnote: Footnote) => {
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
    () => detected.map((citations, index) => citations.map((citation) => {
      if (citation.status === 'resolved') return citation;
      const confirmed = confirmations[confirmationKey(citation, footnotes[index].id)];
      return confirmed ? { ...citation, ...confirmed, status: 'resolved' as const, resolutionMethod: 'user_confirmed' as const, candidates: undefined } : citation;
    })),
    [detected, confirmations, footnotes],
  );

  const authorities = useMemo(() => citedAuthorities(detected), [detected]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">Ibid.</p>
        <h1>EU legal source review</h1>
        <p className="lede">Inspect official CJEU, EUR-Lex, and Commission source material without leaving Word.</p>
      </header>

      <section className="panel source-overview">
        <div className="panel-actions">
          <div><h2>Document source</h2><p className="status">{status}</p></div>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <details>
          <summary>View document body</summary>
          <pre className="source-text">{body || 'No document body text available.'}</pre>
        </details>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Footnotes</h2><span className="count">{footnotes.length}</span></div>
        {footnotes.length === 0 ? <p>No footnotes available for review.</p> : (
          <ol className="footnote-list">
            {footnotes.map((footnote, index) => {
              const citations = citationsByFootnote[index] ?? [];
              return <li key={footnote.id} className="footnote-item">
                <div className="footnote-number">{footnote.number}</div>
                <div className="footnote-content">
                  <p>{footnote.text}</p>
                  {citations.length ? <div className="citation-chips">
                    {citations.map((citation) => <button
                      className={citation.status === 'resolved' ? 'citation-chip' : 'citation-chip unconfirmed'}
                      type="button"
                      key={citationKey(citation, footnote.id)}
                      title={citation.status === 'resolved' ? resolutionNote(citation)
                        : citation.status === 'unconfirmed_suggestion' ? 'Ibid has a suggestion for this, but the document does not define it. Select to confirm.'
                          : 'Ibid could not confirm which authority this refers to. Select to choose one.'}
                      onClick={() => void selectCitation(citation, footnote)}
                    >{citation.value}{citation.status === 'resolved' ? '' : ' ?'}</button>)}
                  </div> : <span className="muted">No citation pattern detected in this footnote.</span>}
                </div>
              </li>;
            })}
          </ol>
        )}
      </section>

      <section className="panel review-panel" aria-live="polite">
        <h2>Original source review</h2>
        {!selected && <p>Select a citation from a footnote to inspect its context and look for the underlying opinion.</p>}
        {selected && <>
          <p className="selected-citation">{selected.citation.value}</p>
          {selected.citation.status === 'resolved' && <p className="resolution-note">{resolutionNote(selected.citation)}</p>}
          <p className="context-label">Footnote {selected.footnote.number} context</p>
          <blockquote>{selected.citation.context}</blockquote>
          {review.kind === 'loading' && <p>Retrieving the official source passage…</p>}
          {review.kind === 'success' && <div className="source-results">{review.documents.map((document) => <article key={document.url}><p className="source-provider">{document.source}</p><a href={document.url} target="_blank" rel="noreferrer">{document.title}</a><p>{document.excerpt}</p></article>)}</div>}
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
    </main>
  );
}

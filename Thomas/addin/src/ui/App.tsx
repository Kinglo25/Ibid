import { useEffect, useState } from 'react';
import { getCitationContexts, type CitationContext } from '../../../shared/src';

type Footnote = { id: string; number: number; text: string };
type ReviewDocument = { title: string; excerpt: string; url: string; source: string };
type ReviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; documents: ReviewDocument[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const sampleBody = 'The availability of a remedy depends on the historical record and the statute at issue.';
const sampleFootnotes: Footnote[] = [
  { id: 'sample-1', number: 1, text: 'In Smith v. Jones, 123 F.3d 456 (9th Cir. 2020), the court discussed 42 U.S.C. § 1983.' },
  { id: 'sample-2', number: 2, text: 'See Adams v. State, 456 U.S. 789 (1982), for the governing framework.' },
];

function isWordRuntimeAvailable(): boolean {
  return typeof Office !== 'undefined' && typeof Word !== 'undefined' && Boolean(Office.context?.document);
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

function searchUrl(citation: string) {
  return `https://www.courtlistener.com/?q=${encodeURIComponent(citation)}&type=o`;
}

async function resolveSource(citation: string): Promise<ReviewDocument[]> {
  const apiBase = import.meta.env.VITE_THOMAS_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return [];

  const response = await fetch(`${apiBase}/sources?citation=${encodeURIComponent(citation)}`);
  if (!response.ok) throw new Error(`Source lookup failed (${response.status}).`);
  const payload = await response.json() as { documents?: ReviewDocument[] };
  return payload.documents ?? [];
}

export default function App() {
  const [body, setBody] = useState('');
  const [footnotes, setFootnotes] = useState<Footnote[]>([]);
  const [status, setStatus] = useState('Loading source material…');
  const [selected, setSelected] = useState<{ citation: CitationContext; footnote: Footnote } | null>(null);
  const [review, setReview] = useState<ReviewState>({ kind: 'idle' });

  const refresh = async () => {
    if (!isWordRuntimeAvailable()) {
      setBody(sampleBody);
      setFootnotes(sampleFootnotes);
      setStatus('Browser preview: sample footnotes are shown. Open Thomas in Word to review your document.');
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
      setStatus('Thomas could not read this document. Confirm that Word supports the WordApi 1.5 requirement set.');
    }
  };

  const selectCitation = async (citation: CitationContext, footnote: Footnote) => {
    setSelected({ citation, footnote });
    setReview({ kind: 'loading' });
    try {
      const documents = await resolveSource(citation.value);
      setReview(documents.length ? { kind: 'success', documents } : { kind: 'empty' });
    } catch (error) {
      setReview({ kind: 'error', message: error instanceof Error ? error.message : 'The source lookup could not be completed.' });
    }
  };

  useEffect(() => { void refresh(); }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">Thomas</p>
        <h1>Source review</h1>
        <p className="lede">Inspect cited material and its surrounding footnote context. Thomas does not make a correctness judgment.</p>
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
            {footnotes.map((footnote) => {
              const citations = getCitationContexts(footnote.text);
              return <li key={footnote.id} className="footnote-item">
                <div className="footnote-number">{footnote.number}</div>
                <div className="footnote-content">
                  <p>{footnote.text}</p>
                  {citations.length ? <div className="citation-chips">
                    {citations.map((citation) => <button className="citation-chip" type="button" key={citationKey(citation, footnote.id)} onClick={() => void selectCitation(citation, footnote)}>{citation.value}</button>)}
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
          <p className="context-label">Footnote {selected.footnote.number} context</p>
          <blockquote>{selected.citation.context}</blockquote>
          {review.kind === 'loading' && <p>Looking for source material…</p>}
          {review.kind === 'success' && <div className="source-results">{review.documents.map((document) => <article key={document.url}><p className="source-provider">{document.source}</p><a href={document.url} target="_blank" rel="noreferrer">{document.title}</a><p>{document.excerpt}</p></article>)}</div>}
          {review.kind === 'empty' && <p>Connect the optional API to show matched opinions here. You can still search the public source directly.</p>}
          {review.kind === 'error' && <p className="error">{review.message}</p>}
          <a className="source-link" href={searchUrl(selected.citation.value)} target="_blank" rel="noreferrer">Search CourtListener for this citation</a>
        </>}
      </section>
    </main>
  );
}

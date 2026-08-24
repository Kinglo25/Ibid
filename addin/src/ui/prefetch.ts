import type { CitationContext } from '../../../shared/src';

/**
 * Warming the source cache for a document that has just been opened.
 *
 * The pane already knows every citation in the document before the reviewer clicks
 * anything: detection and short-form resolution run over the whole document at open, on
 * this machine, and produce the full list. Waiting for a click before asking EUR-Lex for
 * any of it means the first inspection of every authority costs a cold retrieval — measured
 * live against CELLAR at 149KB and ~1.5s for a judgment, uncompressed — while the reviewer
 * sits and watches.
 *
 * So the work starts at open instead. What this must not become is a faster client: the
 * request spacing is unchanged and the requests still go one at a time, because a burst of
 * sequential fetches is exactly the fingerprint anti-bot protection reacts to, and Ibid's
 * claim to public CELLAR access rests on being an identifiable, well-behaved caller. The
 * win here is starting earlier, not going faster.
 *
 * Kept free of JSX, like `citation-view.ts`, so the ordering and cancellation rules below
 * can be tested as plain functions rather than only through a rendered pane.
 */

export type PrefetchTarget = {
  /** The document to warm. One entry per distinct authority, however many footnotes cite it. */
  celex: string;
  /** Where it was first cited, so a cursor landing on a footnote can promote what it holds. */
  footnote: number;
  /** Every footnote citing this document, so promoting works from any of them. */
  footnotes: number[];
  /** The citation the request is built from — the first one that named this document. */
  citation: CitationContext;
};

/**
 * The distinct documents a resolved document cites, in reading order.
 *
 * Deduplicated by CELEX, which is what identifies a document: twenty footnotes citing
 * different paragraphs of one judgment are one entry here and one retrieval, because the
 * resolver now caches the document and cuts each excerpt out of it locally.
 *
 * Only `resolved` citations are included, and only those carrying a CELEX. An unresolved
 * short form has nothing to look up — resolving it is a decision the reviewer has not made
 * yet, and guessing at it in the background would be the same wrong-citation-with-full-
 * confidence failure the pane refuses to make in the foreground. A resolved citation with
 * no CELEX (a Commission case number, an older case) resolves to a link rather than to
 * retrieved text, so there is no network result to warm.
 *
 * Back-references are already resolved to the authority they point at by the time this runs
 * — `Ibid.` and `supra note 4` arrive carrying the CELEX of whatever they refer to — so a
 * document whose footnotes are mostly back-references collapses to the handful of
 * authorities it actually cites.
 */
export function prefetchTargets(citationsByFootnote: readonly (readonly CitationContext[])[]): PrefetchTarget[] {
  const byCelex = new Map<string, PrefetchTarget>();
  citationsByFootnote.forEach((citations, index) => {
    for (const citation of citations) {
      if (citation.status !== 'resolved' || !citation.celex) continue;
      const held = byCelex.get(citation.celex);
      if (held) {
        if (!held.footnotes.includes(index)) held.footnotes.push(index);
        continue;
      }
      byCelex.set(citation.celex, { celex: citation.celex, footnote: index, footnotes: [index], citation });
    }
  });
  return [...byCelex.values()];
}

export type PrefetchProgress = {
  /** Documents successfully retrieved. */
  retrieved: number;
  /** Documents tried, including the ones that failed. */
  attempted: number;
  total: number;
};

/**
 * What the pane says while the queue runs, and after it stops.
 *
 * Honest about failures rather than rounding them away: a queue that stalls at "Retrieved
 * 21 of 23" with no explanation invites the reader to assume the last two are still coming.
 * Some documents genuinely are not in CELLAR — six of 196 identifiers in the corpus run —
 * and those citations fall back to their official CURIA link when opened, which is a
 * working answer rather than a failure of the pane.
 */
export function prefetchStatus(progress: PrefetchProgress): string | undefined {
  const { retrieved, attempted, total } = progress;
  if (!total) return undefined;
  if (attempted < total) return `Retrieved ${retrieved} of ${total} sources…`;
  const missing = total - retrieved;
  return missing
    ? `Retrieved ${retrieved} of ${total} sources; ${missing} ${missing === 1 ? 'is' : 'are'} not held by EUR-Lex and will open as a link.`
    : `Retrieved all ${total} sources.`;
}

export type Prefetcher = {
  /**
   * Move whatever this footnote cites to the front of the queue.
   *
   * The reviewer's cursor is the best available statement of what they are about to want,
   * and it beats reading order the moment it disagrees with it. Already-retrieved documents
   * are no longer in the queue, so promoting them is a no-op rather than a second fetch.
   */
  promote(footnote: number): void;
  /** Stop, and abort whatever is in flight. Called when the document changes or the pane closes. */
  cancel(): void;
  /** Resolves when the queue has drained or been cancelled. For tests, and for nothing else. */
  finished: Promise<void>;
};

/**
 * Retrieves each target in turn, one at a time, until the queue drains or is cancelled.
 *
 * Strictly sequential, and deliberately so. The resolver spaces its own outbound requests
 * to CELLAR, so issuing these in parallel would not make them arrive any faster — it would
 * only queue them up inside the resolver while presenting the API with a burst. One at a
 * time also means cancelling has something to cancel: at most one request is ever in
 * flight, so closing a document abandons one response rather than twenty.
 */
export function startPrefetch(options: {
  targets: readonly PrefetchTarget[];
  retrieve: (target: PrefetchTarget, signal: AbortSignal) => Promise<unknown>;
  onProgress: (progress: PrefetchProgress) => void;
}): Prefetcher {
  const pending = [...options.targets];
  const total = pending.length;
  const controller = new AbortController();
  let retrieved = 0;
  let attempted = 0;
  let cancelled = false;

  const report = () => { if (!cancelled) options.onProgress({ retrieved, attempted, total }); };

  async function drain() {
    report();
    while (pending.length && !cancelled) {
      const target = pending.shift()!;
      try {
        await options.retrieve(target, controller.signal);
        if (cancelled) return;
        retrieved += 1;
      } catch {
        // A document CELLAR does not hold, or a request abandoned because the reviewer
        // moved on. Neither is worth an error in the pane: the citation still opens, and
        // falls back to its official link the same way it would without any of this.
        if (cancelled) return;
      }
      attempted += 1;
      report();
    }
  }

  return {
    promote(footnote) {
      if (cancelled) return;
      const wanted = pending.filter((target) => target.footnotes.includes(footnote));
      if (!wanted.length) return;
      pending.splice(0, pending.length, ...wanted, ...pending.filter((target) => !wanted.includes(target)));
    },
    cancel() {
      cancelled = true;
      pending.length = 0;
      controller.abort();
    },
    // Started on a microtask rather than synchronously, so the caller holds the queue
    // before the first retrieval begins. Otherwise the very first document is already in
    // flight while `promote` and `cancel` are still unreachable — and the first thing that
    // happens after a document opens is the reviewer putting their cursor somewhere.
    finished: Promise.resolve().then(drain),
  };
}

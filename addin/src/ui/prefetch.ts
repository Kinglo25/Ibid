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
 *
 * Honest about *what* the failure was, too, which this got wrong once and is worth keeping
 * right. A document CELLAR does not hold is not a failure here at all — the resolver
 * answers with the official CURIA link instead of text, which is a successful lookup and is
 * counted as one. What reaches the missing count is a lookup that did not complete: the
 * Ibid server unreachable or erroring, a response that would not parse. Saying those
 * documents "are not held by EUR-Lex" states something about the authorities the lawyer is
 * citing on the strength of something that went wrong in the plumbing, which is precisely
 * the kind of claim this pane exists not to make. Observed live: the API stopped, and the
 * pane reported all 38 of a Commission decision's authorities as absent from EUR-Lex.
 *
 * Every lookup failing is itself informative — 38 documents do not individually vanish —
 * so that case says what is actually likely, hedged, and points at the thing the reviewer
 * can still do.
 */
export function prefetchStatus(progress: PrefetchProgress): string | undefined {
  const { retrieved, attempted, total } = progress;
  if (!total) return undefined;
  if (attempted < total) return `Retrieved ${retrieved} of ${total} sources…`;
  const missing = total - retrieved;
  if (!missing) return `Retrieved all ${total} sources.`;
  if (!retrieved && total > 1) {
    return `No sources could be retrieved — Ibid may not be able to reach its server. Citations still open their official link.`;
  }
  return `Retrieved ${retrieved} of ${total} sources; ${missing} could not be retrieved and ${missing === 1 ? 'opens' : 'open'} as a link instead.`;
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
        // A lookup that did not complete — the server unreachable, an error response, a
        // request abandoned because the reviewer moved on. Not worth an error in the pane:
        // the citation still opens, and falls back to its official link the same way it
        // would without any of this. Note that this is *not* where a document CELLAR does
        // not hold arrives; that comes back as a link-only preview, which is a success.
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

export type Confirmations<T> = {
  /**
   * Ask for this answer again, confirmed, once nothing the reviewer is waiting on is left.
   * A key already waiting is not queued twice.
   */
  add(key: string, item: T): void;
  /** Stop, and abort whatever is in flight. Called with the warming queue's own `cancel`. */
  cancel(): void;
  /** Resolves when nothing is queued or in flight. For tests, and for nothing else. */
  settled(): Promise<void>;
};

/**
 * Confirms, afterwards, what the server answered from a copy it already held.
 *
 * A Commission decision Ibid has read before is answered at once, from the text the server
 * holds, and marked as not yet confirmed. Confirming it first is what used to make that
 * answer slow: a conditional request the Commission answers `304` costs little in itself,
 * but it takes a turn at the server's one-at-a-time wire, and a case with several decisions
 * takes a turn for each. So the reviewer is shown the passage and the confirmation happens
 * here, behind them.
 *
 * Behind the warming queue as well, not merely beside it: a confirmation also takes a turn
 * at the wire, and every one taken while warming runs pushes back a passage the reviewer has
 * not been shown at all. The text being confirmed is already on screen, dated when it was
 * last checked, so it is the one that can wait.
 *
 * One at a time, like everything else this pane sends, and for the same reason.
 */
export function startConfirmations<T>(options: {
  /** Resolves once the warming queue has drained or been cancelled. */
  whenWarm: () => Promise<void>;
  confirm: (item: T, signal: AbortSignal) => Promise<unknown>;
}): Confirmations<T> {
  const waiting = new Map<string, T>();
  const controller = new AbortController();
  let cancelled = false;
  let running: Promise<void> = Promise.resolve();
  let draining = false;

  async function drain() {
    draining = true;
    try {
      while (waiting.size && !cancelled) {
        await options.whenWarm();
        if (cancelled) return;
        const [key, item] = waiting.entries().next().value!;
        try {
          await options.confirm(item, controller.signal);
        } catch {
          // Nothing to say: the passage on screen stays as it was, dated when it really was
          // last confirmed. `confirm` itself decides what a failure leaves behind.
        }
        waiting.delete(key);
      }
    } finally {
      draining = false;
    }
  }

  return {
    add(key, item) {
      if (cancelled || waiting.has(key)) return;
      waiting.set(key, item);
      if (!draining) running = drain();
    },
    cancel() {
      cancelled = true;
      waiting.clear();
      controller.abort();
    },
    settled: () => running,
  };
}

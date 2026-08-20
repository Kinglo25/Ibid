export type EuLookup = {
  source: 'curia' | 'eur-lex' | 'commission';
  value: string;
  celex?: string;
  ecli?: string;
  caseNumber?: string;
  /**
   * For `source: 'curia'` only, and purely descriptive here: `celex` is expected to
   * already name the document this describes, because its sector is derived from this
   * type (`CJ` judgment, `CC` Advocate General opinion, `CO`/`TO` order). Callers must
   * not pass a judgment CELEX alongside `documentType: 'opinion'` — the resolver fetches
   * whatever CELEX it is given.
   */
  documentType?: 'judgment' | 'opinion' | 'order';
  /**
   * The party-versus-party name, where the document established one. Supplied so a preview
   * can be titled with the authority it is showing rather than with `value` — see
   * `describeDocument`.
   */
  caseName?: string;
  locator?: { kind: 'point' | 'article'; start: number; paragraph?: number; end?: number };
  /**
   * Every paragraph the citation actually names, ranges already expanded — so
   * "paras 40-44, 46 and 48" arrives as [40,41,42,43,44,46,48]. `locator` describes only
   * where retrieval is anchored; this is what the reader was pointed at, and a citation to
   * separate paragraphs is a citation to all of them.
   */
  paragraphs?: number[];
};

export type SourceLanguage = 'en' | 'fr';

export type SourcePreview = {
  title: string;
  excerpt: string;
  url: string;
  source: 'CURIA' | 'EUR-Lex' | 'European Commission';
  locator?: string;
  /** The language `excerpt` is actually in. Absent where no document was retrieved. */
  language?: SourceLanguage;
  /**
   * Set only when `excerpt` is a machine translation rather than the published text.
   *
   * A translation is not the authority. A lawyer arguing from a paragraph needs to know
   * that the words in front of them were produced by a machine and that the authentic text
   * is somewhere else, so this carries the link to it and the pane says so plainly. Nothing
   * downstream may present a translated excerpt as the official source.
   */
  translation?: { from: SourceLanguage; officialUrl: string };
};

/**
 * Identifies the client to CELLAR when nothing better is configured. Deliberately names the
 * tool and points at its source rather than imitating a browser: the aim is to be
 * recognisable, so that a rate problem can be raised with someone instead of being met with
 * a block. Override it with `IBID_USER_AGENT` to carry a real contact address.
 */
/** CELLAR negotiates on ISO 639-2/B codes, not the two-letter tags used everywhere else. */
const CELLAR_LANGUAGE: Record<SourceLanguage, string> = { en: 'eng', fr: 'fra' };

const DEFAULT_USER_AGENT = 'Ibid/0.1 (EU-law citation review add-in; +https://github.com/Kinglo25/Ibid)';

/**
 * What to call the document a preview is showing.
 *
 * `value` — the text the footnote actually used — is only a description of the document
 * when the footnote spelled it out. A back-reference does not: titling its preview with
 * `value` heads the panel "Ibid." or "Supra note 7", which tells a reader nothing about
 * what they are reading and leaves them to work out which judgment it is. That is the
 * work this tool exists to save them, and it was visible in the first real Word session.
 *
 * So the name is built from what the citation resolved *to*, preferring what a lawyer
 * would actually call it: the case name, qualified by document type because a judgment,
 * the Advocate General's opinion, and the order in one case share a name exactly. The
 * matched text is the last resort rather than the first.
 */
function describeDocument(lookup: EuLookup): string {
  const qualifier = lookup.documentType && lookup.documentType !== 'judgment' ? ` (${lookup.documentType})` : '';
  if (lookup.caseName) {
    return `${lookup.caseName}${lookup.caseNumber ? `, ${lookup.caseNumber}` : ''}${qualifier}`;
  }
  if (lookup.caseNumber) return `${lookup.caseNumber}${qualifier}`;
  // A back-reference carries no name of its own, so anything identifying beats echoing it.
  if (BACK_REFERENCE_VALUE.test(lookup.value)) return lookup.ecli ?? lookup.celex ?? lookup.value;
  return lookup.value;
}

/**
 * Recognises a value that describes no document — the back-reference spellings, which mean
 * something only in the footnote they were written in. Matched here rather than flagged by
 * the caller so the resolver stays a standalone service that trusts nothing it is told.
 */
const BACK_REFERENCE_VALUE = /^\s*(?:ibidem|ibid|idem|id)\b\.?\s*$|^\s*(?:supra|above)\b/i;

export type ResolverOptions = {
  fetcher?: typeof fetch;
  /** Minimum time between EUR-Lex/CELLAR requests. */
  minRequestIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  cellarBaseUrl?: string;
  /**
   * How this client identifies itself to CELLAR. An unidentified caller is the fingerprint
   * anti-bot protection reacts to, and Node's `fetch` sends `User-Agent: node` unless told
   * otherwise — which is precisely that. The Publications Office asks callers of its SPARQL
   * endpoint for a descriptive agent naming the application, and the same courtesy applies
   * to the REST interface: it is the difference between a recognisable tool and anonymous
   * traffic, and it gives them somebody to contact instead of a reason to block.
   *
   * Set `IBID_USER_AGENT` in production so it carries a real contact address.
   */
  userAgent?: string;
  /**
   * Which language to retrieve, in order of preference. CELLAR answers `404` for a language
   * a document was never published in, so this is a genuine fallback chain rather than a
   * hint: English first because the pane is in English, French next because that is the
   * language this tool's users draft in and the Court's own working language.
   */
  preferredLanguages?: SourceLanguage[];
  /**
   * Translates a passage into English. Optional, and absent by default: without it a
   * French-only document is shown in French and labelled as such, which is honest. With it,
   * the excerpt is translated and marked as a translation alongside a link to the authentic
   * text. Server-side only — it is given document text, not user credentials.
   */
  translate?: (text: string, from: SourceLanguage) => Promise<string>;
  /** Server-side credentials only; never pass these to the Word client. */
  eurLexHeaders?: Record<string, string>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

function decodeHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Finds the raw-HTML heading that anchors a cited article, recital, or
 * judgment point, and extracts from there to the next such heading.
 *
 * This must run on the *raw* HTML, before `decodeHtml` strips tags, and it
 * must anchor on a heading element — not search decoded running text for the
 * number as a bare substring. EU legislative preambles routinely reference an
 * article or recital number in passing before the provision itself appears
 * ("...the measures referred to in Article 15(1)..." inside a recital, well
 * before the actual "Article 15" heading) — a first-match substring search
 * picks up that passing reference and silently shows the wrong passage, with
 * no error. Confirmed against real documents: Directive 2002/58/EC's decoded
 * text contains "Article 15" four times before the real heading.
 *
 * Each `pattern` must capture the heading's own number in group 1 and match
 * only true headings, not inline references — verified against real markup:
 *  - Legislative article heading: the whole paragraph is just "Article N"
 *    (`<p id="..." class="oj-ti-art">Article 15</p>`, or plain `<p>Article 15</p>`
 *    in older documents) — an inline reference always has other text in the
 *    same paragraph, so requiring nothing else present rules it out.
 *  - Legislative recital: "(N)" appears immediately after the paragraph opens
 *    (`<p class="oj-normal">(1)</p>` with the text in a following paragraph
 *    in newer documents; `<p>(1) Directive 95/46/EC ...` with the text in the
 *    same paragraph in older ones) — an inline footnote-style marker like
 *    "...Commission(1)," is never immediately preceded by a `<p>` open tag.
 *  - Judgment point (modern, 2010s+): `<p class="count" id="point57">57</p>`.
 *  - Judgment point (CURIA-native rendering, used for some very recent
 *    judgments not yet migrated to the above): the number is a same-value
 *    anchor name at the start of the numbered-point paragraph,
 *    `<P class="C01PointnumeroteAltN"><A NAME="point87">87</A>text...`.
 *  - Judgment point (legacy, ~1990s–2000s): a definition-term/definition-data
 *    pair holding just the number, text following outside it,
 *    `<dt>128<dd></dd></dt>text...`.
 */
/**
 * `through` extends the slice to the end of a cited range rather than stopping at the first
 * boundary after its start. A citation to "paras 57-65" is a citation to nine paragraphs,
 * and returning only paragraph 57 gives the lawyer the opening of an argument without the
 * argument — while the pane's own locator label says "Point 57-65", so the excerpt and the
 * label contradicted each other on screen.
 *
 * The scan stops at the first anchor numbered *beyond* the range, not at a specific closing
 * number, so a range whose final paragraph is absent or renumbered still terminates at the
 * right place instead of running to the safety cap.
 */
type SliceRange = { through?: number; maxLength?: number };

function sliceByHeadingAnchor(html: string, pattern: RegExp, targetNumber: number, range: SliceRange = {}): string | undefined {
  const last = Math.max(range.through ?? targetNumber, targetNumber);
  // The cap scales with the span asked for: one paragraph's worth of raw markup is no use
  // when nine were cited, and truncating mid-range is what this exists to stop.
  const maxLength = range.maxLength ?? Math.min(60_000, 6_000 * (last - targetNumber + 1));
  let start = -1;
  let end = html.length;
  for (const match of html.matchAll(pattern)) {
    const number = Number(match[1]);
    if (start < 0) {
      if (number === targetNumber) start = match.index;
      continue;
    }
    if (number > last) { end = match.index; break; }
  }
  if (start < 0) return undefined;
  return html.slice(start, Math.min(end, start + maxLength));
}

const ARTICLE_HEADING = /<p[^>]*>\s*Article\s+(\d+)\s*<\/p>/gi;
const RECITAL_HEADING = /<p[^>]*>\s*\(\s*(\d+)\s*\)/gi;

/**
 * A numbered paragraph within an already-isolated article. "Art. 8(5)" means
 * paragraph 5 of Article 8, not the whole article — confirmed live that both
 * markup eras place the paragraph number directly at the start of its own
 * `<p>`, followed by a period, even though nothing else about their
 * structure matches: modern OJ markup (`<p class="oj-normal">1.   text`,
 * GDPR Article 8) and legacy markup (`<p>1. text`, Directive 2002/58/EC
 * Article 15).
 */
const ARTICLE_PARAGRAPH_HEADING = /<p[^>]*>\s*(\d+)\.\s/gi;

/**
 * Tried in order; the first pattern that anchors the target point number
 * wins. Several real, distinct markup conventions across document eras were
 * found live, in one round of testing against real client citations — this
 * is deliberately a list to try, not a single assumed format, because a
 * fifth convention turning up would not be surprising.
 */
const JUDGMENT_POINT_HEADINGS = [
  /<p[^>]*\bid="point(\d+)"[^>]*>/gi,
  // Any paragraph class carrying a named point anchor, not one exact class name. The
  // original pattern pinned `C01PointnumeroteAltN`, taken from a judgment; Advocate General
  // opinions in the same era use the sibling class `C01PointAltN` and write the number with
  // a trailing period (`<A NAME="point60">60.</A>`), so the cited point was never found and
  // the excerpt silently fell back to the document's opening. Confirmed against AG Kokott's
  // opinion in Akzo Nobel (62007CC0550). `NAME=` is what makes this safe to generalise: a
  // cross-reference to a point is an `HREF="#pointN"`, never a `NAME`.
  /<P[^>]*class="[^"]*Point[^"]*"[^>]*>\s*<A[^>]*\bNAME="point(\d+)"[^>]*>/gi,
  /<dt>\s*(\d+)\s*<dd>\s*<\/dd>\s*<\/dt>/gi,
];

/**
 * Groups cited paragraphs into the contiguous spans they actually form: [40,41,42,44] is
 * two spans, not four lookups. Each span is one slice of the document, which keeps a range
 * whole and a gap visible.
 */
function contiguousRuns(paragraphs: readonly number[]): Array<{ from: number; to: number }> {
  const sorted = [...new Set(paragraphs)].sort((a, b) => a - b);
  const runs: Array<{ from: number; to: number }> = [];
  for (const number of sorted) {
    const last = runs.at(-1);
    if (last && number === last.to + 1) last.to = number;
    else runs.push({ from: number, to: number });
  }
  return runs;
}

/** The single-anchor view of a citation, for callers that send no paragraph list. */
function expandRange(start: number, end?: number): number[] {
  if (!end || end <= start) return [start];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/** Bounds a pathological citation ("paras 1 to 400") without truncating an ordinary one. */
const MAX_RUNS = 8;
const MAX_EXCERPT = 20_000;

/**
 * Extracts every span the citation names, in order, with the gaps marked.
 *
 * A citation to "paras 62 and 65" is a citation to two paragraphs that the drafter chose
 * deliberately and separately; returning 62 alone, or 62 through 65 as though the
 * intervening text had been cited, are both misrepresentations of what was written. The
 * ellipsis is what distinguishes them on screen.
 */
function extractCitedRuns(html: string, pattern: RegExp, paragraphs: readonly number[]): string | undefined {
  const runs = contiguousRuns(paragraphs).slice(0, MAX_RUNS);
  const passages: string[] = [];
  for (const run of runs) {
    const raw = sliceByHeadingAnchor(html, pattern, run.from, { through: run.to });
    if (raw) passages.push(decodeHtml(raw).trim());
  }
  if (!passages.length) return undefined;
  return passages.join('\n\n…\n\n').slice(0, MAX_EXCERPT);
}

function extractLegislativeLocator(html: string, locator?: EuLookup['locator'], paragraphs?: number[]): string {
  if (!locator) return decodeHtml(html).slice(0, 900);
  if (locator.kind !== 'article') {
    return extractCitedRuns(html, RECITAL_HEADING, paragraphs?.length ? paragraphs : [locator.start])
      ?? decodeHtml(html).slice(0, 900);
  }

  // A generous cap here only bounds a safety limit on raw HTML scanned, not the
  // excerpt shown — articles with many paragraphs carry a lot of markup overhead
  // before reaching a later paragraph, so this must stay well above the final
  // excerpt-length cap applied below.
  const articleHtml = sliceByHeadingAnchor(html, ARTICLE_HEADING, locator.start, { through: locator.end, maxLength: 20_000 });
  if (!articleHtml) return decodeHtml(html).slice(0, 900);
  if (locator.paragraph) {
    const paragraphHtml = sliceByHeadingAnchor(articleHtml, ARTICLE_PARAGRAPH_HEADING, locator.paragraph, { maxLength: 3_000 });
    if (paragraphHtml) return decodeHtml(paragraphHtml).trim();
  }
  return decodeHtml(articleHtml).slice(0, 6_000).trim();
}

function extractJudgmentPoint(html: string, lookup: EuLookup): string {
  const locator = lookup.locator;
  if (!locator || locator.kind !== 'point') return decodeHtml(html).slice(0, 900);
  // The paragraph list is authoritative where the caller supplied one; `locator` is the
  // single-anchor view of the same citation, kept for callers that send nothing else.
  const cited = lookup.paragraphs?.length ? lookup.paragraphs : expandRange(locator.start, locator.end);
  for (const pattern of JUDGMENT_POINT_HEADINGS) {
    const result = extractCitedRuns(html, pattern, cited);
    if (result) return result;
  }
  return decodeHtml(html).slice(0, 900);
}

/**
 * CELLAR can answer with HTTP 200 for a bot-verification interstitial page
 * instead of the document — observed live, not hypothetical. `response.ok`
 * does not catch this: the request genuinely succeeded, just not with a
 * document. Anything that fails this check must not be decoded and shown as
 * if it were the source text.
 *
 * Real CELLAR documents have turned out to use at least four distinct markup
 * conventions across document era and family (see JUDGMENT_POINT_HEADINGS),
 * and enumerating every one specifically has not converged — a further
 * undiscovered convention would not be surprising. Two fast, specific
 * positive signals are checked first (both confirmed live, neither present
 * in the other's response, so no cross-contamination risk):
 *  - Newer `application/xhtml+xml` documents (2010s onward): a generator
 *    comment, `<!-- CONVEX ... -->` or `<!-- fmx2xhtml ... -->`.
 *  - Older `text/html`-only legislation (e.g. Directive 2002/58/EC, 2002,
 *    which has no `application/xhtml+xml` rendition at all — see
 *    `fetchCellarDocument`): a `<meta name="DC.title" content="EUR-Lex - …">`
 *    Dublin Core tag instead; these predate the newer converter pipeline.
 * As a general fallback beyond those two, real documents run from tens of KB
 * (plain older markup) to hundreds of KB (modern XHTML) once actual legal
 * text is included; every bot-verification page observed or constructed for
 * testing was well under 1 KB. A substantial response is accepted even
 * without a recognised marker, rather than risk rejecting a genuine document
 * in a convention not yet catalogued here.
 */
function looksLikeCellarDocument(html: string): boolean {
  if (/<!--\s*(?:CONVEX|fmx2xhtml)\b/i.test(html)) return true;
  if (/<meta\s+name="DC\.title"\s+content="EUR-Lex\b/i.test(html)) return true;
  return html.length > 2_000;
}

/**
 * What the excerpt below it is showing. Built from the paragraphs actually cited, so a
 * disjoint citation reads "Points 62 and 65" rather than implying the span between them —
 * the label and the excerpt have to describe the same thing.
 */
function locatorLabel(lookup: EuLookup): string | undefined {
  const locator = lookup.locator;
  if (!locator) return undefined;
  if (locator.kind === 'article') return `Article ${locator.start}${locator.paragraph ? `(${locator.paragraph})` : ''}${locator.end ? `–${locator.end}` : ''}`;

  const runs = contiguousRuns(lookup.paragraphs?.length ? lookup.paragraphs : expandRange(locator.start, locator.end));
  const parts = runs.map((run) => (run.from === run.to ? `${run.from}` : `${run.from}–${run.to}`));
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${runs.length === 1 && runs[0].from === runs[0].to ? 'Point' : 'Points'} ${listed}`;
}

function cellarUrl(celex: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(celex)}`;
}

function curiaUrl(lookup: EuLookup): string {
  // CURIA's case-number search is its stable, official case record entry point.
  const query = lookup.caseNumber ?? lookup.ecli ?? lookup.value;
  return `https://curia.europa.eu/juris/liste.jsf?language=en&num=${encodeURIComponent(query)}`;
}

function commissionUrl(lookup: EuLookup): string {
  return `https://competition-cases.ec.europa.eu/search?query=${encodeURIComponent(lookup.value)}`;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  return Math.min(8_000, 400 * 2 ** attempt);
}

export function createApiHealthCheck() { return { status: 'ok' as const }; }

/**
 * Resolves each official-source family through a deliberately small adapter.
 * EUR-Lex/CELLAR mirrors most CJEU/General Court judgments under their own
 * CELEX identifiers, so CURIA citations attempt the same fetch when the CELEX
 * is confidently a judgment's; any failure — including the citation actually
 * being an opinion or order, or an older case CELLAR does not mirror — falls
 * back to the direct, always-available official CURIA case-record link.
 * Commission records are always linked directly: there is no equivalent
 * machine-fetchable mirror, so a changing search-result page cannot be
 * mistaken for a source.
 */
export function createEuSourceResolver(options: ResolverOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const preferredLanguages = options.preferredLanguages?.length ? options.preferredLanguages : (['en', 'fr'] as SourceLanguage[]);
  const minRequestIntervalMs = options.minRequestIntervalMs ?? 1_000;
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const cellarBaseUrl = options.cellarBaseUrl ?? 'https://publications.europa.eu/resource/celex';
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const cache = new Map<string, SourcePreview>();
  let nextRequestAt = 0;

  async function fetchEurLex(url: string, accept: string, language: SourceLanguage): Promise<Response> {
    const wait = nextRequestAt - now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = now() + minRequestIntervalMs;

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(url, {
          headers: { Accept: accept, 'Accept-Language': CELLAR_LANGUAGE[language], 'User-Agent': userAgent, ...options.eurLexHeaders },
          signal: controller.signal,
        });
        if (response.ok || (response.status !== 429 && response.status < 500) || attempt >= maxRetries) return response;
        await sleep(retryDelay(response, attempt));
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        await sleep(retryDelay(undefined, attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * CELLAR does not offer every document in every format. Confirmed live:
   * recent documents (e.g. the GDPR, 2016) are only content-negotiated via
   * `application/xhtml+xml` (a `303` to the real document; `text/html` 404s
   * with "does not hold a content datastream of the requested type"). Older
   * documents (e.g. Directive 2002/58/EC, 2002) are the reverse — no
   * `application/xhtml+xml` rendition exists at all, only classic `text/html`
   * (plus PDF, not used here). There is no single Accept header that works
   * for both eras, so a `404` specifically — meaning this representation does
   * not exist, not a transient failure — falls through to the other one.
   * Any other status (429, 5xx, already retried by fetchEurLex) is a
   * different kind of problem that a different Accept header would not fix,
   * so it fails immediately rather than doubling up on a struggling server.
   */
  /**
   * Retrieves the document in the best available language, and says which it got.
   *
   * The language loop is outermost because a `404` means something different at each level:
   * across Accept headers it is a format the document does not have (older documents are
   * `text/html` only), and across languages it is a language it was never published in. Only
   * once every format has been refused for a language is that language genuinely absent.
   */
  async function fetchCellarDocument(url: string): Promise<{ html: string; language: SourceLanguage }> {
    let lastResponse: Response | undefined;
    for (const language of preferredLanguages) {
      for (const accept of ['application/xhtml+xml', 'text/html']) {
        const response = await fetchEurLex(url, accept, language);
        lastResponse = response;
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`EUR-Lex/CELLAR lookup failed (${response.status}).`);
        const html = await response.text();
        if (looksLikeCellarDocument(html)) return { html, language };
        // A 200 without a recognisable document body is CELLAR's bot-verification
        // page, not a format-availability issue — the other Accept header would
        // not help, and would cost another request against the same block.
        throw new Error('EUR-Lex/CELLAR did not return a recognisable document (possibly a bot-verification page).');
      }
    }
    throw new Error(`EUR-Lex/CELLAR lookup failed (${lastResponse!.status}).`);
  }

  async function resolveCellarPreview(celex: string, lookup: EuLookup, source: SourcePreview['source']): Promise<SourcePreview> {
    // Every part of the citation that changes the excerpt belongs in the key. The paragraph
    // list especially: "para. 62" and "paras 62 and 65" share a kind and a start, so keying
    // on those alone served one footnote's excerpt to the other — a passage the second
    // footnote never cited, shown as though it had.
    const key = [celex, lookup.locator?.kind ?? '', lookup.locator?.start ?? '',
      lookup.locator?.paragraph ?? '', lookup.locator?.end ?? '', (lookup.paragraphs ?? []).join('.')].join(':');
    const cached = cache.get(key);
    if (cached) return cached;

    const url = cellarUrl(celex, cellarBaseUrl);
    const { html, language } = await fetchCellarDocument(url);

    // Judgments and legislative acts use different paragraph-numbering
    // markup (see sliceByHeadingAnchor), so they need different extraction —
    // both run on the raw HTML, before it is decoded.
    const base: SourcePreview = source === 'CURIA'
      ? { title: describeDocument(lookup), excerpt: extractJudgmentPoint(html, lookup), url, source, locator: locatorLabel(lookup), language }
      : {
          // Legislation states its own title in the document, which beats anything derived
          // from the citation; the derived name is the fallback when extraction comes up empty.
          title: decodeHtml(html).slice(0, 260).split('Official Journal')[0].trim() || describeDocument(lookup),
          excerpt: extractLegislativeLocator(html, lookup.locator, lookup.paragraphs), url, source, locator: locatorLabel(lookup), language,
        };
    const preview = await translateIfNeeded(base);
    cache.set(key, preview);
    return preview;
  }

  /**
   * Renders a passage in English when the document itself is not.
   *
   * Only reached when the document was never published in English — the language chain has
   * already preferred the authentic English text wherever one exists, and a real translation
   * by the Court always beats a machine's. When no translator is configured the French is
   * shown as it stands and labelled; showing it unlabelled, as though it were what was
   * asked for, is the one thing that must not happen.
   *
   * A failure here is not a retrieval failure. The published text is in hand and is worth
   * more than nothing, so a translator that errors or times out degrades to the French.
   */
  async function translateIfNeeded(preview: SourcePreview): Promise<SourcePreview> {
    const from = preview.language;
    if (!options.translate || !from || from === 'en' || !preview.excerpt.trim()) return preview;
    try {
      const translated = await options.translate(preview.excerpt, from);
      if (!translated.trim()) return preview;
      return { ...preview, excerpt: translated, language: 'en', translation: { from, officialUrl: preview.url } };
    } catch {
      return preview;
    }
  }

  async function resolveEurLex(lookup: EuLookup): Promise<SourcePreview[]> {
    if (!lookup.celex) return [];
    return [await resolveCellarPreview(lookup.celex, lookup, 'EUR-Lex')];
  }

  function resolveCuriaLink(lookup: EuLookup): SourcePreview {
    const locator = locatorLabel(lookup);
    return { title: describeDocument(lookup), source: 'CURIA', url: curiaUrl(lookup), locator,
      excerpt: `Open the official CURIA case record${locator ? ` and inspect ${locator.toLowerCase()}` : ''}.` };
  }

  async function resolveCuria(lookup: EuLookup): Promise<SourcePreview[]> {
    const celex = lookup.celex;
    // Any CELEX that reaches here names the document that was cited, whatever kind it is:
    // the sector is derived from the document type, so an Advocate General's opinion gets
    // its own `CC` CELEX and an order its `CO`/`TO`. This used to refuse to fetch anything
    // but a judgment, because only the judgment sector was ever derived and the CELEX would
    // otherwise have named a different document — a limitation of the derivation rather
    // than of what CELLAR holds. Confirmed live: opinions and orders retrieve normally and
    // carry the same `id="pointN"` paragraph markup judgments do.
    if (celex) {
      try {
        return [await resolveCellarPreview(celex, lookup, 'CURIA')];
      } catch {
        // EUR-Lex does not mirror every document (older cases in particular);
        // the direct CURIA case record remains a safe, always-available fallback.
        return [resolveCuriaLink(lookup)];
      }
    }
    return [resolveCuriaLink(lookup)];
  }

  function resolveCommission(lookup: EuLookup): SourcePreview[] {
    const locator = locatorLabel(lookup);
    return [{ title: describeDocument(lookup), source: 'European Commission', url: commissionUrl(lookup), locator,
      excerpt: `Open the European Commission case register to inspect the published decision and related documents${locator ? `, focusing on ${locator.toLowerCase()}` : ''}.` }];
  }

  return {
    async resolve(lookup: EuLookup): Promise<SourcePreview[]> {
      if (lookup.source === 'curia') return resolveCuria(lookup);
      if (lookup.source === 'commission') return resolveCommission(lookup);
      return resolveEurLex(lookup);
    },
    clearCache() { cache.clear(); },
  };
}

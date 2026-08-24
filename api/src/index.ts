import { createMemoryDocumentStore, type DocumentStore, type StoredDocument } from './document-store.ts';

export { createFileDocumentStore, createMemoryDocumentStore, defaultCacheDirectory } from './document-store.ts';
export type { DocumentStore, StoredDocument } from './document-store.ts';

export { createStaticFiles, contentTypeFor, resolveWithinRoot } from './static-files.ts';
export type { StaticAsset } from './static-files.ts';

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
  /**
   * Whether `excerpt` is the passage `locator` names, or the document's opening shown in
   * its place because that passage could not be found in the retrieved text. Absent where
   * the citation pinpointed nothing, so there was never a passage to find.
   *
   * Every point-anchor convention this resolver knows was added after meeting a document
   * that used none of the ones already catalogued, so `'opening'` is a state it can go on
   * arriving in rather than a bug on its way to being finished. What must not happen is a
   * lawyer reading a judgment's catchwords under a heading naming paragraph 46.
   */
  passage?: 'cited' | 'opening';
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
  /**
   * When this text was last confirmed to be what EUR-Lex holds, as an ISO timestamp.
   *
   * Present on any preview whose text came from CELLAR, whether it was downloaded just now
   * or served from cache and revalidated. Those two are deliberately not distinguished:
   * a `304` means the stored bytes are the current official text, which is the same
   * statement a `200` makes, and the pane says so as a plain fact rather than as a warning
   * about a cache. Absent on the link-only previews (CURIA case record, Commission
   * register), which retrieve no text and so confirm nothing.
   */
  verifiedAt?: string;
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
  /**
   * Where retrieved CELLAR documents are kept between lookups, and — if the store persists
   * them — between restarts.
   *
   * Defaults to a bounded in-process store, so importing this resolver never writes to a
   * disk the caller did not ask it to write to. `api/server.mjs` supplies the file-backed
   * one, which is where persistence is opted into.
   */
  documentStore?: DocumentStore;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
};

/**
 * Entities are decoded in one pass, and numerically as well as by name.
 *
 * `&#039;` is the spelling CELLAR's older renditions use for an apostrophe — every
 * `d&#039;assurances` in a 2002 judgment — and the previous pass matched only the
 * zero-less `&#39;`, so the entity reached the pane as its own source text inside the
 * quoted passage. One pass rather than several also means a document that writes `&amp;`
 * before something entity-shaped is decoded once instead of twice.
 *
 * An unrecognised name is left exactly as it stands: showing `&sect;` is a small blemish,
 * and silently dropping a character out of a passage a lawyer is about to rely on is not.
 */
function decodeHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
      if (decimal || hex) {
        const code = Number(decimal ?? `0x${hex}`);
        // A code point outside Unicode is a malformed document, not a character: leaving the
        // entity as written beats throwing out of an excerpt that is otherwise fine.
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, ' ').trim();
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

/** The two renditions CELLAR serves, in the order to try when nothing is known about an era. */
const CELLAR_FORMATS = ['application/xhtml+xml', 'text/html'] as const;

/**
 * The combination a document is actually held under: what CELLAR was asked for, and in
 * which language. Both are part of the cache key, because both change the bytes returned.
 */
type Rendition = { language: SourceLanguage; accept: string };

/**
 * How CELLAR is being asked for a document: by which identifier, at which URL, and the
 * year that identifier carries (which is what the rendition memo is keyed on).
 */
type CellarTarget = { id: string; url: string; year: string };

function documentKey(target: CellarTarget, rendition: Rendition): string {
  return `${target.id}:${rendition.language}:${rendition.accept}`;
}

/**
 * The ECLI's year segment: `ECLI:EU:T:2024:431` is 2024. Only used to pick which rendition
 * to try first, so a malformed ECLI costs one wrong guess rather than anything worse.
 */
function ecliYear(ecli: string): string {
  return ecli.split(':')[3] ?? '';
}

/**
 * CELLAR answers two different `404`s, and they mean opposite things. Confirmed live
 * (2026-08-21), both with an ordinary `404` status and only the body to tell them apart:
 *
 *   Resource [system 'celex' - id '62023CJ0639'] not found.
 *   None of the requests returned successfully a redirection. The following exception was
 *   thrown: [cellar identifier cellar:99d7f858-… does not hold a content datastream of the
 *   requested type]
 *
 * The first says CELLAR has never heard of this identifier: no Accept header and no
 * language will ever produce it, so continuing to ask is four round trips spent proving
 * something the first one already said. The second says the document exists and this
 * particular rendition of it does not — which is exactly the case the format and language
 * chains exist for.
 *
 * That distinction is worth more than either chain. A citation CELLAR does not mirror is
 * common in real documents (six of 196 identifiers in the corpus run), and it is the case
 * where the reviewer waits longest, because every attempt is spent on the way to the CURIA
 * link rather than on the way to an answer.
 *
 * Matched loosely, and unrecognised `404` bodies keep the old behaviour of trying the next
 * rendition: if the Publications Office rewords this, the cost is the four requests that
 * were being paid anyway, not a document wrongly declared missing.
 */
const NO_SUCH_DOCUMENT = /\bResource\b[\s\S]{0,160}?\bnot found\b/i;

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
  // Legacy EUR-Lex "TexteOnly" rendering, where a numbered point has no anchor, no class
  // and no wrapper of any kind: the number simply opens the paragraph, `<p>46 According to
  // settled case-law...`. Confirmed live against Wouters and Others (61999CJ0309, 2002,
  // which CELLAR holds only as `text/html`) — the judgment the pane was showing the
  // catchwords of instead of the cited paragraph. Last of the four because it is the
  // loosest: it is a shape, not a marker.
  //
  // Requiring running text after the number — not whitespace, and not the next tag — is
  // what keeps it out of the way of the conventions above, whose anchors hold the number
  // alone and close immediately (`<p class="count" id="point57">57</p>`),
  // and a period after it belongs to legislative numbering (`<p>1. text`), which is a
  // different structure read by ARTICLE_PARAGRAPH_HEADING. Recitals are parenthesised.
  /<p[^>]*>\s*(\d+)\s+(?=[^\s<])/gi,
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
 * How many derived excerpts to keep. Small objects — an excerpt is capped at 20KB and most
 * are a fraction of that — and they are cheap to rebuild from a document that is itself
 * cached, so this only has to stop unbounded growth, not conserve anything.
 */
const MAX_CACHED_PREVIEWS = 512;

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

/**
 * An excerpt, and whether it is the passage that was cited.
 *
 * The document opening is the honest last resort when a pinpoint cannot be found — a
 * judgment's opening names the parties and what the case was about, which is worth more
 * than an empty panel — but it is not what the reviewer asked for, and nothing downstream
 * could previously tell the two apart. Unlabelled, it puts the catchwords of a judgment on
 * screen under a citation naming paragraph 46, which is the failure this whole tool exists
 * to prevent: something that looks exactly like an answer.
 *
 * `passage` is absent where the citation pinpointed nothing at all. Then the opening is
 * simply what there is to show, and there is nothing to admit.
 */
type Excerpt = { excerpt: string; passage?: 'cited' | 'opening' };

/** The opening of the document, marked as the fallback it is. */
function documentOpening(html: string, cited: boolean): Excerpt {
  const excerpt = decodeHtml(html).slice(0, 900);
  return cited ? { excerpt, passage: 'opening' } : { excerpt };
}

function extractLegislativeLocator(html: string, locator?: EuLookup['locator'], paragraphs?: number[]): Excerpt {
  if (!locator) return documentOpening(html, false);
  if (locator.kind !== 'article') {
    const recitals = extractCitedRuns(html, RECITAL_HEADING, paragraphs?.length ? paragraphs : [locator.start]);
    return recitals ? { excerpt: recitals, passage: 'cited' } : documentOpening(html, true);
  }

  // A generous cap here only bounds a safety limit on raw HTML scanned, not the
  // excerpt shown — articles with many paragraphs carry a lot of markup overhead
  // before reaching a later paragraph, so this must stay well above the final
  // excerpt-length cap applied below.
  const articleHtml = sliceByHeadingAnchor(html, ARTICLE_HEADING, locator.start, { through: locator.end, maxLength: 20_000 });
  if (!articleHtml) return documentOpening(html, true);
  if (locator.paragraph) {
    const paragraphHtml = sliceByHeadingAnchor(articleHtml, ARTICLE_PARAGRAPH_HEADING, locator.paragraph, { maxLength: 3_000 });
    if (paragraphHtml) return { excerpt: decodeHtml(paragraphHtml).trim(), passage: 'cited' };
  }
  // The article was found and a numbered sub-paragraph within it was not, so this is the
  // cited provision shown whole rather than a different part of the document: a wider
  // answer to the question asked, not an answer to another one.
  return { excerpt: decodeHtml(articleHtml).slice(0, 6_000).trim(), passage: 'cited' };
}

function extractJudgmentPoint(html: string, lookup: EuLookup): Excerpt {
  const locator = lookup.locator;
  if (!locator || locator.kind !== 'point') return documentOpening(html, false);
  // The paragraph list is authoritative where the caller supplied one; `locator` is the
  // single-anchor view of the same citation, kept for callers that send nothing else.
  const cited = lookup.paragraphs?.length ? lookup.paragraphs : expandRange(locator.start, locator.end);
  for (const pattern of JUDGMENT_POINT_HEADINGS) {
    const result = extractCitedRuns(html, pattern, cited);
    if (result) return { excerpt: result, passage: 'cited' };
  }
  return documentOpening(html, true);
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

/**
 * The same CELLAR service, addressed by ECLI instead of by CELEX.
 *
 * Built the same way and with the same guarantee: a fixed base from environment
 * configuration plus `encodeURIComponent`, so the identifier cannot introduce `/`, `:`,
 * `?` or `#` and therefore cannot leave the path segment, change the host, or append a
 * query. The colons in an ECLI are percent-encoded, which is what CELLAR expects.
 *
 * Returns `undefined` when no ECLI base can be derived from the configured CELEX base —
 * the fallback is then simply not attempted, rather than a URL being guessed at.
 */
function ecliUrl(ecli: string, baseUrl: string): string | undefined {
  const base = baseUrl.replace(/\/$/, '');
  const ecliBase = base.replace(/\/celex$/i, '/ecli');
  if (ecliBase === base) return undefined;
  return `${ecliBase}/${encodeURIComponent(ecli)}`;
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
  const documentStore = options.documentStore ?? createMemoryDocumentStore();
  /**
   * Excerpts, keyed by the citation that asked for one.
   *
   * This is now a cache of *work*, not of retrieval: the document behind it is held
   * separately by `documentStore`, and every excerpt here was cut out of one locally. Two
   * footnotes citing paragraph 62 and paragraph 65 of the same judgment are two entries
   * here and one download, where they used to be two downloads — that is the split.
   *
   * Bounded, unlike the map it replaces. This process is meant to run for months and part
   * of the key is caller-supplied; an unbounded map of previews was a weakness this
   * repository had already written down against itself (`docs/DATA-FLOW.md`).
   */
  const previewCache = new Map<string, SourcePreview>();
  /**
   * Which rendition documents of a given year turned out to have.
   *
   * CELLAR holds recent documents as xhtml only and older ones as classic html only, and
   * publishes no boundary between the two eras, so every lookup of an older document paid
   * for a 404 and then waited out the politeness interval before the request that worked —
   * two round trips and a full second of contrived delay, on a decision whose footnotes are
   * mostly older case law. Rather than invent a cutoff year, the resolver remembers what
   * answered for that year and asks for it first next time. Being wrong costs exactly what
   * every lookup costs today, and corrects itself on the next document of the same era.
   */
  const formatByYear = new Map<string, string>();
  let nextRequestAt = 0;
  let wire: Promise<unknown> = Promise.resolve();

  /**
   * One logical lookup's turn at the wire.
   *
   * The politeness interval is about the shape of this client's traffic against a public
   * service — one document at a time, spaced, never in parallel. It was being charged
   * per *request* instead, which made it the largest single component of a cold lookup:
   * measured live, a wrong-Accept `404` costs ~165ms and the interval stacked in front of
   * the retry that works costs 1,000ms, so ~74% of the wait was self-inflicted delay in
   * front of a probe that is not the traffic anyone needs protecting from.
   *
   * So the interval now spaces *lookups*. Everything one lookup does — probing the two
   * renditions, falling through a language, revalidating what is already held — happens
   * inside a single slot, and the next lookup waits a full interval after it. The volume
   * of traffic CELLAR sees per unit time is unchanged; what changed is that the delay is
   * no longer multiplied by however many attempts a single document happened to need.
   *
   * Serial by construction, which the previous version only approximated: it reserved the
   * next slot before awaiting, so starts were spaced but two lookups could still be in
   * flight together. Requests to CELLAR are deliberately never parallelised — a burst of
   * concurrent connections is the fingerprint anti-bot protection reacts to, and this tool
   * gains nothing by being one.
   */
  function onTheWire<T>(work: () => Promise<T>): Promise<T> {
    const run = wire.then(async () => {
      const wait = nextRequestAt - now();
      if (wait > 0) await sleep(wait);
      try {
        return await work();
      } finally {
        nextRequestAt = now() + minRequestIntervalMs;
      }
    });
    wire = run.then(() => undefined, () => undefined);
    return run;
  }

  async function fetchEurLex(url: string, rendition: Rendition, conditional: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(url, {
          headers: {
            Accept: rendition.accept,
            'Accept-Language': CELLAR_LANGUAGE[rendition.language],
            'User-Agent': userAgent,
            ...conditional,
            ...options.eurLexHeaders,
          },
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
   * The renditions to try, in order.
   *
   * The language loop is outermost because a `404` means something different at each level:
   * across Accept headers it is a format the document does not have (older documents are
   * `text/html` only), and across languages it is a language it was never published in.
   * Only once every format has been refused for a language is that language genuinely
   * absent.
   *
   * The language chain is a real fallback and not a preference — verified live, again, on
   * 2026-08-21: `Accept-Language: gle` returns `404` for both a directive and a judgment,
   * because neither was published in Irish. A request that appears to contradict this
   * (`Accept-Language: mlt` returning a Maltese judgment with `200`) is CELLAR answering
   * correctly: CJEU judgments are translated into every official language *except* Irish,
   * so Maltese genuinely exists for that document.
   *
   * That last point is also what the chain costs for case law: nothing, and nothing gained.
   * English exists for every judgment CELLAR mirrors — confirmed across 1962, 1964 and 2014
   * judgments — so French is only ever reached for a document CELLAR does not hold at all,
   * where it 404s too. Those are precisely the lookups `NO_SUCH_DOCUMENT` now ends after
   * one request, so the chain no longer has a case in which it costs anything. It stays for
   * legislation, where a French-only document is real.
   */
  function renditionsFor(year: string): Rendition[] {
    const remembered = formatByYear.get(year);
    const formats = remembered
      ? [remembered, ...CELLAR_FORMATS.filter((format) => format !== remembered)]
      : [...CELLAR_FORMATS];
    return preferredLanguages.flatMap((language) => formats.map((accept) => ({ language, accept })));
  }

  /**
   * A document in hand, and when it was last confirmed to be what EUR-Lex holds.
   *
   * `verifiedAt` is the point of the whole exercise. A cached copy of a legal text is a
   * liability; a cached copy that has just been confirmed against the issuing authority is
   * the official text with a timestamp on it. The two differ by one conditional request.
   */
  /**
   * `url` is the address the document actually came from, which is not always the one built
   * from the CELEX: a document CELLAR holds only under its ECLI answers on the `/ecli` path,
   * and the CELEX URL for it `404`s. The preview links wherever the reader is told the text
   * came from, so this has to be the URL that answered rather than the one first tried.
   */
  type LoadedDocument = { html: string; language: SourceLanguage; verifiedAt: number; url: string };

  const BOT_PAGE = 'EUR-Lex/CELLAR did not return a recognisable document (possibly a bot-verification page).';

  async function acceptDocument(target: CellarTarget, key: string, rendition: Rendition, response: Response): Promise<LoadedDocument> {
    const html = await response.text();
    // A 200 without a recognisable document body is CELLAR's bot-verification page, not a
    // format-availability issue — the other Accept header would not help, and would cost
    // another request against the same block.
    if (!looksLikeCellarDocument(html)) throw new Error(BOT_PAGE);
    const verifiedAt = now();
    formatByYear.set(target.year, rendition.accept);
    await documentStore.set(key, {
      html,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      fetchedAt: verifiedAt,
    });
    return { html, language: rendition.language, verifiedAt, url: target.url };
  }

  /**
   * How a held document would be confirmed, or `undefined` if it cannot be.
   *
   * `If-None-Match` first because CELLAR's `ETag` is the stronger validator and the one it
   * always sends; `If-Modified-Since` is the fallback for a response that carried only a
   * `Last-Modified`. Both were confirmed live to produce a `304` with a zero-length body.
   */
  function conditionalHeaders(stored: StoredDocument): Record<string, string> | undefined {
    if (stored.etag) return { 'If-None-Match': stored.etag };
    if (stored.lastModified) return { 'If-Modified-Since': stored.lastModified };
    return undefined;
  }

  /**
   * Confirms a document already held, rather than downloading it again.
   *
   * CELLAR sends `Cache-Control: no-cache` with an `ETag` and a `Last-Modified` — cache
   * this freely, and check before you use it. That is exactly what a legal-source tool
   * wants: the saving is the entire body (CELLAR serves no compression, so a judgment is
   * 149KB on the wire every time), and what is given up is nothing, because the answer
   * still comes from EUR-Lex on every single lookup.
   *
   * Returns `undefined` when the held rendition can no longer be confirmed, which puts the
   * caller back to probing from scratch rather than serving text CELLAR has stopped
   * standing behind.
   */
  async function revalidate(
    target: CellarTarget, rendition: Rendition, key: string, stored: StoredDocument,
    conditional: Record<string, string>,
  ): Promise<LoadedDocument | undefined> {
    const response = await fetchEurLex(target.url, rendition, conditional);

    if (response.status === 304) {
      // Deliberately before any read of the body: a 304 has none. Running the
      // document-shape check on it would reject every revalidated document as
      // unrecognisable and send the reviewer to a link, having just been told by CELLAR
      // that the text already in hand is current.
      const verifiedAt = now();
      await documentStore.set(key, { ...stored, fetchedAt: verifiedAt });
      return { html: stored.html, language: rendition.language, verifiedAt, url: target.url };
    }
    if (response.ok) return acceptDocument(target, key, rendition, response);
    if (response.status === 404) {
      await documentStore.delete(key);
      return undefined;
    }
    throw new Error(`EUR-Lex/CELLAR lookup failed (${response.status}).`);
  }

  /**
   * Finds the rendition CELLAR actually holds, when nothing is held locally to confirm.
   *
   * Returns `undefined` when every rendition answered `404` — meaning this identifier
   * yields nothing, and the caller should try the next one it has. Any other status throws,
   * because a different identifier will not fix a server that is failing for another
   * reason: the same rule the rendition chain follows, applied one level up.
   */
  async function probeCellar(target: CellarTarget, renditions: readonly Rendition[]): Promise<LoadedDocument | undefined> {
    for (const rendition of renditions) {
      const response = await fetchEurLex(target.url, rendition);
      if (response.status === 404) {
        // CELLAR has never heard of this identifier: no other rendition of it can exist,
        // and the three remaining probes would only spell out what this one already said.
        if (NO_SUCH_DOCUMENT.test(await response.text().catch(() => ''))) return undefined;
        continue;
      }
      if (!response.ok) throw new Error(`EUR-Lex/CELLAR lookup failed (${response.status}).`);
      return acceptDocument(target, documentKey(target, rendition), rendition, response);
    }
    return undefined;
  }

  /**
   * Retrieves the document in the best available language, and says which it got.
   *
   * A document already held is confirmed in the rendition it was held under: one
   * conditional request, which also skips the format and language probing entirely, because
   * what is in the store is by definition the combination that worked last time.
   *
   * The store is consulted before any request slot is taken, so a document that needs no
   * network at all does not make the *next* lookup wait out a politeness interval for a
   * request that never happened. Where a request is needed, confirming and — if that fails
   * — probing both happen inside one slot: they are one lookup of one document, and item by
   * item is exactly how the interval used to be charged.
   *
   * Two identifiers are tried, in order, and the second one matters more than it looks.
   * The CELEX is *derived* — its sector letter comes from the document type, its year from
   * the case number — whereas the ECLI is quoted verbatim from the footnote. Where CELLAR
   * has never heard of the derived CELEX, asking it by the identifier the document itself
   * stated is not a guess at a different document; it is the same document under the name
   * its own court gave it.
   *
   * This is not a rare corner. Every one of the identifiers the corpus run recorded as
   * "unavailable" — recent orders of the President of the General Court and of the
   * Vice-President of the Court, and a 2005 judgment — resolves through the ECLI path,
   * confirmed live on 2026-08-21, while their derived CELEX returns "Resource … not found".
   * CELLAR appears simply not to mint a CELEX for some case-law documents it nonetheless
   * holds and indexes by ECLI.
   */
  function cellarTargets(celex: string, ecli: string | undefined): CellarTarget[] {
    // The CELEX carries its year directly after the sector digit: 61999J0309 is 1999.
    const targets: CellarTarget[] = [{ id: `celex:${celex}`, url: cellarUrl(celex, cellarBaseUrl), year: celex.slice(1, 5) }];
    const byEcli = ecli && ecliUrl(ecli, cellarBaseUrl);
    if (ecli && byEcli) targets.push({ id: `ecli:${ecli}`, url: byEcli, year: ecliYear(ecli) });
    return targets;
  }

  async function loadCellarDocument(celex: string, ecli?: string): Promise<LoadedDocument> {
    const targets = cellarTargets(celex, ecli);

    for (const target of targets) {
      for (const rendition of renditionsFor(target.year)) {
        const key = documentKey(target, rendition);
        const stored = await documentStore.get(key);
        if (!stored) continue;

        const conditional = conditionalHeaders(stored);
        // Held, with no validator to confirm it by. An EU legal text does not change — a
        // directive is amended by another instrument with its own CELEX, and a judgment is
        // never rewritten — so this is served rather than downloaded again, dated with the
        // last time it genuinely was confirmed rather than with now. Every real CELLAR
        // response carries an ETag, so this is the path for a store written by something
        // else, not the ordinary one.
        if (!conditional) return { html: stored.html, language: rendition.language, verifiedAt: stored.fetchedAt, url: target.url };

        return onTheWire(async () => {
          const confirmed = await revalidate(target, rendition, key, stored, conditional);
          return confirmed ?? probeEveryTarget(targets);
        });
      }
    }

    return onTheWire(() => probeEveryTarget(targets));
  }

  /** Each identifier in turn, until one of them yields the document. */
  async function probeEveryTarget(targets: readonly CellarTarget[]): Promise<LoadedDocument> {
    for (const target of targets) {
      const found = await probeCellar(target, renditionsFor(target.year));
      if (found) return found;
    }
    throw new Error('EUR-Lex/CELLAR lookup failed (404).');
  }

  /**
   * Every part of the citation that changes the excerpt belongs in this key. The paragraph
   * list especially: "para. 62" and "paras 62 and 65" share a kind and a start, so keying
   * on those alone served one footnote's excerpt to the other — a passage the second
   * footnote never cited, shown as though it had.
   *
   * What is deliberately *not* keyed this way any more is the document itself. This used to
   * be the retrieval key too, which meant paragraph 62 and paragraph 65 of one judgment
   * were two full downloads of the same 149KB — the same authority fetched once per
   * pinpoint that cited it. The document is keyed by what identifies a document (see
   * `documentKey`) and the excerpt is cut out of it locally, so a judgment cited twenty
   * times in a brief is retrieved once.
   */
  function previewKey(celex: string, lookup: EuLookup, source: SourcePreview['source']): string {
    return [celex, source, lookup.locator?.kind ?? '', lookup.locator?.start ?? '',
      lookup.locator?.paragraph ?? '', lookup.locator?.end ?? '', (lookup.paragraphs ?? []).join('.')].join(':');
  }

  function rememberPreview(key: string, preview: SourcePreview): void {
    previewCache.set(key, preview);
    // Insertion-ordered, so the first key is the oldest. One at a time is enough: entries
    // only ever arrive one at a time.
    if (previewCache.size > MAX_CACHED_PREVIEWS) {
      const oldest = previewCache.keys().next().value;
      if (oldest !== undefined) previewCache.delete(oldest);
    }
  }

  async function resolveCellarPreview(celex: string, lookup: EuLookup, source: SourcePreview['source']): Promise<SourcePreview> {
    const key = previewKey(celex, lookup, source);
    const cached = previewCache.get(key);
    if (cached) return cached;

    const { html, language, verifiedAt, url } = await loadCellarDocument(celex, lookup.ecli);

    // Judgments and legislative acts use different paragraph-numbering
    // markup (see sliceByHeadingAnchor), so they need different extraction —
    // both run on the raw HTML, before it is decoded.
    const base: SourcePreview = source === 'CURIA'
      ? { title: describeDocument(lookup), ...extractJudgmentPoint(html, lookup), url, source, locator: locatorLabel(lookup), language }
      : {
          // Legislation states its own title in the document, which beats anything derived
          // from the citation; the derived name is the fallback when extraction comes up empty.
          title: decodeHtml(html).slice(0, 260).split('Official Journal')[0].trim() || describeDocument(lookup),
          ...extractLegislativeLocator(html, lookup.locator, lookup.paragraphs), url, source, locator: locatorLabel(lookup), language,
        };
    const preview = await translateIfNeeded({ ...base, verifiedAt: new Date(verifiedAt).toISOString() });
    rememberPreview(key, preview);
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
    /**
     * Empties both caches: the derived excerpts, and the documents they were cut from.
     *
     * Synchronous for the caller's purposes — the in-memory layer of every store here is
     * cleared before the first `await` inside it — so a test or an operator can clear and
     * immediately expect the next lookup to reach the network.
     */
    clearCache() {
      previewCache.clear();
      void documentStore.clear();
    },
  };
}

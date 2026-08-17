export type EuSource = 'curia' | 'eur-lex' | 'commission';

/**
 * Only meaningful for `source: 'curia'`. `celex` is always derived as if the
 * citation were the main judgment (CJEU CELEX sectors distinguish judgments,
 * AG opinions, and orders); when context signals it is actually an opinion or
 * an order, that derived CELEX would name the wrong document, so callers must
 * not use it to fetch or link to text and should fall back to the official
 * case-record search instead.
 */
export type CuriaDocumentType = 'judgment' | 'opinion' | 'order';

/**
 * Whether a citation names a document Ibid can actually go and fetch.
 *
 *  - `resolved` — an ECLI, case number, or CELEX is known for this span, either
 *    because the span states it or because the span was resolved back to a full
 *    citation stated earlier in the same document.
 *  - `unresolved_ambiguous` — the span is a short form that matches more than
 *    one candidate authority and the document contains nothing that picks
 *    between them. Deliberately never guessed at: a wrong citation shown with
 *    full confidence is worse than a flagged gap, so this is surfaced for the
 *    lawyer to confirm.
 *  - `unresolved_not_found` — the span reads like a short-form reference (a name
 *    carrying a pinpoint) but nothing in the document, and nothing in the
 *    frequent-case table, matches it.
 *  - `unconfirmed_suggestion` — the document itself says nothing about this span,
 *    but the frequent-case table proposes one authority. That is Ibid asserting
 *    outside knowledge, which is a different thing from reading the document, so
 *    it is offered as a suggestion to confirm rather than presented as
 *    established. The proposal is in `candidates`.
 *
 * Only `resolved` may carry an identifier. Every other status leaves `celex`,
 * `ecli`, and `caseNumber` undefined, so nothing downstream can fetch a document
 * on the strength of a guess — the identifiers live in `candidates` until a
 * person picks one.
 */
export type CitationStatus = 'resolved' | 'unresolved_ambiguous' | 'unresolved_not_found' | 'unconfirmed_suggestion';

/**
 * How a short form was tied back to a full citation, in descending confidence.
 * Absent on a citation that states its own identifier — nothing was resolved.
 * `user_confirmed` is set by the client when a reviewer picks a candidate.
 */
export type ResolutionMethod = 'explicit_alias' | 'generated_variant' | 'fallback_table' | 'user_confirmed';

/**
 * The single passage the source adapters narrow a fetched document to. This is
 * deliberately *not* the full pinpoint: a citation to "paras 40–44, 46 and 48"
 * is one retrieval anchored at 40, with the rest reported to the reader through
 * `pinpoint`.
 */
export type CitationLocator = { kind: 'point' | 'article'; start: number; paragraph?: number; end?: number };

/** Every paragraph the span actually pinpoints, ranges expanded. */
export type Pinpoint = { paragraphs: number[] };

/** One of the authorities a short form could be referring to; only populated for `unresolved_ambiguous`. */
export type CitationCandidate = {
  label: string;
  source: EuSource;
  caseName?: string;
  caseNumber?: string;
  celex?: string;
  ecli?: string;
  documentType?: CuriaDocumentType;
};

export type CitationMatch = {
  label: string;
  value: string;
  index: number;
  source: EuSource;
  status: CitationStatus;
  celex?: string;
  ecli?: string;
  caseNumber?: string;
  caseName?: string;
  documentType?: CuriaDocumentType;
  /**
   * True only when the text itself said so ("Judgment of 14 September 2010",
   * "Opinion of Advocate General …", "Order of …"). `documentType` otherwise
   * falls back to 'judgment', which is the right default for retrieval but is
   * an assumption, not a fact — an ECLI's ordinal segment is a per-court
   * sequential counter and encodes nothing about document type, so it is never
   * used to infer one. Confirmation comes from the source lookup.
   */
  documentTypeStated?: boolean;
  locator?: CitationLocator;
  pinpoint?: Pinpoint;
  resolutionMethod?: ResolutionMethod;
  candidates?: CitationCandidate[];
};

export type CitationContext = CitationMatch & { context: string };

/**
 * A footnote routinely carries several independent authorities separated by a
 * semicolon ("See Akzo Nobel, ECLI:…, para. 40; and Case C-1/10, paras 25–27").
 * Every scan that reaches *outward* from a citation — its pinpoint, its case
 * name, its defined-term parenthetical — is bounded by the segment it sits in,
 * so one authority can never pick up the neighbouring authority's pinpoint. A
 * pinpoint stolen from the next citation in the list is a wrong paragraph shown
 * with full confidence, which is exactly the failure mode this tool exists to
 * prevent.
 */
export function citationSegments(text: string): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const separator of text.matchAll(/;/g)) {
    const end = separator.index ?? 0;
    segments.push({ start, end });
    start = end + 1;
  }
  segments.push({ start, end: text.length });
  return segments;
}

function segmentAt(segments: Array<{ start: number; end: number }>, index: number): { start: number; end: number } {
  return segments.find((segment) => index >= segment.start && index <= segment.end) ?? segments[segments.length - 1];
}

/**
 * Recognises the common abbreviations and symbols lawyers actually use for a
 * point/paragraph or article locator, not just the spelled-out words — found
 * missing against a real client document: "para. 1(c)", "Art. 8(5)", "§128",
 * "¶87" all went undetected before, each silently losing the locator (the
 * citation itself was still found; only the "jump to the cited point" part
 * failed). "art"/"para" without a period are deliberately not matched, to
 * avoid colliding with the ordinary English/French words. "paras." (plural
 * abbreviation) is also required, not just "para." — found missing against a
 * second real citation ("paras. 35-36"), which silently fell through to no
 * locator at all since neither "para\." nor the spelled-out "paragraphs?"
 * matches it.
 *
 * Plural "paras" is additionally matched without a trailing period at all —
 * unlike singular "para", it is not an ordinary English/French word on its
 * own, and real drafting uses it often ("paras 40-44"). Found missing when a
 * citation's actually-cited range was silently dropped in favour of a later,
 * unrelated "para. 41" mention that happened to carry a period the range
 * didn't — a wrong pinpoint shown with full confidence, not just a missing
 * one.
 *
 * `§§`/`¶¶` (the doubled form conventionally marking a plural reference) are
 * matched as one keyword rather than left to match on the second symbol alone.
 */
/**
 * English and French only, deliberately. Support for the other official languages was
 * built and then removed: the scope is English, with French kept because it predates this
 * work and real client documents are drafted in it. Every extra keyword widens the surface
 * on which a pinpoint can be matched wrongly, and breadth that is not needed buys nothing
 * while costing precision.
 *
 * Bare "para" (no period) stays excluded even though a mandatory digit follows it — it is
 * an ordinary word, and the scan reaches 160 characters past the citation, so prose could
 * produce a confident wrong paragraph. A missing pinpoint costs a click; a wrong one is
 * what this tool exists to prevent.
 */
const PINPOINT_KEYWORD = String.raw`(?:\b(?:points?|paragraphs?|paras\.?|para\.|pt\.?|articles?|art\.|recitals?|consid[ée]rants?)|§{1,2}|¶{1,2})`;
const PINPOINT_RANGE = String.raw`(?:\s*(?:[–—‑-]|\bto\b|à)\s*\d+)?`;
const PINPOINT_JOINER = String.raw`(?:\s*(?:,|\band\b|\bet\b|&)\s*\d+${PINPOINT_RANGE})*`;
/**
 * Real pinpoints are lists, not single numbers: "paras 40–44, 46 and 48",
 * "§§ 40-44, 46". Parsing only the first number reports one paragraph as the
 * whole of what the drafter cited, which understates the citation; parsing the
 * list needs its own small grammar — a number, an optional range, joined by
 * commas and/or "and".
 */
const PINPOINT_PATTERN = new RegExp(`${PINPOINT_KEYWORD}\\s*(\\d+(?:\\(\\d+\\))?${PINPOINT_RANGE}${PINPOINT_JOINER})`, 'i');
/**
 * The other half of how legislation is actually cited: the provision comes
 * first and the act follows it ("Article 6(5) of Regulation (EU) 2022/1925",
 * "recital 65 of the DMA"). Only accepted when the "of" runs straight into the
 * citation, so a provision belonging to some earlier act in the same sentence
 * can never be attached to this one.
 */
const PINPOINT_BEFORE = new RegExp(`${PINPOINT_KEYWORD}\\s*(\\d+(?:\\(\\d+\\))?${PINPOINT_RANGE}${PINPOINT_JOINER})\\s*(?:of|de\\s+la|de|du)\\s+$`, 'i');
const PINPOINT_ITEM = /^(\d+)(?:\((\d+)\))?(?:\s*(?:[–—‑-]|\bto\b|à)\s*(\d+))?/i;
const PINPOINT_SCAN_WINDOW = 160;
const PINPOINT_BEFORE_WINDOW = 80;

/** Guards against a mistyped or malformed range expanding into an absurd list. */
const MAX_RANGE_SPAN = 200;

function expandPinpointList(list: string): number[] {
  const paragraphs: number[] = [];
  for (const part of list.split(/\s*(?:,|\band\b|\bet\b|&)\s*/i)) {
    const item = PINPOINT_ITEM.exec(part.trim());
    if (!item) continue;
    const from = Number(item[1]);
    const to = item[3] ? Number(item[3]) : from;
    if (to < from || to - from > MAX_RANGE_SPAN) {
      paragraphs.push(from);
      if (item[3]) paragraphs.push(to);
      continue;
    }
    for (let paragraph = from; paragraph <= to; paragraph += 1) paragraphs.push(paragraph);
  }
  return [...new Set(paragraphs)];
}

/**
 * Parses the pinpoint that follows a citation, bounded by `limit` — normally
 * the end of the citation's own segment, so a scan never reaches across a
 * semicolon into the next authority's pinpoint.
 */
export type ParsedPinpoint = { locator: CitationLocator; pinpoint?: Pinpoint };

export function parsePinpoint(text: string, index: number, limit = text.length): ParsedPinpoint | undefined {
  const tail = text.slice(index, Math.min(limit, index + PINPOINT_SCAN_WINDOW));
  return fromPinpointMatch(PINPOINT_PATTERN.exec(tail));
}

/** See `PINPOINT_BEFORE`: the provision-then-act form, e.g. "Article 6(5) of Regulation (EU) 2022/1925". */
export function parsePinpointBefore(text: string, index: number, floor = 0): ParsedPinpoint | undefined {
  const head = text.slice(Math.max(floor, index - PINPOINT_BEFORE_WINDOW), index);
  return fromPinpointMatch(PINPOINT_BEFORE.exec(head));
}

function fromPinpointMatch(match: RegExpExecArray | null): ParsedPinpoint | undefined {
  if (!match) return undefined;

  const kind: CitationLocator['kind'] = /^(?:articles?|art\.)/i.test(match[0]) ? 'article' : 'point';
  const first = PINPOINT_ITEM.exec(match[1].trim());
  if (!first) return undefined;

  const locator: CitationLocator = {
    kind,
    start: Number(first[1]),
    // A parenthesised number directly after an article number is a paragraph
    // within that article, not a range — "Art. 8(5)" means Article 8,
    // paragraph 5. Without this the excerpt shows the whole article when the
    // lawyer asked for one paragraph of it.
    paragraph: first[2] ? Number(first[2]) : undefined,
    end: first[3] ? Number(first[3]) : undefined,
  };
  // An article locator's own sub-numbering is already carried by `paragraph`;
  // `pinpoint` is the judgment-paragraph list, so it would be meaningless here.
  return { locator, pinpoint: kind === 'point' ? { paragraphs: expandPinpointList(match[1]) } : undefined };
}

const CURIA_FOUNDING_YEAR = 1952;

/**
 * Case numbers carry a two-digit year with no century marker. The Court has
 * only existed since 1952, so any year up to the current one resolves to this
 * century and any later year must fall in the previous one — there is no
 * real ambiguity within that ~100-year span. Deriving this from the real
 * clock (rather than a fixed cutoff) keeps the resolution correct as time
 * passes, without ever needing to be updated by hand.
 */
export function resolveTwoDigitYear(twoDigitYear: string, referenceYear = new Date().getFullYear()): number {
  const century = referenceYear - (referenceYear % 100);
  const candidate = century + Number(twoDigitYear);
  return candidate > referenceYear ? candidate - 100 : candidate;
}

/**
 * The procedural suffixes that follow a case number. `P` (appeal) is by far the
 * most common and appears in the everyday form of many leading citations
 * ("C-550/07 P"); dropping it silently reports a different-looking case number
 * than the one the drafter wrote. None of them change the derived CELEX, which
 * keys on court, year, and number only.
 */
const CASE_SUFFIX = String.raw`P\(R\)|RENV|DEP|REV|OP|P|R`;
/**
 * Real documents do not use a plain ASCII hyphen consistently: CURIA's own
 * XHTML renders "C‑131/12" with a non-breaking hyphen (U+2011), and en-dashes
 * turn up wherever a word processor has autocorrected one. Confirmed live
 * against the CELLAR rendering of C-131/12. A pattern accepting only `-` misses
 * the citation entirely, which reads as "no citation in this footnote".
 */
const CASE_HYPHENS = String.raw`[-‑–—]`;
const CASE_NUMBER_SOURCE = String.raw`\b([CT])${CASE_HYPHENS}?(\d{1,4})\/(\d{2})(?!\d)(?:\s+(${CASE_SUFFIX})(?![\w(]))?`;
/** The same pattern with no capture groups, so it can be embedded in a larger one. */
const CASE_NUMBER_INLINE = String.raw`\b[CT]${CASE_HYPHENS}?\d{1,4}\/\d{2}(?!\d)(?:\s+(?:${CASE_SUFFIX})(?![\w(]))?`;

const JOINED_GROUP = new RegExp(
  String.raw`\b(?:joined\s+cases?|affaires?\s+jointes?)\s+((?:${CASE_NUMBER_INLINE}(?:\s*(?:,|and|et)\s*)?)+)`,
  'gi',
);

/** Rewrites any accepted spelling of a case number to the single canonical form used as its identity. */
export function normaliseCaseNumber(caseNumber: string): string {
  const match = new RegExp(`^${CASE_NUMBER_SOURCE}$`, 'i').exec(caseNumber.trim());
  if (!match) return caseNumber.trim().toUpperCase();
  const [, court, number, year, suffix] = match;
  return `${court.toUpperCase()}-${number}/${year}${suffix ? ` ${suffix.toUpperCase()}` : ''}`;
}

/**
 * A case number identifies the *case*; the CELEX sector identifies which document within
 * it. Confirmed live against CELLAR: `62012CC0131` is Advocate General Jääskinen's opinion
 * in Google Spain and `62014CO0413` is an order in Intel, both fetching normally and both
 * using the same `id="pointN"` paragraph markup as a judgment.
 *
 * This is why an opinion or an order is no longer link-only. The original rule — derive the
 * judgment sector always, then refuse to fetch whenever the citation was not a judgment —
 * was the right call while `CJ` was the only sector derived, since the CELEX would have
 * named a different document. It was a limitation of the derivation, not a fact about what
 * can be retrieved.
 *
 * General Court Advocate General opinions are not derived: they barely exist in practice
 * and no sector for them has been confirmed, so nothing is guessed.
 */
const CELEX_SECTORS: Record<string, Partial<Record<CuriaDocumentType, string>>> = {
  C: { judgment: 'CJ', opinion: 'CC', order: 'CO' },
  T: { judgment: 'TJ', order: 'TO' },
};

/** Exported for direct, deterministic testing of century resolution and the founding-year floor; detectCitations is the intended public entry point. */
export function celexForCase(
  caseNumber: string,
  { documentType = 'judgment', referenceYear }: { documentType?: CuriaDocumentType; referenceYear?: number } = {},
): string | undefined {
  const match = new RegExp(`^${CASE_NUMBER_SOURCE}$`, 'i').exec(caseNumber.trim());
  if (!match) return undefined;
  const [, court, number, twoDigitYear] = match;
  const year = resolveTwoDigitYear(twoDigitYear, referenceYear);
  if (year < CURIA_FOUNDING_YEAR) return undefined;
  const sector = CELEX_SECTORS[court.toUpperCase()]?.[documentType];
  if (!sector) return undefined;
  return `6${year}${sector}${number.padStart(4, '0')}`;
}

const OPINION_SIGNAL = /\bopinion of (?:the )?(?:advocate general|AG)\b|\b(?:advocate general|AG)'?s?\s+opinion\b|\bconclusions?\s+de\s+l'avocat\s+g[ée]n[ée]ral\b/i;
// "Order of the Court" is only one drafting convention; "Order of [date]" — the same
// dating convention "Judgment of [date]" uses — is at least as common and was previously
// unrecognised, so an order cited that way was silently mislabelled as a judgment.
const ORDER_SIGNAL = /\border of (?:the (?:court|general court)|\d{1,2}\s+\S+\s+\d{4})\b|\bordonnance\s+(?:de\s+la\s+cour|du\s+\d{1,2})\b/i;
// The affirmative counterpart: only used to record that the type was *stated*, never to
// change the resolved type, which already defaults to 'judgment'.
const JUDGMENT_SIGNAL = /\bjudgment of (?:the (?:court|general court)|\d{1,2}\s+\S+\s+\d{4})\b|\barr[êe]t\s+(?:de\s+la\s+cour|du\s+\d{1,2})\b/i;

/**
 * Scans the text immediately around a case citation for wording that
 * identifies it as an Advocate General opinion or a procedural order rather
 * than the judgment itself. Defaults to 'judgment' when no such signal is
 * found — the common case, and the only one for which the derived CELEX
 * reliably names the cited document — but reports whether the text actually
 * said so, so a caller can distinguish a stated type from that default.
 */
function documentTypeNear(text: string, index: number, matchLength: number): { documentType: CuriaDocumentType; stated: boolean } {
  const window = text.slice(Math.max(0, index - 200), Math.min(text.length, index + matchLength + 100));
  if (OPINION_SIGNAL.test(window)) return { documentType: 'opinion', stated: true };
  if (ORDER_SIGNAL.test(window)) return { documentType: 'order', stated: true };
  return { documentType: 'judgment', stated: JUDGMENT_SIGNAL.test(window) };
}

function labelForDocumentType(documentType: CuriaDocumentType, defaultLabel: string): string {
  if (documentType === 'opinion') return 'CJEU Advocate General opinion';
  if (documentType === 'order') return 'CJEU order';
  return defaultLabel;
}

/**
 * "Akzo Nobel Chemicals and Akcros Chemicals v Commission" — the party-versus-party
 * name, which is what a drafter actually shortens to when citing the case again.
 * Only these separators are accepted; a bare "c." (French) is too easily an
 * initial or an abbreviation to be worth the false positives.
 */
const PARTY_SEPARATOR = /\s+(?:v\.?|vs\.?|contre)\s+/i;
const CASE_GROUP_PREFIX = new RegExp(
  String.raw`^(?:joined\s+)?(?:cases?|affaires?(?:\s+jointes?)?)\s+(?:${CASE_NUMBER_INLINE}(?:\s*(?:,|and|et|&)\s*)?)+`,
  'i',
);
const DOCUMENT_PREFIX = /^(?:judgments?|orders?|opinions?|arr[êe]ts?|ordonnances?|conclusions)\b/i;
const CITATION_LEAD_IN = /^(?:see(?:\s+also)?|cf\.?|voir|but\s+see|compare|e\.g\.?|accord|in|from)\s+/i;
/**
 * Words that begin a comma-delimited fragment which is structure, not a case
 * name. Kept broad on purpose: registering a non-name as a case name would
 * generate short-form variants that go on to match ordinary prose elsewhere in
 * the document.
 */
const NOT_A_CASE_NAME = /^(?:ecli|celex|case|cases|joined|affaire|affaires|judgment|order|opinion|arr[êe]t|ordonnance|conclusions|regulation|directive|decision|d[ée]cision|r[èe]glement|recommendation|article|articles|art|paragraph|paragraphs|para|paras|point|points|recital|annex|chapter|section|title|part|ibid|id|supra|infra|the|this|that|these|those|it|its|at|and|but|for|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

function looksLikeCaseName(candidate: string): boolean {
  if (candidate.length < 3 || candidate.length > 120) return false;
  if (!/^[A-ZÀ-Þ]/.test(candidate)) return false;
  if (DOCUMENT_PREFIX.test(candidate) || NOT_A_CASE_NAME.test(candidate)) return false;
  // "Commission", "Council", a bare Member State: these end hundreds of cases and name
  // none of them. Reached via a real document, where "Akzo Nobel v Commission, para. 40"
  // reported "Commission" as an unidentified authority needing review.
  if (GENERIC_PARTY_NAMES.has(candidate.toLowerCase())) return false;
  return /[A-Za-zÀ-ÿ]{2}/.test(candidate);
}

function tidyCaseName(candidate: string): string {
  return candidate.trim().replace(CITATION_LEAD_IN, '').replace(/[\s,;:.–—-]+$/, '').trim();
}

/**
 * The case name normally sits in the comma-delimited fragment immediately
 * before the identifier ("Judgment of 14 September 2010, Akzo Nobel … v
 * Commission, ECLI:EU:C:2010:512") or immediately after a case number
 * ("Case C-131/12 Google Spain, ECLI:…"). A fragment is only accepted as a name
 * when something corroborates it: a party separator, a case number it directly
 * follows, or a document-type prefix on the fragment before it. A fragment that
 * is merely capitalised is left alone.
 */
/**
 * A citation routinely states its identifiers *between* the name and the ECLI
 * ("…v Commission, C-550/07 P, ECLI:EU:C:2010:512"), so the fragment directly
 * before the identifier is frequently another identifier rather than the name.
 * Those are stepped over rather than treated as the name — and stepping over one
 * is itself corroboration that what precedes it is a case name.
 */
const BARE_IDENTIFIER_FRAGMENT = new RegExp(
  String.raw`^(?:(?:joined\s+)?(?:cases?|affaires?(?:\s+jointes?)?)\s+)?(?:${CASE_NUMBER_INLINE}|ECLI:EU:[CT]:\d{4}:\d+)(?:\s*(?:,|and|et|&)\s*(?:${CASE_NUMBER_INLINE}|ECLI:EU:[CT]:\d{4}:\d+))*$`,
  'i',
);

/**
 * The lead-in left behind when the scan stops immediately before a case number:
 * "…v Commission, Case T-125/03" cuts at the match, so the fragment in hand is the bare
 * word "Case". Without stepping over it the case name is lost outright — and that shape,
 * name followed by its case number with no ECLI after it, is one of the commonest ways a
 * judgment is cited. It also silently weakened the appeal-versus-first-instance guard,
 * since a citation that registers no name can never reach the name-based merge it exists
 * to protect.
 */
const CASE_KEYWORD_ONLY = /^(?:joined\s+)?(?:cases?|affaires?(?:\s+jointes?)?)$/i;

function caseNameBefore(text: string, index: number, segmentStart: number): string | undefined {
  const before = text.slice(Math.max(segmentStart, index - 240), index).replace(/[\s,;:]+$/, '');
  const fragments = before.split(/[,;(]/).map((fragment) => fragment.trim());

  let cursor = fragments.length - 1;
  let steppedOverIdentifier = false;
  while (cursor >= 0 && (!fragments[cursor] || BARE_IDENTIFIER_FRAGMENT.test(fragments[cursor]) || CASE_KEYWORD_ONLY.test(fragments[cursor]))) {
    if (fragments[cursor]) steppedOverIdentifier = true;
    cursor -= 1;
  }
  if (cursor < 0) return undefined;

  const previous = fragments[cursor - 1] ?? '';
  // "Opinion of Advocate General Jääskinen of 25 June 2013 in Google Spain" — the whole
  // fragment is a document-type preamble, so it is rejected outright as a case name, but
  // what follows the "in" is the case. Without this an opinion carries no case name, and
  // therefore no route to the case number that makes it fetchable.
  const preamble = DOCUMENT_PREFIX.test(tidyCaseName(fragments[cursor])) ? /\bin\s+(.+)$/i.exec(fragments[cursor]) : null;
  const fragment = tidyCaseName(preamble ? preamble[1] : fragments[cursor]);
  const followsCaseNumber = steppedOverIdentifier || CASE_GROUP_PREFIX.test(fragment);
  const candidate = tidyCaseName(fragment.replace(CASE_GROUP_PREFIX, ''));

  if (!looksLikeCaseName(candidate)) return undefined;
  if (PARTY_SEPARATOR.test(candidate) || followsCaseNumber || preamble || DOCUMENT_PREFIX.test(previous)) return candidate;
  return undefined;
}

function caseNameAfter(text: string, endIndex: number, segmentEnd: number): string | undefined {
  const after = text.slice(endIndex, Math.min(segmentEnd, endIndex + 160)).replace(/^[\s,:]+/, '');
  const candidate = tidyCaseName(after.split(/[,;(]/)[0] ?? '');
  return looksLikeCaseName(candidate) ? candidate : undefined;
}

// English and French only — see PINPOINT_KEYWORD for why the other official languages were
// removed rather than kept.
const DIRECTIVE_WORDS = /directive/i;
const REGULATION_WORDS = /regulation|règlement/i;
const RECOMMENDATION_WORDS = /recommendation|recommandation/i;
const ACT_KEYWORDS = 'Directive|Regulation|Règlement|Decision|Décision|Recommendation|Recommandation';

function celexForAct(kind: string, year: string, number: string): string {
  // Confirmed live: recommendations use sector letter 'H' (e.g. 32003H0361
  // resolves; the 'D' used for decisions 404s for the same number/year).
  const sector = DIRECTIVE_WORDS.test(kind) ? 'L' : REGULATION_WORDS.test(kind) ? 'R'
    : RECOMMENDATION_WORDS.test(kind) ? 'H' : 'D';
  return `3${year}${sector}${number.padStart(4, '0')}`;
}

const TREATY_CELEX_YEAR = '2016';

/**
 * Individual treaty articles carry their own dedicated CELEX identifier,
 * distinct from the whole-treaty document — confirmed live: `12016E101`
 * (TFEU Article 101), `12016M006` (TEU Article 6), and `12016P047` (Charter
 * Article 47) each resolve to a small single-article document, using the
 * exact same "Article N" heading and "N.   text" paragraph markup as
 * ordinary legislation, so the existing extraction machinery applies
 * unchanged. This matters because the whole-treaty CELEX (`12016E` etc.) was
 * tried first and turned out to be a dead end: CELLAR splits it across
 * several undiscoverable parts, and the part a plain fetch returns is only
 * the table of contents and protocols — not the article text at all.
 * '2016' is the year of the current consolidated republication (OJ C 202,
 * 7.6.2016, after Croatia's accession) — still the version in force.
 */
function celexForTreatyArticle(treaty: string, articleNumber: string): string {
  const docType = /^(?:TFEU|TFUE)$/i.test(treaty) ? 'E' : /^(?:TEU|TUE)$/i.test(treaty) ? 'M' : 'P';
  return `1${TREATY_CELEX_YEAR}${docType}${articleNumber.padStart(3, '0')}`;
}

/**
 * EU acts are cited in two numbering conventions, and regulations reverse the
 * number order relative to directives/decisions within the pre-2015 one:
 *  - Pre-2015 directives/decisions: year/number with a trailing sector suffix
 *    ("Directive 2002/58/EC").
 *  - Pre-2015 regulations: number/year, marked by a literal "No" — with or
 *    without the sector bracket ("Regulation (EC) No 1049/2001", or just
 *    "Regulation No 1049/2001").
 *  - Post-2015, all act types: year/number, with or without the leading
 *    bracket and no trailing suffix ("Regulation (EU) 2016/679", or the
 *    bracket dropped in an informal short form — "Implementing Regulation
 *    2023/814" is a real citation confirmed against a live document; the
 *    keyword plus an unambiguous 4-digit year is enough on its own).
 * The keyword itself (Directive/Regulation/etc.) is what rules out a bare
 * pair of numbers being mistaken for a citation — the bracket is only needed
 * to disambiguate the "No" case above, which reverses the number order.
 */
function parseActNumbers(hasSuffix: boolean, hasNo: boolean, first: string, second: string): { year: string; number: string } | undefined {
  if (hasSuffix) return first.length === 4 ? { year: first, number: second } : undefined;
  if (hasNo) return second.length === 4 ? { year: second, number: first } : undefined;
  return first.length === 4 ? { year: first, number: second } : undefined;
}

/** Detects EU legal references and attaches the official-source identifier where it can be derived safely. */
export function detectCitations(text: string): CitationMatch[] {
  const matches: CitationMatch[] = [];
  const segments = citationSegments(text);
  const add = (match: Omit<CitationMatch, 'index' | 'status'> & { index?: number; status?: CitationStatus }) => {
    if (!matches.some((item) => item.value === match.value && item.index === (match.index ?? 0))) {
      matches.push({ ...match, index: match.index ?? 0, status: match.status ?? 'resolved' });
    }
  };
  // The provision-then-act form binds more tightly than a trailing pinpoint, so it is
  // tried first: in "Article 6(5) of Regulation (EU) 2022/1925, as amended", the article
  // is unambiguously this act's, while anything trailing may belong to the sentence.
  const pinpointFor = (start: number, end: number) => {
    const segment = segmentAt(segments, start);
    const parsed = parsePinpointBefore(text, start, segment.start) ?? parsePinpoint(text, end, segment.end);
    return { locator: parsed?.locator, pinpoint: parsed?.pinpoint };
  };

  // Case numbers already accounted for by an ECLI citation's own "before text" scan
  // (below) — including every number in a joined-cases group, not just the one stored
  // as that citation's `caseNumber` — so the standalone case-number loop further down
  // doesn't re-report them as a second, independent citation.
  // Safe to share across `matchAll` calls: `matchAll` iterates a clone, so it never
  // advances this object's lastIndex.
  const representedCaseNumbers = new Set<string>();
  const caseNumberPattern = new RegExp(CASE_NUMBER_SOURCE, 'gi');

  for (const match of text.matchAll(/\bECLI:EU:([CT]):(\d{4}):(\d+)\b/gi)) {
    const index = match.index ?? 0;
    const segment = segmentAt(segments, index);
    const before = text.slice(Math.max(segment.start, index - 500), index);
    const groupStart = Math.max(before.toLowerCase().lastIndexOf('affaires'), before.toLowerCase().lastIndexOf('joined cases'));
    const caseMatches = [...before.slice(groupStart >= 0 ? groupStart : 0).matchAll(caseNumberPattern)];
    for (const caseMatch of caseMatches) representedCaseNumbers.add(normaliseCaseNumber(caseMatch[0]));
    const caseNumber = (caseMatches[0] ?? caseMatches.at(-1)) ? normaliseCaseNumber((caseMatches[0] ?? caseMatches.at(-1))![0]) : undefined;
    const { documentType, stated } = documentTypeNear(text, index, match[0].length);
    add({
      label: labelForDocumentType(documentType, 'CJEU judgment'), value: match[0].toUpperCase(), index, source: 'curia', ecli: match[0].toUpperCase(),
      caseNumber, caseName: caseNameBefore(text, index, segment.start), documentType, documentTypeStated: stated || undefined,
      celex: caseNumber ? celexForCase(caseNumber, { documentType }) : undefined, ...pinpointFor(index, index + match[0].length),
    });
  }

  // "Joined Cases C-293/12 and C-594/12" is one judgment cited under several numbers, not
  // several authorities. The ECLI scan above already collapses the group whenever an ECLI
  // follows it, which hid this: with no ECLI, every number in the group became its own
  // citation, so the reviewer saw several chips for one judgment and each derived a CELEX
  // that need not name any document.
  for (const group of text.matchAll(JOINED_GROUP)) {
    const numbers = [...group[1].matchAll(caseNumberPattern)].map((number) => normaliseCaseNumber(number[0]));
    for (const caseNumber of numbers.slice(1)) representedCaseNumbers.add(caseNumber);
  }

  // Pre-1989 case numbers carry no court prefix at all: Van Gend en Loos is "Case 26/62",
  // Costa "Case 6/64". They are cited constantly, and were previously invisible — which
  // also left the frequent-case table inconsistent with detection, since it holds those
  // cases under their modern C- form while a document writing them the real way matched
  // nothing.
  //
  // A bare number pair is far too ambiguous to detect on its own (dates, ratios, "12/15
  // million"), so two things are required, and both are properties of the citation rather
  // than guesses: an explicit "Case"/"affaire" keyword, and a resolved year before the
  // General Court existed. The court letter is not inferred — it is a fact that the
  // General Court was created in 1989, so a case predating it can only be a Court of
  // Justice case.
  const GENERAL_COURT_CREATED = 1989;
  for (const match of text.matchAll(/\b(?:Cases?|Affaires?)\s+(\d{1,3})\/(\d{2})(?!\d)/gi)) {
    const index = match.index ?? 0;
    const segment = segmentAt(segments, index);
    if (resolveTwoDigitYear(match[2]) >= GENERAL_COURT_CREATED) continue;
    const caseNumber = `C-${match[1]}/${match[2]}`;
    if (representedCaseNumbers.has(caseNumber)) continue;
    representedCaseNumbers.add(caseNumber);
    const { documentType, stated } = documentTypeNear(text, index, match[0].length);
    add({
      label: labelForDocumentType(documentType, 'CJEU case number'), value: caseNumber, index, source: 'curia', caseNumber,
      caseName: caseNameBefore(text, index, segment.start) ?? caseNameAfter(text, index + match[0].length, segment.end),
      documentType, documentTypeStated: stated || undefined, celex: celexForCase(caseNumber, { documentType }), ...pinpointFor(index, index + match[0].length),
    });
  }

  // A case number is only skipped here when it was actually captured above as part of
  // some ECLI's own citation (the common "Case C-131/12, ECLI:EU:C:2014:317" case, where
  // both name the same document). A case number that merely sits near an unrelated ECLI —
  // e.g. two independent authorities cited in the same footnote — must still be reported
  // as its own citation; a plain textual-proximity check previously conflated the two.
  for (const match of text.matchAll(caseNumberPattern)) {
    const index = match.index ?? 0;
    const segment = segmentAt(segments, index);
    const caseNumber = normaliseCaseNumber(match[0]);
    if (representedCaseNumbers.has(caseNumber)) continue;
    const { documentType, stated } = documentTypeNear(text, index, match[0].length);
    add({
      label: labelForDocumentType(documentType, 'CJEU case number'), value: caseNumber, index, source: 'curia', caseNumber,
      caseName: caseNameBefore(text, index, segment.start) ?? caseNameAfter(text, index + match[0].length, segment.end),
      documentType, documentTypeStated: stated || undefined, celex: celexForCase(caseNumber, { documentType }), ...pinpointFor(index, index + match[0].length),
    });
  }

  for (const match of text.matchAll(new RegExp(String.raw`\b(${ACT_KEYWORDS})\s*(?:\((EU|EC|CE|EEC|EWG|UE|CEE)\)\s*)?(No\.?\s*)?(\d{1,4})\/(\d{1,4})(?:\/(EU|EC|CE|EEC|UE|CEE))?\b`, 'gi'))) {
    const index = match.index ?? 0;
    const [, kind, , no, first, second, suffix] = match;
    const parsed = parseActNumbers(Boolean(suffix), Boolean(no), first, second);
    if (!parsed) continue;
    add({
      label: DIRECTIVE_WORDS.test(kind) ? 'EU directive' : REGULATION_WORDS.test(kind) ? 'EU regulation'
        : RECOMMENDATION_WORDS.test(kind) ? 'EU recommendation' : 'EU decision',
      value: match[0], index, source: 'eur-lex', celex: celexForAct(kind, parsed.year, parsed.number), ...pinpointFor(index, index + match[0].length),
    });
  }

  for (const match of text.matchAll(/\b(?:Commission\s+)?(?:Decision|Décision)\s+C\((\d{4})\)\s*(\d+)\b/gi)) {
    add({ label: 'Commission decision', value: match[0], index: match.index ?? 0, source: 'commission' });
  }

  // Treaty articles — Article 101 TFEU, Article 6(3) TEU, Article 47 of the
  // Charter — are likely the single most common EU-law citation format of
  // all, and previously went entirely undetected. See celexForTreatyArticle
  // for how the CELEX is derived; a parenthesised number directly after the
  // article number is a paragraph within it, same convention as ordinary
  // legislation locators.
  for (const match of text.matchAll(/\b(?:Articles?|Art\.)\s+(\d+)(?:\((\d+)\))?\s+(?:of\s+the\s+|de\s+la\s+)?(TFEU|TFUE|TEU|TUE|CFR|CDFUE|Charter(?:\s+of\s+Fundamental\s+Rights)?|Charte(?:\s+des\s+droits\s+fondamentaux)?)\b/gi)) {
    const index = match.index ?? 0;
    const [, articleNumber, paragraph, treaty] = match;
    const label = /^(?:TFEU|TFUE)$/i.test(treaty) ? 'TFEU article' : /^(?:TEU|TUE)$/i.test(treaty) ? 'TEU article' : 'Charter article';
    add({
      label, value: match[0], index, source: 'eur-lex', celex: celexForTreatyArticle(treaty, articleNumber),
      locator: { kind: 'article', start: Number(articleNumber), paragraph: paragraph ? Number(paragraph) : undefined },
    });
  }

  // DG Competition's own case-number convention, distinct from the C(yyyy) decision
  // number above and not preceded by "Decision" at all — confirmed against a real
  // citation ("AT.37990, EC Decision of..."). AT. is antitrust, SA. is State aid,
  // M. (optionally "COMP/M.") is merger control.
  for (const match of text.matchAll(/\b(?:COMP\/)?(AT|SA|M)\.(\d{3,6})\b/g)) {
    const index = match.index ?? 0;
    const family = match[1] === 'AT' ? 'antitrust' : match[1] === 'SA' ? 'State aid' : 'merger';
    add({ label: `Commission ${family} case`, value: match[0], index, source: 'commission', ...pinpointFor(index, index + match[0].length) });
  }

  return matches.sort((a, b) => a.index - b.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `\b` is ASCII-only: it never fires next to an accented letter, so `\bÅkerberg\b`
 * cannot match "Åkerberg" at all and a short form like "Åkerberg Fransson" would
 * silently never resolve. These Unicode-aware lookarounds are the boundary
 * equivalent, and are used everywhere a case name — which is routinely not
 * ASCII — is matched against document text.
 */
const NAME_BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NAME_BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}])`;

function shortFormPattern(key: string): RegExp {
  return new RegExp(`${NAME_BOUNDARY_BEFORE}${escapeRegExp(key)}${NAME_BOUNDARY_AFTER}`, 'giu');
}

// A drafter explicitly declaring a short form right after a full citation — e.g.
// `ECLI:EU:C:2010:512, para. 40 ("Akzo Nobel")` or `Regulation (EU) 2022/1925 (the "DMA")`
// — straight or curly quotes. This is ground truth: a quoted definition states, in the
// document itself, exactly what the drafter means by that short form.
const DEFINED_TERM = /\(\s*(?:the\s+)?["“]([^"”]{1,80})["”]\s*\)/i;
const DEFINED_TERM_SCAN_WINDOW = 160;

type RegisteredCitation = Pick<CitationMatch, 'label' | 'source' | 'celex' | 'ecli' | 'caseNumber' | 'caseName' | 'documentType' | 'documentTypeStated'>;

type RegistryEntry = {
  key: string;
  method: Exclude<ResolutionMethod, 'fallback_table'>;
  /** Reading-order rank, so the *nearest preceding* entry wins when a key was registered more than once. */
  order: number;
  citation: RegisteredCitation;
};

function identityOf(citation: RegisteredCitation): string | undefined {
  return citation.ecli ?? citation.celex ?? citation.caseNumber ?? citation.caseName;
}

/**
 * Whether two registrations name the same authority. This cannot be a single
 * identity string, because a document routinely states the *same* case by
 * different identifiers in different footnotes — "…v Commission,
 * ECLI:EU:C:2010:512" in one and "Case C-550/07 P, …v Commission" in another.
 * Keying on "first identifier present" made those two look like two different
 * authorities, so every later short form referring to them was reported as
 * ambiguous between a case and itself. Found against a real test document; it
 * broke exactly the citations the short-form work exists to handle.
 *
 * The rule: the first identifier kind both sides actually have decides, so
 * conflicting ECLIs are always different documents. Only when they share no
 * identifier at all does the case name decide — and a differing document type
 * blocks that outright, since a judgment and the Advocate General's opinion in
 * the same case share a name but are not the same document.
 */
function courtOf(citation: RegisteredCitation): string | undefined {
  return (/^ECLI:EU:([CT]):/i.exec(citation.ecli ?? '') ?? /^([CT])-/i.exec(citation.caseNumber ?? ''))?.[1]?.toUpperCase();
}

function sameAuthority(a: RegisteredCitation, b: RegisteredCitation): boolean {
  if (a.documentType !== b.documentType) return false;
  // An appeal and the judgment under appeal share their case name exactly ("Akzo Nobel v
  // Commission" is both T-125/03 and C-550/07 P), so the name-based fallback below could
  // merge them when one is cited by ECLI only and the other by case number only. Both
  // spellings carry the court, and the court differs — checking it rules that out without
  // needing an identifier in common.
  const courts = [courtOf(a), courtOf(b)];
  if (courts[0] && courts[1] && courts[0] !== courts[1]) return false;

  for (const [left, right] of [[a.ecli, b.ecli], [a.caseNumber, b.caseNumber], [a.celex, b.celex]]) {
    if (left && right) return left === right;
  }
  return Boolean(a.caseName && b.caseName && a.caseName.toLowerCase() === b.caseName.toLowerCase());
}

/**
 * Folds in everything the document has already said about this same authority. A footnote
 * citing only an ECLI cannot produce a CELEX — an ECLI is not derivable to one — so it
 * could only ever offer a search link, even when an earlier footnote gave the case number
 * that does derive. Repeated to a fixed point, because merging can reveal a match that was
 * not visible before: gaining a case name from one entry can then match another.
 */
function enrichFromRegistry(citation: RegisteredCitation, registry: RegistryEntry[]): RegisteredCitation {
  let enriched = citation;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = enriched;
    for (const entry of registry) {
      if (sameAuthority(enriched, entry.citation)) enriched = mergeCitations(enriched, entry.citation);
    }
    if (identityOf(before) === identityOf(enriched) && before.celex === enriched.celex
      && before.caseNumber === enriched.caseNumber && before.caseName === enriched.caseName) break;
  }
  return enriched;
}

/**
 * Once two registrations are known to be the same authority, each may hold an
 * identifier the other lacks. Merging them is what lets a short form resolved
 * from a name-and-ECLI footnote still carry the case number — and therefore the
 * CELEX — that a different footnote supplied, so the judgment text can actually
 * be fetched instead of falling back to a search link.
 */
function mergeCitations(a: RegisteredCitation, b: RegisteredCitation): RegisteredCitation {
  return {
    label: a.label, source: a.source,
    ecli: a.ecli ?? b.ecli, celex: a.celex ?? b.celex,
    caseNumber: a.caseNumber ?? b.caseNumber, caseName: a.caseName ?? b.caseName,
    documentType: a.documentType ?? b.documentType,
    documentTypeStated: a.documentTypeStated || b.documentTypeStated,
  };
}

function toRegistered(citation: CitationMatch): RegisteredCitation {
  return {
    label: citation.label, source: citation.source, celex: citation.celex, ecli: citation.ecli,
    caseNumber: citation.caseNumber, caseName: citation.caseName,
    documentType: citation.documentType, documentTypeStated: citation.documentTypeStated,
  };
}

function toCandidate(citation: RegisteredCitation): CitationCandidate {
  return {
    label: citation.label, source: citation.source, caseName: citation.caseName,
    caseNumber: citation.caseNumber, celex: citation.celex, ecli: citation.ecli, documentType: citation.documentType,
  };
}

/**
 * Party names that identify hundreds of unrelated cases and therefore cannot
 * shorten any of them. "v Commission" is the single most common ending in EU
 * case law; a variant that resolved on it would match the wrong authority
 * constantly.
 */
const GENERIC_PARTY_NAMES = new Set([
  'commission', 'european commission', 'commission of the european communities', 'ec',
  'council', 'council of the european union', 'european council', 'parliament', 'european parliament',
  'court', 'court of justice', 'court of auditors', 'ecb', 'european central bank', 'eu', 'european union',
  'others', 'and others', 'e.a.', 'ea', 'member states', 'member state',
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech republic', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania',
  'luxembourg', 'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia',
  'spain', 'sweden', 'united kingdom',
]);

/**
 * Words that begin a great many company names but carry no identity on their
 * own. A one-word variant built from these would match ordinary prose — a
 * document citing "Digital Rights Ireland" must not have every later mention of
 * "Digital" treated as a reference back to it.
 */
const WEAK_LEAD_WORDS = new Set([
  'digital', 'european', 'national', 'international', 'general', 'federal', 'royal', 'united',
  'new', 'data', 'open', 'smart', 'global', 'first', 'air', 'post', 'bank', 'group', 'union',
  'central', 'north', 'south', 'east', 'west', 'deutsche', 'nederlandse', 'société', 'sociedad',
]);

const CORPORATE_SUFFIX = /\s+(?:and\s+others|e\.?\s?a\.?|ltd\.?|limited|gmbh|a\.?g\.?|s\.?a\.?|n\.?v\.?|b\.?v\.?|s\.?p\.?a\.?|plc|inc\.?|corp(?:oration)?\.?|sarl|sas|oy|ab|aps|kft|se|llc|kg|co\.?)$/i;

function stripCorporateSuffixes(value: string): string {
  let result = value.trim();
  for (let pass = 0; pass < 3 && CORPORATE_SUFFIX.test(result); pass += 1) {
    result = result.replace(CORPORATE_SUFFIX, '').trim();
  }
  return result;
}

function isUsableVariant(value: string): boolean {
  if (value.length < 3 || value.length > 120) return false;
  if (!/^[A-ZÀ-Þ0-9]/.test(value)) return false;
  if (GENERIC_PARTY_NAMES.has(value.toLowerCase())) return false;
  if (NOT_A_CASE_NAME.test(value)) return false;
  return /[A-Za-zÀ-ÿ]{2}/.test(value);
}

/**
 * Generates the shortened forms a drafter plausibly uses for a case they have
 * already cited in full, for the very common situation where no short form was
 * ever declared in quotes. From "Akzo Nobel Chemicals and Akcros Chemicals v
 * Commission": drop the defendant, drop the secondary applicant, then keep
 * successively shorter prefixes of the lead party — "Akzo Nobel Chemicals",
 * "Akzo Nobel", "Akzo".
 *
 * Generic institutional defendants and bare Member State names are never
 * emitted (they identify hundreds of cases, so they can shorten none of them),
 * and a one-word variant is skipped when that word is one of the many generic
 * company-name openers.
 */
export function shortNameVariants(caseName: string): string[] {
  const variants = new Set<string>();
  const applicantVariants = new Set<string>();

  const addTo = (targets: Array<Set<string>>, value: string) => {
    const cleaned = tidyCaseName(value);
    if (isUsableVariant(cleaned)) for (const target of targets) target.add(cleaned);
  };
  const addParty = (targets: Array<Set<string>>, party: string) => {
    const cleaned = stripCorporateSuffixes(party);
    addTo(targets, cleaned);
    const words = cleaned.split(/\s+/).filter(Boolean);
    for (let count = words.length - 1; count >= 1; count -= 1) {
      const prefix = words.slice(0, count).join(' ');
      if (count === 1 && WEAK_LEAD_WORDS.has(prefix.toLowerCase())) continue;
      addTo(targets, prefix);
    }
  };

  addTo([variants], caseName);
  const sides = caseName.split(PARTY_SEPARATOR);
  const applicantSide = sides[0] ?? caseName;
  addTo([variants, applicantVariants], applicantSide);
  addTo([variants, applicantVariants], stripCorporateSuffixes(applicantSide));

  // Every named party, on both sides — not just the applicant. A case is not always known
  // by whoever happens to be first on the record: Schrems II is "Data Protection
  // Commissioner v Facebook Ireland and Schrems", and every lawyer calls it Schrems.
  // Generating applicant-side names only made that case unreachable by its own common
  // name, and — worse — left a document citing both Schrems judgments resolving a bare
  // "Schrems" silently to the first one, since the second could never match. Generic
  // institutions and Member States are still filtered out by `isUsableVariant`, which is
  // what keeps "v Commission" from becoming a short form for hundreds of cases.
  for (const party of applicantSide.split(/\s+(?:and|et|&)\s+/i)) addParty([variants, applicantVariants], party);
  for (const side of sides.slice(1)) for (const party of side.split(/\s+(?:and|et|&)\s+/i)) addParty([variants], party);

  // "Akzo Nobel v Commission" — the applicant shortened but the defendant kept. This is a
  // form drafters use constantly and it is not reachable from the party names alone, since
  // those all drop "v Commission" entirely. Only applicant-side variants take a defendant,
  // so this never produces a defendant paired with itself.
  const separator = PARTY_SEPARATOR.exec(caseName);
  const defendant = separator ? caseName.slice((separator.index ?? 0) + separator[0].length).trim() : '';
  if (defendant) {
    for (const applicantVariant of applicantVariants) {
      if (PARTY_SEPARATOR.test(applicantVariant)) continue;
      addTo([variants], `${applicantVariant}${separator![0]}${defendant}`);
      addTo([variants], `${applicantVariant} v ${defendant}`);
    }
  }

  return [...variants];
}

/**
 * A generated variant is inferred, not declared, so it is only accepted where the
 * text is unmistakably citing rather than narrating: the name has to carry a
 * pinpoint. "Akzo Nobel, para. 45" is a citation; "the Akzo Nobel line of cases"
 * is prose, and treating it as a citation would put a source panel behind a
 * phrase the drafter never meant as a reference.
 */
const ADJACENT_PINPOINT = new RegExp(String.raw`^[\s,;:]*(?:at\s+)?${PINPOINT_KEYWORD}\s*\d`, 'i');
const ADJACENT_PINPOINT_WINDOW = 40;

function hasAdjacentPinpoint(text: string, endIndex: number, limit: number): boolean {
  return ADJACENT_PINPOINT.test(text.slice(endIndex, Math.min(limit, endIndex + ADJACENT_PINPOINT_WINDOW)));
}

/**
 * A capitalised name carrying a pinpoint and nothing else — the shape of every
 * short-form citation, whether or not Ibid can resolve it. Used only to find
 * spans that resolution has already failed on, so they can be reported as gaps
 * instead of disappearing.
 */
const SHORT_FORM_SPAN = new RegExp(
  // The connector list includes the party separator, so a party-versus-party name is
  // captured whole: without it the span started at the *defendant* ("Akzo Nobel v
  // Commission, para. 40" reported just "Commission"). Longer alternatives come first so
  // "van"/"von" are not consumed by "v".
  String.raw`${NAME_BOUNDARY_BEFORE}([A-ZÀ-Þ][\p{L}\d'’&.-]*(?:\s+(?:and|of|the|de|du|des|la|le|von|van|vs\.?|v\.?|der|den|el|en|et|di|da|do|dos)?\s*[A-ZÀ-Þ][\p{L}\d'’&.-]*){0,5})(?=[\s,;:]*(?:at\s+)?${PINPOINT_KEYWORD}\s*\d)`,
  'gu',
);

export type FrequentCase = {
  /** The case name as the Court's own record states it. */
  name: string;
  /** The short forms this case is actually cited by. Matched case-insensitively. */
  aliases: string[];
  caseNumber: string;
  court: 'Court of Justice' | 'General Court';
  year: number;
};

/**
 * Citation frequency in EU legal writing is heavily skewed: a small set of
 * landmark cases accounts for a disproportionate share of what is actually
 * cited, and those are exactly the cases a drafter is most likely to name
 * without ever citing in full ("Van Gend en Loos", "Schrems", "Intel"). This
 * table is the last resort, consulted only when a short form has no anchor
 * anywhere in the document — an in-document citation always wins, and the
 * ambiguity policy still applies here in full: a nickname listed against more
 * than one case is reported as ambiguous, never silently resolved to the more
 * famous one.
 *
 * Deliberately no ECLI column. An ECLI cannot be derived from anything else, so
 * it would be hand-entered data with no check on it, and a wrong ECLI here would
 * be a wrong citation presented with full confidence — the exact failure this
 * table's ambiguity rule exists to avoid. The case number is enough: the CELEX
 * derives from it deterministically, and the source lookup confirms the document
 * against the live record before anything is shown.
 *
 * Coverage is deliberately minimal. See docs/HANDOFF.md — how far to extend this
 * list, and how it gets reviewed as case law moves, is an open product decision,
 * not something to grow ad hoc.
 */
export const FREQUENT_CASES: FrequentCase[] = [
  { name: 'Van Gend en Loos v Nederlandse Administratie der Belastingen', aliases: ['Van Gend en Loos', 'Van Gend'], caseNumber: 'C-26/62', court: 'Court of Justice', year: 1963 },
  { name: 'Costa v ENEL', aliases: ['Costa v ENEL', 'Costa'], caseNumber: 'C-6/64', court: 'Court of Justice', year: 1964 },
  { name: 'Rewe-Zentral v Bundesmonopolverwaltung für Branntwein', aliases: ['Cassis de Dijon', 'Rewe-Zentral'], caseNumber: 'C-120/78', court: 'Court of Justice', year: 1979 },
  { name: 'Amministrazione delle Finanze dello Stato v Simmenthal', aliases: ['Simmenthal'], caseNumber: 'C-106/77', court: 'Court of Justice', year: 1978 },
  { name: 'Marleasing v La Comercial Internacional de Alimentación', aliases: ['Marleasing'], caseNumber: 'C-106/89', court: 'Court of Justice', year: 1990 },
  { name: 'Francovich and Bonifaci v Italy', aliases: ['Francovich'], caseNumber: 'C-6/90', court: 'Court of Justice', year: 1991 },
  { name: 'Criminal proceedings against Keck and Mithouard', aliases: ['Keck', 'Keck and Mithouard'], caseNumber: 'C-267/91', court: 'Court of Justice', year: 1993 },
  { name: 'Union royale belge des sociétés de football association v Bosman', aliases: ['Bosman'], caseNumber: 'C-415/93', court: 'Court of Justice', year: 1995 },
  { name: 'Kadi and Al Barakaat International Foundation v Council and Commission', aliases: ['Kadi', 'Kadi I'], caseNumber: 'C-402/05 P', court: 'Court of Justice', year: 2008 },
  { name: 'Akzo Nobel Chemicals and Akcros Chemicals v Commission', aliases: ['Akzo Nobel', 'Akzo'], caseNumber: 'C-550/07 P', court: 'Court of Justice', year: 2010 },
  { name: 'Akzo Nobel and Others v Commission', aliases: ['Akzo Nobel', 'Akzo'], caseNumber: 'C-97/08 P', court: 'Court of Justice', year: 2009 },
  { name: 'Åkerberg Fransson', aliases: ['Åkerberg Fransson', 'Akerberg Fransson', 'Fransson'], caseNumber: 'C-617/10', court: 'Court of Justice', year: 2013 },
  { name: 'Google Spain and Google v Agencia Española de Protección de Datos and Costeja González', aliases: ['Google Spain', 'Costeja'], caseNumber: 'C-131/12', court: 'Court of Justice', year: 2014 },
  { name: 'Digital Rights Ireland and Seitlinger and Others', aliases: ['Digital Rights Ireland', 'Digital Rights'], caseNumber: 'C-293/12', court: 'Court of Justice', year: 2014 },
  { name: 'Intel v Commission', aliases: ['Intel'], caseNumber: 'T-286/09', court: 'General Court', year: 2014 },
  { name: 'Intel v Commission', aliases: ['Intel'], caseNumber: 'C-413/14 P', court: 'Court of Justice', year: 2017 },
  { name: 'Taricco and Others', aliases: ['Taricco'], caseNumber: 'C-105/14', court: 'Court of Justice', year: 2015 },
  { name: 'Schrems v Data Protection Commissioner', aliases: ['Schrems', 'Schrems I'], caseNumber: 'C-362/14', court: 'Court of Justice', year: 2015 },
  { name: 'Slowakische Republik v Achmea', aliases: ['Achmea'], caseNumber: 'C-284/16', court: 'Court of Justice', year: 2018 },
  { name: 'Data Protection Commissioner v Facebook Ireland and Schrems', aliases: ['Schrems', 'Schrems II'], caseNumber: 'C-311/18', court: 'Court of Justice', year: 2020 },
];

function frequentCasesFor(shortForm: string): FrequentCase[] {
  const needle = shortForm.trim().toLowerCase();
  return FREQUENT_CASES.filter((entry) =>
    entry.name.toLowerCase() === needle || entry.aliases.some((alias) => alias.toLowerCase() === needle));
}

function frequentCaseAsCitation(entry: FrequentCase): RegisteredCitation {
  return {
    label: entry.court === 'General Court' ? 'General Court judgment' : 'CJEU judgment',
    source: 'curia', caseNumber: entry.caseNumber, caseName: entry.name,
    celex: celexForCase(entry.caseNumber, { documentType: 'judgment' }), documentType: 'judgment',
  };
}

type ShortFormSpan = { index: number; value: string; key: string };

/** Keeps the longest span at each position and drops anything overlapping it, so "Akzo Nobel" wins over "Akzo". */
function withoutOverlaps(spans: ShortFormSpan[]): ShortFormSpan[] {
  const ordered = [...spans].sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const kept: ShortFormSpan[] = [];
  for (const span of ordered) {
    const overlaps = kept.some((other) => span.index < other.index + other.value.length && other.index < span.index + span.value.length);
    if (!overlaps) kept.push(span);
  }
  return kept;
}

/**
 * Detects citations across every footnote of a document, in reading order, so a citation
 * stated in full once is recognised again wherever the document later refers to it by a
 * short form. This is the single most common real citation pattern — cite in full once,
 * abbreviate afterwards — and it cannot be handled one footnote at a time: `detectCitations`
 * only ever sees a single footnote's text, with no memory of what was cited earlier, so
 * every footnote after a source's first mention came back "no citation detected" even
 * though a reader would recognise it immediately.
 *
 * Two passes, both in reading order:
 *
 *  - Pass A registers every full citation under the short forms it could later be referred
 *    to by: any short form the drafter declared in quotes (ground truth), plus the shortened
 *    case names a drafter plausibly uses (see `shortNameVariants`).
 *  - Pass B resolves the remaining short-form spans against that registry. A declared short
 *    form always wins. A generated variant only resolves when it carries a pinpoint, and
 *    only when every registry entry matching it names the same authority — a short form
 *    matching two different cases with nothing in the document to choose between them is
 *    reported `unresolved_ambiguous` with both candidates, never silently resolved to the
 *    likelier one.
 *
 * A registry entry is only available to footnotes *after* the one that defines it, so a
 * definition is never matched back against its own parenthetical.
 */
export function detectCitationsAcrossFootnotes(footnoteTexts: readonly string[]): CitationMatch[][] {
  const registry: RegistryEntry[] = [];
  let order = 0;

  return footnoteTexts.map((text) => {
    const hardMatches = detectCitations(text).map((citation) => {
      if (citation.source !== 'curia') return citation;
      const typed = borrowCaseNumberForRelatedDocument(inheritStatedDocumentType(citation, registry), registry);
      return { ...typed, ...enrichFromRegistry(toRegistered(typed), registry) };
    });
    const segments = citationSegments(text);
    const newEntries: RegistryEntry[] = [];
    // Where this footnote *declares* a short form. A footnote that redefines a term
    // already in the registry ('ECLI:EU:C:2017:632 ("Leading Case")') would otherwise
    // have its own parenthetical matched against the earlier definition and reported as
    // a citation of the previous authority — inside the very text replacing it.
    const declared: Array<{ start: number; end: number }> = [];

    // Pass A — register this footnote's full citations under every short form they
    // could later be referred to by.
    for (const citation of hardMatches) {
      const registered = toRegistered(citation);
      if (!identityOf(registered)) continue;

      const windowStart = citation.index + citation.value.length;
      const segment = segmentAt(segments, citation.index);
      const parenthetical = DEFINED_TERM.exec(text.slice(windowStart, Math.min(segment.end, windowStart + DEFINED_TERM_SCAN_WINDOW)));
      if (parenthetical) {
        newEntries.push({ key: parenthetical[1].trim().toLowerCase(), method: 'explicit_alias', order: order++, citation: registered });
        const start = windowStart + (parenthetical.index ?? 0);
        declared.push({ start, end: start + parenthetical[0].length });
      }

      if (citation.caseName) {
        for (const variant of shortNameVariants(citation.caseName)) {
          newEntries.push({ key: variant.toLowerCase(), method: 'generated_variant', order: order++, citation: registered });
        }
      }
    }

    const shorthand = resolveShortForms(text, segments, hardMatches, registry, declared);
    // Registering the same key for the same authority again adds nothing — resolution
    // groups by `sameAuthority` and takes the latest entry within a group — but a document
    // citing one case in full fifty times used to push its whole variant set fifty times,
    // and every later footnote then scans the text once per distinct key. Skipping the
    // duplicates keeps the registry proportional to the authorities in the document rather
    // than to how often they are cited.
    for (const entry of newEntries) {
      const existing = registry.find((candidate) =>
        candidate.key === entry.key && candidate.method === entry.method && sameAuthority(candidate.citation, entry.citation));
      if (!existing) { registry.push(entry); continue; }
      // Merged rather than skipped: the two registrations are the same authority but need
      // not hold the same identifiers — one footnote gives the ECLI, another the case
      // number — and dropping the later one would throw away the identifier that makes the
      // judgment fetchable. Folding it in also keeps the registry proportional to the
      // authorities in the document rather than to how often they are cited, which is what
      // made resolution superlinear: every later footnote scans the text once per key.
      existing.citation = mergeCitations(existing.citation, entry.citation);
      existing.order = Math.max(existing.order, entry.order);
    }

    return [...hardMatches, ...shorthand].sort((a, b) => a.index - b.index);
  });
}

/**
 * A document that says "Opinion of Advocate General Kokott …, ECLI:EU:C:2010:229" in one
 * footnote and then cites the same ECLI bare in another has told us what that document is;
 * only the second footnote does not repeat it. Without this the second citation falls back
 * to 'judgment', and a derived CELEX would then name the wrong document entirely.
 *
 * This is the one thing document context can settle that extraction cannot, so it is the
 * only place a document type is adopted from anywhere other than the text at hand — and it
 * still comes from the document's own words, never from the ECLI's shape.
 */
function inheritStatedDocumentType(citation: CitationMatch, registry: RegistryEntry[]): CitationMatch {
  if (citation.source !== 'curia' || citation.documentTypeStated) return citation;
  const stated = registry.find((entry) => entry.citation.documentTypeStated
    && ((entry.citation.ecli && entry.citation.ecli === citation.ecli)
      || (entry.citation.caseNumber && entry.citation.caseNumber === citation.caseNumber)));
  const documentType = stated?.citation.documentType;
  if (!documentType || documentType === citation.documentType) return citation;
  return { ...citation, documentType, documentTypeStated: true, label: labelForDocumentType(documentType, citation.label) };
}

/**
 * An Advocate General's opinion or an order is a document *within* a case, and the case
 * number belongs to the case rather than to any one document in it. So a citation reading
 * "Opinion of Advocate General Jääskinen … in Google Spain, ECLI:EU:C:2013:424" can take
 * its case number from the judgment the document cites in full elsewhere, and with it the
 * opinion's own CELEX — the `CC` sector, not the judgment's `CJ`.
 *
 * Only the number is borrowed, never the identity: `sameAuthority` still keeps the opinion
 * and the judgment apart, because their document types differ. The borrow is refused unless
 * exactly one case number is on offer and its court matches the one the citation's own ECLI
 * states, so an ambiguous or cross-court name resolves to nothing rather than to a guess.
 */
function borrowCaseNumberForRelatedDocument(citation: CitationMatch, registry: RegistryEntry[]): CitationMatch {
  if (citation.caseNumber || !citation.caseName) return citation;
  if (citation.documentType !== 'opinion' && citation.documentType !== 'order') return citation;

  const court = courtOf(toRegistered(citation));
  const offered = new Set(registry
    .filter((entry) => entry.key === citation.caseName?.toLowerCase())
    .map((entry) => entry.citation.caseNumber)
    .filter((caseNumber): caseNumber is string => caseNumber !== undefined && (!court || caseNumber.startsWith(`${court}-`))));
  if (offered.size !== 1) return citation;

  const [caseNumber] = offered;
  return { ...citation, caseNumber, celex: celexForCase(caseNumber, { documentType: citation.documentType }) };
}

function resolveShortForms(
  text: string,
  segments: Array<{ start: number; end: number }>,
  hardMatches: CitationMatch[],
  registry: RegistryEntry[],
  declared: Array<{ start: number; end: number }>,
): CitationMatch[] {
  const isSpokenFor = (index: number, length: number) =>
    hardMatches.some((citation) => index < citation.index + citation.value.length && citation.index < index + length)
    || declared.some((range) => index < range.end && range.start < index + length);

  const candidateSpans: ShortFormSpan[] = [];
  for (const key of new Set(registry.map((entry) => entry.key))) {
    for (const match of text.matchAll(shortFormPattern(key))) {
      const index = match.index ?? 0;
      if (isSpokenFor(index, match[0].length)) continue;
      candidateSpans.push({ index, value: match[0], key });
    }
  }

  const resolved: CitationMatch[] = [];
  for (const span of withoutOverlaps(candidateSpans)) {
    const segment = segmentAt(segments, span.index);
    const entries = registry.filter((entry) => entry.key === span.key);
    const explicit = entries.filter((entry) => entry.method === 'explicit_alias');
    const spanEnd = span.index + span.value.length;

    // An inferred short form has to be carrying a pinpoint to count as a citation;
    // a declared one is the drafter's own statement and needs no corroboration.
    if (!explicit.length && !hasAdjacentPinpoint(text, spanEnd, segment.end)) continue;

    // A declared short form is the drafter stating, in the document, what the term means
    // from that point on, so the nearest preceding declaration simply wins — a document
    // that redefines a term has not created an ambiguity, it has replaced one meaning
    // with another. Only *inferred* variants can be genuinely ambiguous.
    const applicable = explicit.length
      ? [explicit.reduce((best, entry) => (entry.order > best.order ? entry : best))]
      : entries;

    const authorities: Array<{ citation: RegisteredCitation; method: RegistryEntry['method'] }> = [];
    for (const entry of applicable) {
      const existing = authorities.find((authority) => sameAuthority(authority.citation, entry.citation));
      if (existing) existing.citation = mergeCitations(existing.citation, entry.citation);
      else authorities.push({ citation: { ...entry.citation }, method: entry.method });
    }
    // Pull in identifiers the document supplied for these same authorities elsewhere,
    // including under keys this span did not match — a term declared in quotes is often
    // declared against the footnote that has the ECLI, while the case number came from a
    // different footnote entirely.
    for (const authority of authorities) authority.citation = enrichFromRegistry(authority.citation, registry);

    // A footnote can name a source both by its short form and by its full identifier in
    // the same sentence ("See Akzo Nobel, ECLI:EU:C:2010:512, para. 40", or "Case
    // C-550/07 P, Akzo Nobel … v Commission") — that is one citation, not two, so the
    // short form is dropped when a hard match in the same footnote already names the
    // same authority.
    if (authorities.some((authority) => hardMatches.some((citation) => sameAuthority(toRegistered(citation), authority.citation)))) continue;

    const parsed = parsePinpoint(text, spanEnd, segment.end);
    if (authorities.length === 1) {
      const [authority] = authorities;
      resolved.push({
        ...authority.citation, value: span.value, index: span.index, status: 'resolved',
        resolutionMethod: authority.method, locator: parsed?.locator, pinpoint: parsed?.pinpoint,
      });
    } else {
      resolved.push(ambiguous(span, authorities.map((authority) => authority.citation), parsed));
    }
  }

  return [...resolved, ...unresolvedShortForms(text, segments, hardMatches, resolved)];
}

function ambiguous(span: ShortFormSpan, candidates: RegisteredCitation[], parsed: ReturnType<typeof parsePinpoint>): CitationMatch {
  return {
    label: 'Unconfirmed short-form citation', value: span.value, index: span.index, source: 'curia',
    status: 'unresolved_ambiguous', candidates: candidates.map(toCandidate),
    locator: parsed?.locator, pinpoint: parsed?.pinpoint,
  };
}

/**
 * Reports short-form spans that resolution could not tie to anything, so a gap is visible
 * rather than silent. Only segments that contain no citation at all are scanned: within a
 * segment that already identifies an authority, a capitalised name is part of that citation
 * (its case name, its court, its parties), not a separate unresolved reference.
 */
function unresolvedShortForms(
  text: string,
  segments: Array<{ start: number; end: number }>,
  hardMatches: CitationMatch[],
  resolved: CitationMatch[],
): CitationMatch[] {
  const found: CitationMatch[] = [];
  const identified = [...hardMatches, ...resolved];

  for (const segment of segments) {
    if (identified.some((citation) => citation.index >= segment.start && citation.index < segment.end)) continue;

    for (const match of text.slice(segment.start, segment.end).matchAll(SHORT_FORM_SPAN)) {
      const index = segment.start + (match.index ?? 0);
      const value = tidyCaseName(match[1]);
      if (!looksLikeCaseName(value)) continue;

      const span: ShortFormSpan = { index, value, key: value.toLowerCase() };
      const parsed = parsePinpoint(text, index + match[1].length, segment.end);
      const frequent = frequentCasesFor(value);

      if (frequent.length === 1) {
        // Offered, not asserted. Everything above this point is Ibid reading the
        // reviewer's own document back to them; this is Ibid volunteering something the
        // document never said, from a hand-maintained list. Presenting the two identically
        // would hide exactly the distinction a lawyer needs to judge how far to trust it,
        // so the identifiers stay in `candidates` until someone confirms.
        found.push({
          label: 'Suggested from known cases', value, index, source: 'curia',
          status: 'unconfirmed_suggestion', resolutionMethod: 'fallback_table',
          candidates: [toCandidate(frequentCaseAsCitation(frequent[0]))],
          locator: parsed?.locator, pinpoint: parsed?.pinpoint,
        });
      } else if (frequent.length > 1) {
        found.push(ambiguous(span, frequent.map(frequentCaseAsCitation), parsed));
      } else {
        found.push({
          label: 'Unconfirmed short-form citation', value, index, source: 'curia',
          status: 'unresolved_not_found', locator: parsed?.locator, pinpoint: parsed?.pinpoint,
        });
      }
    }
  }

  return found;
}

/**
 * Every distinct authority the document actually establishes, deduplicated the same way
 * resolution deduplicates them — so a case stated by ECLI in one footnote and by case
 * number in another appears once, holding both.
 *
 * This exists so an unresolved short form is not a dead end. Ibid declining to guess is
 * right, but the reviewer still has to resolve it, and everything they need is already in
 * their own document: offering that list turns "nothing here defines this" into one click.
 * Manual confirmation is worth asking for precisely here, where Ibid genuinely does not
 * know — as opposed to on every citation, where it would be a reflex rather than a
 * decision.
 */
export function citedAuthorities(footnoteMatches: CitationMatch[][]): CitationCandidate[] {
  const authorities: RegisteredCitation[] = [];
  for (const citation of footnoteMatches.flat()) {
    if (citation.status !== 'resolved') continue;
    const registered = toRegistered(citation);
    if (!registered.ecli && !registered.celex && !registered.caseNumber) continue;
    const existing = authorities.findIndex((authority) => sameAuthority(authority, registered));
    if (existing >= 0) authorities[existing] = mergeCitations(authorities[existing], registered);
    else authorities.push(registered);
  }
  return authorities.map(toCandidate);
}

/**
 * A realistic memo, used as the task pane's browser-preview document *and* as the fixture
 * the `real citations` suite asserts against — one array rather than two copies, so what a
 * reviewer clicks through and what CI checks cannot drift apart.
 *
 * Every case number and ECLI here was verified against the live EUR-Lex/CELLAR record; see
 * docs/HANDOFF.md for how, and do the same before changing any of them.
 *
 * Ordered to walk through every resolution outcome, since almost none of them can be seen
 * in a single footnote: a declared acronym reused later (1→2), a case name shortened
 * without ever being declared (3→4), two short forms sharing a footnote and keeping their
 * own pinpoints (8), Advocate General opinions that must not take the judgment's CELEX
 * (5, 16), legislation cited with the provision on either side of it (1, 9), a genuinely
 * ambiguous short form (12 — both Schrems judgments are cited in full above it), and a
 * case the memo never cites at all (18).
 */
export const PREVIEW_FOOTNOTES: readonly string[] = [
  'Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 (the “GDPR”), Article 17.',
  'GDPR, Article 17(1).',
  'Judgment of 13 May 2014, Google Spain SL and Google Inc. v AEPD and Costeja González, Case C-131/12, ECLI:EU:C:2014:317, paras 80–82 and 88.',
  'Google Spain, para. 97.',
  'Opinion of Advocate General Jääskinen of 25 June 2013 in Google Spain, ECLI:EU:C:2013:424, point 138.',
  'Judgment of 8 April 2014, Digital Rights Ireland and Seitlinger and Others, Joined Cases C-293/12 and C-594/12, ECLI:EU:C:2014:238, paras 57–65.',
  'CJUE, 21 décembre 2016, Tele2 Sverige AB et Watson e.a., affaires jointes C-203/15 et C-698/15, ECLI:EU:C:2016:970, point 112.',
  'Digital Rights Ireland, paras 62 and 65; and Tele2 Sverige, para. 119.',
  'Article 15(1) of Directive 2002/58/EC.',
  'Judgment of 6 October 2015, Schrems v Data Protection Commissioner, Case C-362/14, ECLI:EU:C:2015:650, para. 94.',
  'Judgment of 16 July 2020, Data Protection Commissioner v Facebook Ireland and Schrems, Case C-311/18, ECLI:EU:C:2020:559, para. 168.',
  'Schrems, para. 94.',
  'Article 7 of the Charter of Fundamental Rights; and Article 47 of the Charter.',
  'Judgment of 6 September 2017, Intel Corp. v Commission, Case C-413/14 P, ECLI:EU:C:2017:632, paras 138–139.',
  'Intel, para. 133.',
  'Opinion of Advocate General Wahl of 20 October 2016 in Intel, ECLI:EU:C:2016:788, §§ 73-75.',
  'Article 102 TFEU.',
  'Post Danmark, para. 44.',
];

function toContexts(matches: CitationMatch[], text: string, radius: number): CitationContext[] {
  return matches.map((citation) => {
    const start = Math.max(0, citation.index - radius);
    const end = Math.min(text.length, citation.index + citation.value.length + radius);
    return { ...citation, context: `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}` };
  });
}

export function getCitationContexts(text: string, radius = 180): CitationContext[] {
  return toContexts(detectCitations(text), text, radius);
}

/** Document-level counterpart of `getCitationContexts` — see `detectCitationsAcrossFootnotes`. */
export function getCitationContextsForFootnotes(footnoteTexts: readonly string[], radius = 180): CitationContext[][] {
  return detectCitationsAcrossFootnotes(footnoteTexts).map((matches, i) => toContexts(matches, footnoteTexts[i], radius));
}

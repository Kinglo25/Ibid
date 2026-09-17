/**
 * Where a Commission decision actually is, read from the Commission's own open data.
 *
 * A competition citation — `Case AT.40178, paragraph 223` — has never reached a document.
 * CELLAR does not hold these decisions: asked for `52021AT40178` it serves the Advisory
 * Committee's opinion on a *draft* of it, 6.3KB against a citation to paragraph 223, and for
 * Intel (`52023AT37990`) it holds a summary, an opinion and a hearing officer's report and
 * nothing else. The decision itself is a PDF on the Commission's own site, and its filename
 * carries an internal document id — `37990_3581_18.pdf` — that nothing derives from `37.990`.
 * Every route to read that id off a page is an Angular shell: measured on 2026-09-15,
 * `/cases/AT.37990`, `/cases/M.8713`, an invented path, `robots.txt`, `sitemap.xml` and the
 * legacy `elojade/isef/case_details.cfm` all return the identical 56,823-byte file, MD5
 * `6fe765198254d42de578f3ee0297d406`.
 *
 * The Commission publishes the mapping itself. `data.europa.eu` lists "EU Competition:
 * Antitrust and Cartel case publications" and its merger counterpart, creator
 * Directorate-General for Competition, under the Commission's reuse notice (Decision
 * 2011/833/EU), each distributed as a JSON file keyed by case number. Intel's record carries
 * exactly the file that had to be found by hand, alongside the label that says what it is.
 *
 * That is the whole of what this module does: turn those datasets into `AT.37990` → the URLs
 * of its decisions. It fetches no PDF and parses none. The reviewer is given a link that
 * opens the decision itself instead of a search box, which is a smaller claim than showing
 * them the passage — and unlike the passage, it cannot be wrong about which document it is,
 * because the Commission is the one saying so.
 */

/** One published decision document, as the Commission's dataset describes it. */
export type CommissionDecision = {
  /** The case it belongs to, spelled as the register spells it: `AT.37990`, `M.8713`. */
  caseNumber: string;
  url: string;
  /**
   * What the Commission calls this document — its category where one is given
   * (`Prohibition Decision (Art. 7)`, `Decision - web publication`), and otherwise the
   * name it carries, which for a merger decision states the legal basis (`Art. 6(1)(b)`).
   */
  description: string;
  /** As the dataset states it — `EN`, `FR`. Upper case, and not always present. */
  language?: string;
  /** ISO date the document carries. What tells one decision in a case from another. */
  documentDate?: string;
};

export type CommissionCaseIndex = {
  /**
   * Every decision published for a case, best first, or an empty array where the dataset
   * names none.
   *
   * All of them rather than one, because a case can have more than one and choosing between
   * them is not this module's to make. 52 of the 360 antitrust cases carrying a decision have
   * two or more distinct decision dates, and Intel is the case in point: `AT.37990` holds the
   * prohibition decision of 13 May 2009 and its re-adoption of 22 September 2023, both
   * labelled identically. A footnote citing paragraph 1000 means the text its author read,
   * and nothing in the citation says which — so the reviewer is shown that there are two,
   * dated, exactly as an ambiguous short form is shown its candidates rather than resolved by
   * a guess.
   */
  find(caseNumber: string): CommissionDecision[];
  /**
   * The register's title for a case — `TATA STEEL / THYSSENKRUPP / JV`, `Intel` — under the
   * same spellings `find` accepts. Every case the datasets list has one, decided or not.
   */
  title(caseNumber: string): string | undefined;
  /**
   * The one case whose title is the name a citation gives, where a single case is it.
   *
   * Searched within the cited number's family (`M.`, `AT.`). Every word of the name must be
   * in the title; among titles that hold them all, the one with the fewest words besides is
   * the case named — `BALL / REXAM` over `ARDAGH / BALL REXAM DIVESTMENT BUSINESS` — and a
   * tie goes to the number nearer the one cited, since a mistyped number is usually a digit
   * or two away from the right one. A tie that survives that is no answer.
   */
  caseNamed(name: string, citedNumber: string): { caseNumber: string; title: string } | undefined;
  /** How many cases resolved to at least one decision document. */
  readonly size: number;
};

/**
 * The official distributions, as `data.europa.eu` lists them.
 *
 * Antitrust and mergers only, which is the scope this was built for. State aid is published
 * the same way and deliberately left out: that file is 698MB against 2.9MB and 39MB here, so
 * it is a different engineering problem — a streaming parse and a disk index rather than a
 * map built in memory — and pulling it in would make every deployment pay for it.
 */
export const COMMISSION_CASE_DATASETS = [
  'https://compcases-open-data-portal-files-prod.s3.eu-west-1.amazonaws.com/case-data-AT.json',
  'https://compcases-open-data-portal-files-prod.s3.eu-west-1.amazonaws.com/case-data-M.json',
] as const;

/**
 * A field whose value may be a JSON document in a string.
 *
 * The datasets nest inconsistently: `attachmentCategory` arrives as
 * `["{\"code\":\"DocumentCategory0352\",\"label\":\"Prohibition Decision...\"}"]` — an array
 * holding an encoded object — while `attachmentLink` is a plain array of strings. Decoding
 * on the way past means the walk below does not have to know which is which.
 */
function decoded(value: unknown): unknown[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item !== 'string') return item;
    const trimmed = item.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return item;
    try {
      return JSON.parse(trimmed);
    } catch {
      return item;
    }
  });
}

/** The readable name of a coded value, which is what the dataset puts in `label`. */
function labelOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const label = record.label ?? record.code;
    if (typeof label === 'string') return label;
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  for (const item of decoded(value)) {
    const label = labelOf(item);
    if (label) return label;
  }
  return undefined;
}

/**
 * Attachments found wherever they sit, rather than at a path this code asserts.
 *
 * The two datasets are maintained separately and do not nest alike — the antitrust file puts
 * an attachment's fields under `decisions[].decisionAttachments[].metadata`, and nothing
 * promises the merger file agrees or that either keeps that shape. Walking for the field
 * names instead of indexing a path means a re-nesting upstream costs nothing here, and the
 * alternative fails silently: a path that stops matching yields an empty index, which looks
 * exactly like a case the Commission has not published a decision for.
 */
function attachmentsIn(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) attachmentsIn(item, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;

  const record = node as Record<string, unknown>;
  if (record.attachmentLink !== undefined) found.push(record);
  for (const value of Object.values(record)) {
    // A nested document arrives as an encoded string; decode before descending, or every
    // attachment inside one is invisible.
    for (const item of decoded(value)) {
      if (item && typeof item === 'object') attachmentsIn(item, found);
    }
  }
  return found;
}

/**
 * The Commission's own marker for a file published as part of a decision.
 *
 * This is what makes the older merger decisions reachable. 6,757 merger attachments — every
 * one a PDF, 6,744 of them under `mergers/cases/decisions/` — carry no category at all, so a
 * rule that required one dropped `M.8181` and `M.2027` and every merger decided before the
 * register began categorising. All 6,757 carry this marker instead, and their names state the
 * legal basis they were taken under (`Art. 6(1)(b)`, `Art. 8(2)`, `Art. 9(3) partial
 * referral`). Measured on 2026-09-15.
 */
const DECISION_METADATA_TYPE = 'METADATA_DECISION_ATTACHMENT';

/**
 * Whether a published document is a decision, rather than something else in the case file.
 *
 * The category is the Commission's own, and it is the difference between showing a lawyer
 * the decision they cited and showing them a press release or a party's own form. Measured
 * across the antitrust dataset: 256 `Prohibition Decision (Art. 7)`, 117 `Rejection of
 * Complaint Decision`, 104 `Commitments decision (Art. 9)`, 39 `Settlement Decision`, 16
 * `State Measure Art. 106(3) Decision`, 8 `Fines Decision (Art. 23)` — against 97 `Initiation
 * of proceedings Notice`, 53 `Commitments - Final`, 20 `Closure of proceedings` and 8 `Press
 * Release / Memo`. The merger dataset uses a vocabulary of its own, where the decisions are
 * `Decision - web publication` (4,262) and the exclusions are `Description of the
 * concentration` (3,836) and `Section 1.2 of Form CO` (2,752).
 *
 * The word "decision" separates both vocabularies exactly, so that is the test rather than a
 * list of codes that would go stale the first time a category is added. Where the dataset
 * gives no category at all, the marker above is what the Commission says instead — and it is
 * consulted only in that case, so a document the register has positively categorised as
 * something else can never be admitted by it.
 */
function describeDecision(attachment: Record<string, unknown>): string | undefined {
  const category = firstString(attachment.attachmentCategory);
  if (category) return /\bdecisions?\b/i.test(category) ? category : undefined;

  const metadataType = firstString(attachment.metadataType);
  if (metadataType !== DECISION_METADATA_TYPE) return undefined;
  // The name is what identifies these, and it is worth showing: "Art. 6(1)(b)" tells a
  // competition lawyer which kind of merger decision this is at a glance.
  const name = firstString(attachment.attachmentName);
  return name ? name.split(/\s+-\s+/)[0].trim() || name : 'Decision';
}

/** A provisional text is superseded by the final one wherever both were published. */
function isProvisional(description: string): boolean {
  return /\bprovisional\b/i.test(description);
}

/**
 * The order the decisions of one case are offered in.
 *
 * Every rule here is a preference and none is a reason to hide anything: a case whose only
 * published text is a provisional version in German is still worth more than a search box, so
 * the list holds everything and only its order changes. Final before provisional; then the
 * language the pane reads, English before French before whatever exists — the same order the
 * CELLAR chain prefers, for the same reason; then oldest first.
 *
 * Oldest first is deliberate, and it is the one choice here that could mislead if it were
 * made silently. Where a case was decided once and re-adopted later, the original is the text
 * a footnote citing it was written against — Intel's paragraph 1000 is in the decision of
 * 2009, not in its re-adoption of 2023 — so the original leads. But both are returned and
 * both carry their date, because the citation itself does not say which was meant and this
 * module is not entitled to decide that.
 */
function sortKey(decision: CommissionDecision, languages: readonly string[]): number[] {
  const language = (decision.language ?? '').toUpperCase();
  const preference = languages.indexOf(language);
  const date = Date.parse(decision.documentDate ?? '');
  return [
    isProvisional(decision.description) ? 1 : 0,
    preference < 0 ? languages.length : preference,
    Number.isNaN(date) ? Number.MAX_SAFE_INTEGER : date,
  ];
}

/**
 * The words of a case name worth comparing: accents dropped, case folded, and the words that
 * name no party — legal forms, joiners, `JV`, and the register's own `(Art. 21 procedure)`.
 */
const GENERIC_NAME_WORDS = new Set([
  'and', 'the', 'of', 'for', 'de', 'des', 'du', 'la', 'le', 'les', 'et', 'und', 'der', 'die', 'y', 'e',
  'jv', 'ag', 'sa', 'se', 'nv', 'bv', 'plc', 'inc', 'ltd', 'llc', 'spa', 'gmbh', 'co', 'corp', 'group',
  'holding', 'holdings', 'business', 'businesses', 'art', 'article', 'procedure', 'joint', 'venture',
]);

export function caseNameWords(name: string): string[] {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word) && !GENERIC_NAME_WORDS.has(word));
}

/** Whether a word of a citation's name is in a title, run-together spellings included. */
function inTitle(word: string, words: ReadonlySet<string>, joined: string): boolean {
  // `EssilorLuxottica` is one word in a footnote and two in some titles; the joined title is
  // only consulted for a word long enough not to turn up inside an unrelated one.
  return words.has(word) || (word.length >= 5 && joined.includes(word));
}

/**
 * Whether the name a citation gives a case and the register's title for it are the same case.
 *
 * Deliberately loose, because it only has to tell a wrong number from a right one: one word
 * in common is agreement. Drafters shorten (`BSCH/Champalimaud` for `ANTONIO DE SOMMER
 * CHAMPALIMAUD / BANCO SANTANDER CENTRAL HISPANOAMERICANO`) and misspell (`Boeing/Sprit`),
 * and both agree. A wrong number shares nothing: across the 204 case citations of the
 * Commission's 2026 draft merger guidelines, exactly the three carrying another case's number
 * have no word in common with that case's title, and every other one has at least one. A name
 * with no comparable word agrees with anything, since there is nothing in it to check.
 */
export function caseNamesAgree(name: string, title: string): boolean {
  const words = caseNameWords(name);
  if (!words.length) return true;
  const titleWords = caseNameWords(title);
  const set = new Set(titleWords);
  const joined = titleWords.join('');
  return words.some((word) => inTitle(word, set, joined));
}

/** How far apart two case numbers are, digit by digit — a transposition or a slip counts once or twice. */
function numberDistance(a: string, b: string): number {
  const x = a.replace(/\D/g, '');
  const y = b.replace(/\D/g, '');
  const rows = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return rows[x.length][y.length];
}

/** Where a record states its title: `metadata.caseTitle`, the metadata sometimes encoded. */
function caseTitleIn(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  for (const metadata of decoded((record as Record<string, unknown>).metadata)) {
    if (metadata && typeof metadata === 'object') {
      const title = firstString((metadata as Record<string, unknown>).caseTitle);
      if (title?.trim()) return title.trim();
    }
  }
  return undefined;
}

export type IndexOptions = {
  /** Language codes in order of preference, upper case. Defaults to English then French. */
  preferredLanguages?: readonly string[];
};

/**
 * Builds the case-number → decisions map from the raw dataset text.
 *
 * Separate from fetching so it can be tested against a fixture, and so a malformed download
 * fails here rather than half-way through a lookup. A dataset that cannot be parsed yields
 * nothing and the caller keeps the register link — the behaviour Ibid has today.
 */
export function buildCommissionCaseIndex(
  datasets: readonly string[],
  options: IndexOptions = {},
): CommissionCaseIndex {
  const languages = options.preferredLanguages ?? ['EN', 'FR'];
  const byCase = new Map<string, CommissionDecision[]>();
  const titles = new Map<string, { title: string; words: Set<string>; joined: string }>();

  for (const raw of datasets) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    for (const [caseNumber, record] of Object.entries(parsed as Record<string, unknown>)) {
      const key = caseNumber.trim().toUpperCase();
      const title = caseTitleIn(record);
      if (title) {
        const words = caseNameWords(title);
        titles.set(key, { title, words: new Set(words), joined: words.join('') });
      }
      for (const attachment of attachmentsIn(record)) {
        const url = firstString(attachment.attachmentLink);
        // Only a PDF, and only over https: the dataset is trusted for what it describes, not
        // for what it points at, and a link that is neither is not something to hand a
        // reviewer as an official source.
        if (!url || !/^https:\/\//i.test(url) || !/\.pdf$/i.test(url)) continue;

        const description = describeDecision(attachment);
        if (!description) continue;

        const held = byCase.get(key) ?? [];
        // One entry per document. A case's record lists the same file under more than one
        // decision often enough that without this the reviewer is offered the same PDF twice.
        if (held.some((decision) => decision.url === url)) continue;
        held.push({
          caseNumber,
          url,
          description,
          language: firstString(attachment.attachmentLanguage)?.toUpperCase(),
          documentDate: firstString(attachment.attachmentDocumentDate),
        });
        byCase.set(key, held);
      }
    }
  }

  for (const decisions of byCase.values()) {
    decisions.sort((a, b) => {
      const left = sortKey(a, languages);
      const right = sortKey(b, languages);
      for (let at = 0; at < left.length; at += 1) {
        if (left[at] !== right[at]) return left[at] - right[at];
      }
      return 0;
    });
  }

  /**
   * The suffixed numbers a case is sometimes filed under, grouped by the plain number.
   *
   * The register files a handful of mergers under a qualified number and does not list the
   * plain one at all: `M.8181` — Merck / Sigma-Aldrich, cited by paragraph in real footnotes —
   * exists only as `M.8181.AP`, sitting between an ordinary `M.8180` and `M.8182`. Measured
   * on 2026-09-15: 17 such keys in the merger dataset, every suffix `.AP`, and none in the
   * antitrust dataset. In all 17 the plain number is absent and exactly one suffixed sibling
   * exists, so resolving to it decides nothing — it is the only document the register holds
   * for that case. Where that is ever untrue the lookup yields nothing instead, because
   * choosing between two decisions naming different parties is exactly the guess this tool
   * refuses to make.
   */
  const groupQualified = (keys: Iterable<string>) => {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const qualified = /^(.+?\.\d+)\.[^.]+$/.exec(key);
      if (!qualified) continue;
      groups.set(qualified[1], [...(groups.get(qualified[1]) ?? []), key]);
    }
    return groups;
  };
  const siblings = groupQualified(byCase.keys());
  // Grouped over every titled case rather than the decided ones: `M.12052` exists only as
  // `M.12052.AP` — UNICREDIT / BANCO BPM (Art. 21(4)) — and has no decision to find, but a
  // citation of it still names a case, and checking that name needs its title.
  const titledSiblings = groupQualified(titles.keys());
  // `COMP/M.8713` is the same case as `M.8713`; the register drops the prefix and so does the
  // dataset.
  const keyOf = (caseNumber: string) => caseNumber.replace(/^COMP\//i, '').trim().toUpperCase();

  return {
    size: byCase.size,
    find(caseNumber) {
      // Matching is otherwise exact — a case number is an identifier, and there is no near-miss
      // worth resolving to a decision naming different parties. Where the number is wrong, the
      // name is what says so; see `identifyCommissionCase`.
      const wanted = keyOf(caseNumber);
      const exact = byCase.get(wanted);
      if (exact) return exact;

      const qualified = siblings.get(wanted);
      return qualified?.length === 1 ? byCase.get(qualified[0]) ?? [] : [];
    },
    title(caseNumber) {
      const wanted = keyOf(caseNumber);
      const exact = titles.get(wanted);
      if (exact) return exact.title;
      const qualified = titledSiblings.get(wanted);
      return qualified?.length === 1 ? titles.get(qualified[0])?.title : undefined;
    },
    caseNamed(name, citedNumber) {
      const words = caseNameWords(name);
      const family = /^([A-Z]+)\./.exec(keyOf(citedNumber))?.[1];
      if (!words.length || !family) return undefined;

      let best: Array<{ key: string; title: string; extra: number; distance: number }> = [];
      for (const [key, entry] of titles) {
        if (!key.startsWith(`${family}.`)) continue;
        if (!words.every((word) => inTitle(word, entry.words, entry.joined))) continue;
        const extra = [...entry.words].filter((word) => !words.some((named) => named === word || named.includes(word))).length;
        const candidate = { key, title: entry.title, extra, distance: numberDistance(citedNumber, key) };
        const lead = best[0];
        if (!lead || extra < lead.extra || (extra === lead.extra && candidate.distance < lead.distance)) best = [candidate];
        else if (extra === lead.extra && candidate.distance === lead.distance) best.push(candidate);
      }
      if (best.length !== 1) return undefined;
      // The register's own spelling of the number, less a qualifier a citation never carries.
      return { caseNumber: best[0].key.replace(/^(.+?\.\d+)\.[^.]+$/, '$1'), title: best[0].title };
    },
  };
}

export type CaseIndexLoaderOptions = IndexOptions & {
  fetcher?: typeof fetch;
  /** Identifies this client, the same courtesy the CELLAR requests are given. */
  userAgent?: string;
  /** Which distributions to read. Defaults to the antitrust and merger datasets. */
  datasets?: readonly string[];
  /**
   * How long an index stands before it is rebuilt. The Commission republishes these files
   * on its own schedule — the antitrust dataset was rewritten the morning of 2026-09-15 and
   * the merger one a week earlier — so a day is frequent enough to pick up a newly published
   * decision and rare enough that a long-running server downloads 42MB about once a day.
   */
  refreshMs?: number;
  now?: () => number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type CommissionCaseIndexLoader = {
  /** The index, built on first use and rebuilt when it is old. Never rejects. */
  get(): Promise<CommissionCaseIndex>;
};

const EMPTY_INDEX: CommissionCaseIndex = { size: 0, find: () => [], title: () => undefined, caseNamed: () => undefined };

/**
 * Keeps the index fresh without ever letting it fail a lookup.
 *
 * Two properties matter more than speed here. The first is that nothing this does can turn
 * into an error the reviewer sees: a dataset that will not download, or downloads as
 * something other than JSON, leaves the previous index standing — or an empty one on the
 * first attempt — and an empty index means every Commission citation gets the register link
 * it gets today. Retrieval of a decision is an improvement layered on top of that floor, and
 * it must never take the floor away with it.
 *
 * The second is that the download happens once rather than once per waiting lookup. Opening a
 * competition memo can put twenty Commission citations in flight at the same moment, and
 * without this each would fetch 42MB of its own.
 */
export function createCommissionCaseIndexLoader(options: CaseIndexLoaderOptions = {}): CommissionCaseIndexLoader {
  const fetcher = options.fetcher ?? fetch;
  const datasets = options.datasets ?? COMMISSION_CASE_DATASETS;
  const refreshMs = options.refreshMs ?? DAY_MS;
  const now = options.now ?? Date.now;

  let index: CommissionCaseIndex = EMPTY_INDEX;
  let builtAt = -Infinity;
  let building: Promise<void> | undefined;

  async function download(url: string): Promise<string | undefined> {
    try {
      const response = await fetcher(url, {
        headers: options.userAgent ? { 'User-Agent': options.userAgent } : {},
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    }
  }

  async function rebuild(): Promise<void> {
    // Sequential, like every other outbound request this server makes: two large files
    // fetched together is a burst, and nothing here is waiting on the second one.
    const texts: string[] = [];
    for (const url of datasets) {
      const text = await download(url);
      if (text) texts.push(text);
    }
    // Nothing downloaded at all leaves whatever is already held, which on the first attempt
    // is the empty index. A partial download is still worth indexing: one dataset failing is
    // no reason to stop resolving the cases the other one names.
    if (!texts.length) return;
    const rebuilt = buildCommissionCaseIndex(texts, { preferredLanguages: options.preferredLanguages });
    if (rebuilt.size) {
      index = rebuilt;
      builtAt = now();
    }
  }

  return {
    async get() {
      if (index.size && now() - builtAt < refreshMs) return index;
      building ??= rebuild().finally(() => { building = undefined; });
      await building;
      return index;
    },
  };
}

/** What a Commission citation is taken to cite, once its number has been checked against its name. */
export type CommissionCaseIdentity = {
  /** The case to show: the one cited, or the one its name identifies where the number is not it. */
  caseNumber?: string;
  /** The register's title for `caseNumber`. */
  title?: string;
  /**
   * Set where the number cited is not the case the citation names. `caseNumber` is then the
   * case the name identifies, or absent where no single case is it.
   */
  numberMismatch?: { cited: string; citedTitle?: string; name: string };
};

/**
 * Which case a citation means, when its number and its name disagree.
 *
 * The name wins. A number is five digits typed by hand and a name is the case the drafter had
 * in mind: every wrong number in the Commission's own 2026 draft merger guidelines sits beside
 * the right name — `M.7967 – Ball/Rexam` is M.7567, `M.11506 – Parker/Meggitt` is M.10506,
 * `M.9596 – EssilorLuxottica/GrandVision` is M.9569, and `M.9376 – Siemens/Alstom` and
 * `M.9706 – Novelis/Aleris` cite numbers the register has never used, for M.8677 and M.9076.
 * Following the number put Apax Partners' decision on screen under a citation to Ball/Rexam.
 *
 * So the case shown is the one named, and the mismatch is always carried with it for the
 * reviewer to see: this changes what a citation says, and nobody should learn that from a
 * title they happened to read closely. Where no single case carries the name, nothing is
 * shown as the source at all, because the number is known to be wrong and there is nothing
 * better to show.
 *
 * Checked only where there is something to check against: a citation that gives no name, or a
 * number the index has decisions for but no title, is taken as cited.
 */
export function identifyCommissionCase(index: CommissionCaseIndex, cited: string, name: string | undefined): CommissionCaseIdentity {
  const citedTitle = index.title(cited);
  if (!name) return { caseNumber: cited, title: citedTitle };
  if (citedTitle ? caseNamesAgree(name, citedTitle) : index.find(cited).length > 0) return { caseNumber: cited, title: citedTitle };

  const named = index.caseNamed(name, cited);
  if (!named && !citedTitle) return { caseNumber: cited };
  return {
    ...(named ? { caseNumber: named.caseNumber, title: named.title } : {}),
    numberMismatch: { cited, ...(citedTitle ? { citedTitle } : {}), name },
  };
}

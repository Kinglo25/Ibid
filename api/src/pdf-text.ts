/**
 * Reading a Commission decision, which is published as a PDF and nowhere else.
 *
 * Everything else Ibid retrieves is HTML from CELLAR, and a paragraph is found by its markup.
 * A competition decision has no such rendition: `AT.37990` is a PDF on the Commission's own
 * site and CELLAR holds only a summary, an advisory opinion and a hearing officer's report.
 * So to answer "Case M.8124 — Microsoft/LinkedIn, paragraph 350" with the paragraph rather
 * than a link, the text has to come out of the PDF.
 *
 * **Why a dependency, when `api/` had none.** A dependency-free extractor was written first,
 * using only `node:zlib` to inflate the content streams, and measured against `pdftotext` on
 * four real decisions. It recovers 85–95% of the characters and loses the thing that matters:
 * without the text-positioning matrices there are no real line starts, so the recital anchors
 * stop being anchors. On one decision it found 12 recital markers where there are 1,244, and
 * on another the `(223)` it did find was `(223))` inside a cross-reference — a wrong passage
 * shown under the reviewer's citation, which is the one outcome this project holds at zero.
 * `pdfjs-dist` gives each text item its transform, so lines can be rebuilt from the baseline
 * coordinate, and it then agrees with `pdftotext` exactly: 451 recital markers against 451 on
 * Microsoft/LinkedIn, 1,857 against 1,857 on Intel.
 *
 * It is one package, Apache-2.0, with no transitive dependencies of its own. Its only
 * declared dependency is the optional `@napi-rs/canvas`, which exists for rendering pages to
 * an image and is never reached by text extraction — installing with `--omit=optional` leaves
 * it out, and extraction is byte-identical without it.
 */

/**
 * The text of a PDF, and whether there was any to read.
 *
 * `lines` rather than a blob because the whole anchoring problem is about line starts: a
 * recital is `(350)` at the beginning of a line, while `350` in the middle of one is a
 * cross-reference and `350` at the start of a footnote block is a footnote. Microsoft/LinkedIn
 * carries both — paragraph (350) and footnote 350 — so the distinction is not theoretical.
 */
export type PdfText = {
  text: string;
  pages: number;
  /**
   * False where the PDF carries no text at all, which means it is a scan.
   *
   * Two of nine decisions sampled across 1977–2020 are images: a 1.99MB file yielding zero
   * characters, and a 2.75MB one the same. There is nothing to extract and nothing to be
   * done about it here, but it must be said rather than shown as an empty passage — the
   * reviewer needs to know the decision exists and that this tool cannot read it.
   */
  readable: boolean;
};

/**
 * `pdfjs-dist` is loaded the first time a PDF is actually read, and never otherwise.
 *
 * It is 35MB of JavaScript. A deployment that resolves only CJEU case law and legislation —
 * which is every deployment with `IBID_COMMISSION_CASE_DATA` off — should not pay to parse it
 * at startup, and a lazy import means it does not.
 */
let pdfjs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

/**
 * What pdfjs says as it loads in Node without `@napi-rs/canvas`.
 *
 * On import it looks for the canvas package and for the `DOMMatrix` and `Path2D` globals that
 * package would supply, and prints a warning for each that is missing. All three are about
 * rendering a page to an image, which text extraction never does — see above. They are
 * printed while the module evaluates, before any `getDocument` call, so `verbosity: 0` in
 * `extractPdfText` cannot reach them.
 *
 * Only these three are held back. Anything else written to `console.warn` while the import is
 * in flight, by pdfjs or by the rest of the server, still reaches the console.
 */
const CANVAS_ABSENT = [
  /^Warning: Cannot load "@napi-rs\/canvas" package: /,
  /^Warning: Cannot polyfill `(DOMMatrix|Path2D)`, rendering may be broken\.$/,
];

function loadPdfjs() {
  pdfjs ??= (async () => {
    const warn = console.warn;
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      if (typeof message === 'string' && CANVAS_ABSENT.some((pattern) => pattern.test(message))) return;
      warn.call(console, message, ...rest);
    };
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.warn = warn;
    }
  })();
  return pdfjs;
}

/** Below this a "text layer" is page furniture — a scanned document's header stamp, say. */
const READABLE_FLOOR = 200;

/**
 * The document's own text, with the apparatus printed around it left out.
 *
 * A decision's page carries three things, and only one of them is what a citation to a
 * recital means. Measured on Microsoft/LinkedIn: 3,447 lines set at 12pt — the recitals —
 * against 773 at 10pt, which is the footnote text at the foot of each page, and 850 at 8pt,
 * which is the footnote reference markers and the page numbers. Headings are the 6 lines at
 * 18pt.
 *
 * The commonest size is taken to be the body's, and that is the assumption the whole rule
 * rests on. It holds because a decision is mostly its own text: 14,426 lines against 3,951 of
 * footnote in Intel, 3,447 against 773 in Microsoft/LinkedIn, and the same ordering in every
 * one of the eleven decisions sampled. A document whose apparatus outweighed its text would
 * filter nothing useful rather than filter the wrong thing — the mode would simply be the
 * footnote size, and every line at or above it would be kept.
 *
 * Keeping the lines set at or above the commonest size keeps the recitals and the headings
 * and drops the rest, and without it the passage is wrong in a way that reads as right:
 * recital (350) is two lines long before the page's footnote block begins, so a slice running
 * from `(350)` to `(351)` collected footnote 326 — a paragraph about Facebook/WhatsApp — and
 * presented it to the reviewer as part of the recital they cited.
 *
 * It also removes the footnote trap at its source. Microsoft/LinkedIn numbers a footnote 350
 * as well as a recital, and a footnote number is set at 8pt: the line never reaches the
 * anchor matcher at all now, rather than being refused by it.
 *
 * The same signal the pane uses on a converted decision's Word paragraphs — see `notesInBody`
 * in `addin/src/ui/App.tsx`, which tells a note from prose by the size it is set in. A
 * document that sets its footnotes in the body size is left as it is: nothing is filtered,
 * which is the behaviour before this and no worse than it.
 *
 * It also turns out to be more accurate than the tool this was checked against. Filtering
 * takes Intel from 1,857 recital anchors to 1,855, and the two it drops are not recitals:
 * `(495)-(497), that is to say only concerns [...]` and `(239) ("Get [Dell Senior
 * executive]/OOC clearly understand our meet-comp process` — both footnote lines that happen
 * to open with a parenthesised number, cross-referring to recitals from inside a footnote.
 * `pdftotext` counts both as anchors too, so a citation to Intel paragraph 495 would have
 * anchored on a footnote's cross-reference and shown the reviewer the wrong passage. Set
 * against the body size, those lines never reach the matcher.
 */
export function bodyTextOf(lines: ReadonlyArray<{ text: string; size: number }>): string {
  if (!lines.length) return '';
  const counts = new Map<number, number>();
  for (const line of lines) counts.set(line.size, (counts.get(line.size) ?? 0) + 1);
  const body = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return lines.filter((line) => line.size >= body && !PAGE_MARK.test(line.text)).map((line) => line.text).join('\n');
}

/**
 * The Official Journal page mark, `EN 101 EN`: the language, the page number, the language.
 * Older decisions set it in the body size, so size alone does not drop it, and a recital that
 * crossed the page was shown with the mark in the middle of its sentence.
 */
const PAGE_MARK = /^([A-Z]{2}) \d{1,4} \1$/;

/**
 * Rebuilds the document's lines from the position of every piece of text on the page.
 *
 * Items arrive in the order the PDF draws them, which is not reading order and not lines.
 * Grouping by the baseline `y` of each item's transform and then sorting within the group by
 * `x` is what recovers the line — and recovering the line is the whole reason this file
 * exists, because every anchor below is a line-start anchor.
 *
 * `verbosity: 0` keeps pdfjs's own warnings off the console: `api/server.mjs` logs its
 * startup and nothing else, and `docs/DATA-FLOW.md` tells a reviewer so. It covers what pdfjs
 * says while parsing; what it says on import is `CANVAS_ABSENT`'s business. A missing optional
 * font file is not worth contradicting that over — and it changes nothing, measured: with the
 * standard font data supplied and without it, Microsoft/LinkedIn extracts to the same 306,896
 * characters and the same 451 recital markers.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const { getDocument } = await loadPdfjs();
  const loading = getDocument({
    data: bytes,
    // The bytes in hand are the whole input. `useWorkerFetch: false` is the part that matters
    // to a reviewer: pdfjs will otherwise fetch character maps and font data over the network
    // while parsing, and this server's outbound traffic is enumerated in `docs/DATA-FLOW.md`.
    useWorkerFetch: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await loading.promise;

  try {
    const measured: Array<{ text: string; size: number }> = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();

      const rows = new Map<number, Array<{ x: number; str: string; size: number }>>();
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string') continue;
        const y = Math.round(item.transform[5]);
        // The vertical scale of the text matrix is the size it is set in, which is what
        // separates a recital from the footnote printed under it. See `bodyTextOf`.
        const piece = { x: item.transform[4], str: item.str, size: Math.round(Math.abs(item.transform[3])) };
        const row = rows.get(y);
        if (row) row.push(piece);
        else rows.set(y, [piece]);
      }

      // Down the page: PDF y grows upwards, so the largest baseline is the topmost line.
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const row = rows.get(y);
        if (!row) continue;
        const line = row.sort((a, b) => a.x - b.x).map((item) => item.str).join('')
          .replace(/\s+/g, ' ').trim();
        if (line) measured.push({ text: line, size: Math.max(...row.map((item) => item.size)) });
      }
      page.cleanup();
    }

    const text = bodyTextOf(measured);
    return { text, pages: document.numPages, readable: text.length >= READABLE_FLOOR };
  } finally {
    // Destroying the loading task is what shuts the worker down — the document proxy has no
    // `destroy` of its own. The worker holds native-sized buffers for a 500-page decision, so
    // releasing them matters more here than anywhere else in this server, which is otherwise
    // all strings.
    await loading.destroy();
  }
}

/**
 * A recital's number, at the start of its own line.
 *
 * Parenthesised and anchored, and both halves are load-bearing. Commission decisions number
 * their recitals `(350)`, and the same document's footnotes are numbered `350` bare at the
 * start of a line in the footnote block: Microsoft/LinkedIn has paragraph `(350)` on one line
 * and `350 Cisco's submission of 4 November 2016;` on another. Matching a bare number would
 * put a footnote on screen under a citation to a paragraph. Measured across eleven real
 * decisions, the bare-number shape appears 2,301 times in Intel alone and is never the
 * recital; the parenthesised shape appears exactly as often as there are recitals.
 */
const RECITAL_ANCHOR = /^[ \t]*\((\d{1,4})\)/gm;

export type RecitalRun = { from: number; to: number };

/**
 * A passage no longer than `maxLength`, cut where a reader would expect a cut — at a line, else
 * a sentence, else a word — and marked `[…]` so that what is shown is never mistaken for all
 * of it. A passage cut silently reads as complete, and the words dropped from the end of a
 * paragraph are as often as not the ones that qualify it ("…, unless the contrary is shown").
 */
export function boundedPassage(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  const window = text.slice(0, maxLength);
  const floor = Math.floor(maxLength * 0.6);
  const cut = [window.lastIndexOf('\n'), window.search(/[.;:](?=\s[^.;:]*$)/), window.lastIndexOf(' ')]
    .find((at) => at > floor) ?? maxLength;
  return { text: `${window.slice(0, cut + (window[cut] === '.' || window[cut] === ';' || window[cut] === ':' ? 1 : 0)).trimEnd()} […]`, truncated: true };
}

/**
 * Where a Commission decision's recitals end: the formula that opens its operative part. A
 * decision's last recital has no recital after it to stop at, so without this the passage
 * ran on into Article 1 of the decision and was shown as the recital cited.
 */
export const END_OF_RECITALS = /\b(?:HA(?:S|VE) ADOPTED TH(?:IS|E PRESENT) DECISION|A ADOPT[ÉE] LA PR[ÉE]SENTE D[ÉE]CISION)\b/i;

/**
 * The text of the recitals a citation actually named, and the ones it named that are not there.
 *
 * A run is sliced from its first recital to the first anchor numbered past its last, rather
 * than to a specific closing number, so a citation whose final recital is missing or
 * renumbered still stops in the right place instead of running to the cap. Runs are joined
 * the way the HTML path joins them, so a disjoint citation reads as two passages with the gap
 * marked rather than as the span between them.
 *
 * `excerpt` is absent when the first recital of every run is absent — which is the honest
 * answer for a decision that numbers nothing (one of the eleven sampled has 7,564 characters
 * of text and no numbered recitals at all) and for a pinpoint that is simply not there.
 * `unlocated` is every run whose first recital is not there, so that a footnote citing three
 * passages and finding two is shown as two of three rather than as the whole of it.
 */
export function locateRecitals(
  text: string,
  runs: readonly RecitalRun[],
  options: { maxLength?: number } = {},
): { excerpt?: string; unlocated: RecitalRun[] } {
  const maxLength = options.maxLength ?? 20_000;
  const anchors = anchorsOf(text);

  const passages: string[] = [];
  const unlocated: RecitalRun[] = [];
  for (const run of runs) {
    const start = anchors.find((anchor) => anchor.number === run.from);
    if (!start) {
      unlocated.push(run);
      continue;
    }
    // The first anchor that begins after this one and is numbered beyond the run. Position is
    // checked as well as number because a decision's numbering is not globally ascending —
    // annexes restart it — and an earlier `(1)` must not be mistaken for this run's end.
    const end = anchors.find((anchor) => anchor.index > start.index && anchor.number > run.to);
    const passage = text.slice(start.index, end ? end.index : undefined);
    const closing = END_OF_RECITALS.exec(passage.slice(1));
    passages.push(withoutTrailingHeadings((closing ? passage.slice(0, closing.index + 1) : passage).trim()));
  }
  return passages.length
    ? { excerpt: boundedPassage(passages.join('\n\n…\n\n'), maxLength).text, unlocated }
    : { unlocated };
}

/**
 * A point's number the way older decisions set it, `70. In the pharmaceuticals industry`.
 * Glaxo Wellcome/SmithKline Beecham (M.1846, 2000) numbers its 200-odd points so and has no
 * `(70)` anywhere; before this the pane showed its opening under a citation to points 70-72.
 */
const POINT_ANCHOR = /^[ \t]*(\d{1,4})\.[ \t]+(?=\S)/gm;

/**
 * The anchors a decision numbers its recitals by: `(70)`, or the older `70.`.
 *
 * Counting them does not decide it. Ryanair/Aer Lingus (M.4439, 2007) numbers 1,240 points
 * `39.` and has `(1)`, `(2)` lists inside them; Bayer/Monsanto's decision amending the
 * commitments (M.8084, 2018) numbers 25 recitals `(1)` and annexes 140 clauses numbered `1.`,
 * and counting read the annex as the decision. What decides it is where the numberings lie:
 * over the stretch where `(1)`, `(2)` … run in sequence, Ryanair has 296 points and 14 list
 * items, Bayer/Monsanto one heading and 25 recitals. The older numbering is taken where it
 * outnumbers the `(n)` sequence on the `(n)` sequence's own ground, or where every point comes
 * before the `(n)` sequence — a list inside the last point — or where there is no `(n)`
 * sequence at all and the points begin in the first quarter of the text, as a decision's do
 * and an annex's do not.
 */
function anchorsOf(text: string): Array<{ number: number; index: number }> {
  const anchors: Array<{ number: number; index: number }> = [];
  for (const match of text.matchAll(RECITAL_ANCHOR)) {
    anchors.push({ number: Number(match[1]), index: match.index });
  }
  const points = pointsInSequence(text);
  if (!points.length) return anchors;
  const listed = inSequence(anchors);
  if (!listed.length) return points[0].index <= text.length / 4 ? points : anchors;
  const from = listed[0].index;
  const to = listed[listed.length - 1].index;
  const within = points.filter((point) => point.index > from && point.index < to).length;
  if (within > listed.length) return points;
  // A `(n)` list after every point is a list inside the last one. Anywhere else, the `(n)`
  // numbering stands: at worst the passage is reported not found, where reading the other
  // way could show a clause of an annex as the recital cited.
  return points[points.length - 1].index < from && points.length > listed.length ? points : anchors;
}

/**
 * How far a decision's numbering runs in sequence, 1, 2, 3 … — the shape of the decision
 * rather than its words, which is what its language versions share. The English, French and
 * German texts of Lufthansa/Austrian Airlines (M.5440) all run 1 to 406.
 */
export function numberingLength(text: string): number {
  let last = 0;
  for (const anchor of anchorsOf(text)) if (anchor.number === last + 1) last = anchor.number;
  return last;
}

/**
 * The older numbering's anchors, only as they run in sequence: 1, 2, 3 … Unlike `(70)`, the
 * shape `70.` is also a heading's (`1. Pharmaceutic specialities`, set between points 10 and
 * 11) and the start of a wrapped line (`2000. The pipeline`), and the sequence is what tells
 * them apart: a number is a point only as the one after the last point. A heading numbered
 * the same as the point that follows it — `2.` then `2.` — gives way to that point, so the
 * passage opens at the point and not at the heading above it.
 */
function pointsInSequence(text: string): Array<{ number: number; index: number }> {
  const points: Array<{ number: number; index: number }> = [];
  for (const match of text.matchAll(POINT_ANCHOR)) {
    // A table of contents' entry, by its dot leaders: `1. Introduction ........ 3`.
    const line = text.slice(match.index, text.indexOf('\n', match.index) >>> 0 || undefined);
    if (/\.{4,}|…{2,}/.test(line)) continue;
    points.push({ number: Number(match[1]), index: match.index });
  }
  return inSequence(points);
}

/**
 * Anchors as they run in sequence, 1, 2, 3 …: a number is taken only as the one after the
 * last taken, and one repeating the last taken replaces it, so a heading numbered like the
 * point after it gives way to that point.
 */
function inSequence(anchors: ReadonlyArray<{ number: number; index: number }>): Array<{ number: number; index: number }> {
  const run: Array<{ number: number; index: number }> = [];
  for (const anchor of anchors) {
    const last = run[run.length - 1];
    if (anchor.number === (last ? last.number + 1 : 1)) run.push(anchor);
    else if (last && anchor.number === last.number) run[run.length - 1] = anchor;
  }
  return run;
}

/**
 * A numbered heading's line: `4.2.4.5. Military fixed-wing trainers`, `(A.ii) EEA-specific
 * barriers`, `v) Conclusion` — or a bare number, the footnote marker Novelis/Aleris (M.9076)
 * sets in the body size and recital (503) was shown ending with. Lower-case lettered points — `(a)`, `(b)` — are a recital's own
 * list and never match, and a line that ends as a sentence does is not taken for a heading.
 */
const HEADING_LINE = /^\d{1,4}$|^(?:\d+(?:\.\d+)*\.?|\([A-Z](?:\.[ivxlc]+)?\)|\([ivxlc]+\)|[ivxlc]+\)|[a-z](?:\.\d+)*\)|[A-Z]\.)[ \t]+\S[^\n]{0,150}$/;

/**
 * A recital's passage without the heading of the section after it. The slice runs up to the
 * next recital's number, and where a section begins in between, its heading was shown as the
 * last line of the recital cited — measured live on Siemens/Alstom, Parker/Meggitt,
 * EssilorLuxottica/GrandVision and Outokumpu/Inoxum. Only lines after the recital's last
 * complete sentence go, so a line that merely wraps — `2019 levels` — stays the recital's.
 */
function withoutTrailingHeadings(passage: string): string {
  const lines = passage.split('\n');
  // The trailing lines that could be headings: short, and not ending as a sentence or a
  // list item does. A numbered heading's title can wrap onto an unnumbered line —
  // `7. VERTICAL RELATIONSHIPS` then `Analytical framework` — so the cut is at the first
  // numbered line among them, never at an unnumbered one alone.
  let start = lines.length;
  while (start > 1 && lines.length - start < 4 && lines[start - 1].length <= 150 && !/(?:[.;:,]|\b(?:and|or|et|ou))$/.test(lines[start - 1])) start -= 1;
  let cut = start;
  while (cut < lines.length && !HEADING_LINE.test(lines[cut])) cut += 1;
  // What stays must end as a sentence does. A list's last item ending unpunctuated is the
  // recital's, and the line before it ends `; and`, which is not a sentence's end.
  if (cut === lines.length || cut === 0 || !/[.!?]["”’)\]]?$/.test(lines[cut - 1])) return passage;
  return lines.slice(0, cut).join('\n');
}

/**
 * Whether a decision is about an earlier decision in the same case: its first recital opens
 * "By Decision 98/526/EC of 4 February 1998 in Case No IV/M.950…", "By decision of 21.3.2018
 * (the "Decision")…", or the same in French or German. A waiver of commitments, an approval
 * of a purchaser, a re-adoption. Its recitals are numbered like the decision it is about, so
 * a pinpoint meant for the one is found in the other. Measured on the 50 distinct decisions
 * read so far: 14 open so, every one of them a decision about an earlier one — commitments
 * modified, a purchaser approved, commitments waived — and the first recital of none of the
 * other 36 refers to an earlier decision.
 */
export function refersToEarlierDecision(text: string): boolean {
  const first = sliceRecitals(text, [{ from: 1, to: 1 }]);
  if (!first) return false;
  return /^\(?1[).][ \t]*(?:(?:By|In)\s+(?:(?:its|a|the|Commission)\s+)*[Dd]ecision\b|Par\s+(?:(?:sa|la)\s+)?d[ée]cision\b|Mit\s+(?:der|seiner)\s+Entscheidung\b)/.test(first);
}

/** `locateRecitals`, for a caller that needs only the text. */
export function sliceRecitals(
  text: string,
  runs: readonly RecitalRun[],
  options: { maxLength?: number } = {},
): string | undefined {
  return locateRecitals(text, runs, options).excerpt;
}

export type SectionRun = { from: string; to?: string };

/** `9.1.3.3.7` as its components, for ordering one section against another. */
const components = (section: string) => section.split('.').map(Number);

/** Whether `a` comes after `b` in a decision's numbering: `9.1.4` after `9.1.3.3.7`. */
function after(a: number[], b: number[]): boolean {
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) return a[at] > b[at];
  }
  return false;
}

/** Whether `a` is `b` or one of its subsections: `9.1.3.3.7.2` is within `9.1.3.3.7`. */
function within(a: number[], b: number[]): boolean {
  return a.length >= b.length && b.every((part, at) => a[at] === part);
}

/**
 * A line opening with a section number, and what follows it. `(299)` is a recital and never
 * matches; a table of contents' entry does, and is told apart by its dot leaders below.
 */
const SECTION_HEADING = /^[ \t]*(\d+(?:\.\d+)*)\.?[ \t]+(?=[\p{Lu}‘“"'[(])/gmu;

/**
 * The text of the numbered sections a citation named, and the ones it named that are not there.
 *
 * A section runs from its heading to the next heading that is neither inside it nor before it
 * in the numbering. Both conditions are needed. "Inside" keeps `9.1.3.3.7.1` within
 * `9.1.3.3.7`. "Before" keeps a wrapped line that happens to open with a number — `1.5
 * million tonnes`, `2019 The` — from ending the section, since no real heading after
 * `9.1.3.3.7` is numbered below it. Measured on Norsk Hydro/Alumetal (M.10658), section
 * 9.1.3.3.7 is recitals (299) to (321) and ends at 9.1.3.3.8.
 *
 * The table of contents repeats every heading first, with dot leaders on the entry's line or,
 * where a long title wraps, on the line after. Those are skipped, so a section is found where
 * the decision sets it out and not where it lists it.
 */
export function locateSections(
  text: string,
  runs: readonly SectionRun[],
  options: { maxLength?: number } = {},
): { excerpt?: string; unlocated: string[] } {
  const maxLength = options.maxLength ?? 20_000;
  const headings: Array<{ number: string; parts: number[]; index: number }> = [];
  for (const match of text.matchAll(SECTION_HEADING)) {
    const lineEnd = text.indexOf('\n', match.index);
    const nextEnd = lineEnd < 0 ? -1 : text.indexOf('\n', lineEnd + 1);
    const entry = text.slice(match.index, nextEnd < 0 ? undefined : nextEnd);
    if (/\.{4,}|…{2,}/.test(entry)) continue;
    headings.push({ number: match[1], parts: components(match[1]), index: match.index });
  }

  const passages: string[] = [];
  const unlocated: string[] = [];
  for (const run of runs) {
    const label = run.to ? `${run.from}–${run.to}` : run.from;
    const start = headings.find((heading) => heading.number === run.from);
    if (!start) {
      unlocated.push(label);
      continue;
    }
    const last = run.to ? headings.find((heading) => heading.index > start.index && heading.number === run.to) : start;
    if (!last) unlocated.push(run.to as string);
    const through = last ?? start;
    const end = headings.find((heading) => heading.index > through.index
      && !within(heading.parts, through.parts) && after(heading.parts, through.parts));
    passages.push(text.slice(start.index, end ? end.index : undefined).trim());
  }
  if (!passages.length) return { unlocated };
  const joined = passages.join('\n\n…\n\n');
  // A section can run to tens of thousands of characters. Cut where a line ends and say so,
  // rather than stopping mid-word as though that were where the section stops.
  const excerpt = joined.length > maxLength
    ? `${joined.slice(0, joined.lastIndexOf('\n', maxLength) > 0 ? joined.lastIndexOf('\n', maxLength) : maxLength).trimEnd()}\n[…]`
    : joined;
  return { excerpt, unlocated };
}

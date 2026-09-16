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
  return lines.filter((line) => line.size >= body).map((line) => line.text).join('\n');
}

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
 * The text of the recitals a citation actually named.
 *
 * A run is sliced from its first recital to the first anchor numbered past its last, rather
 * than to a specific closing number, so a citation whose final recital is missing or
 * renumbered still stops in the right place instead of running to the cap. Runs are joined
 * the way the HTML path joins them, so a disjoint citation reads as two passages with the gap
 * marked rather than as the span between them.
 *
 * Returns `undefined` when the first recital of every run is absent — which is the honest
 * answer for a decision that numbers nothing (one of the eleven sampled has 7,564 characters
 * of text and no numbered recitals at all) and for a pinpoint that is simply not there.
 */
export function sliceRecitals(
  text: string,
  runs: readonly RecitalRun[],
  options: { maxLength?: number } = {},
): string | undefined {
  const maxLength = options.maxLength ?? 20_000;
  const anchors: Array<{ number: number; index: number }> = [];
  for (const match of text.matchAll(RECITAL_ANCHOR)) {
    anchors.push({ number: Number(match[1]), index: match.index });
  }
  if (!anchors.length) return undefined;

  const passages: string[] = [];
  for (const run of runs) {
    const start = anchors.find((anchor) => anchor.number === run.from);
    if (!start) continue;
    // The first anchor that begins after this one and is numbered beyond the run. Position is
    // checked as well as number because a decision's numbering is not globally ascending —
    // annexes restart it — and an earlier `(1)` must not be mistaken for this run's end.
    const end = anchors.find((anchor) => anchor.index > start.index && anchor.number > run.to);
    passages.push(text.slice(start.index, end ? end.index : undefined).trim());
  }
  if (!passages.length) return undefined;
  return passages.join('\n\n…\n\n').slice(0, maxLength);
}
